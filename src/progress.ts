// Progreso en vivo para XMPP: una burbuja de estado por turno que se envía al
// arrancar la primera herramienta y se va EDITANDO (XEP-0308) conforme avanza
// el trabajo, igual que el draft de progreso de Telegram. La composición de
// líneas (dedupe, límite de líneas, "final reply gana") la hace el compositor
// genérico del SDK; aquí sólo va el transporte XMPP: primer update = mensaje
// nuevo, siguientes = corrección del mismo id, con un throttle para no
// inundar Prosody de correcciones.
//
// Se activa por config: channels.xmpp.streaming.mode = "progress" (por cuenta
// o global). Sin eso, el controlador queda inerte y el flujo actual no cambia.
import {
  buildChannelProgressDraftLine,
  buildChannelProgressDraftLineForEntry,
  createChannelProgressDraftCompositor,
  resolveChannelPreviewStreamMode,
} from "openclaw/plugin-sdk/channel-outbound";
import type { ResolvedXmppAccount } from "./accounts.js";
import { markdownToPlain, XMPP_MAX_BODY } from "./protocol.js";
import { sendEditXmpp, sendMessageXmpp } from "./send.js";
import type { CoreConfig } from "./types.js";

// Una corrección XEP-0308 cada ~2.5s es visible como "en vivo" en cualquier
// cliente sin acercarse a los límites de rate de Prosody.
const MIN_EDIT_INTERVAL_MS = 2500;

export type XmppProgressController = ReturnType<typeof createXmppProgressController>;

export function createXmppProgressController(params: {
  cfg: CoreConfig;
  account: ResolvedXmppAccount;
  target: string;
  log?: (line: string) => void;
}) {
  const entry = params.account.config;
  // Default "partial", igual que Telegram (resolveTelegramStreamMode): la
  // burbuja transmite el TEXTO de la respuesta en vivo además de las líneas
  // de tools, y al final se convierte en la respuesta (previewFinalization).
  // streaming.mode = "progress" deja sólo líneas de tools; "off" desactiva.
  const mode = resolveChannelPreviewStreamMode(entry, "partial");
  const active = mode !== "off";
  const partialEnabled = mode === "partial";
  const sendOpts = { cfg: params.cfg, accountId: params.account.accountId };

  // UNA burbuja por turno: se crea con la primera herramienta y de ahí en
  // adelante SIEMPRE se edita la misma, aunque el modelo intercale narración
  // entre tools. (La primera versión colapsaba y abría burbuja nueva en cada
  // respuesta intermedia → un modelo que narra entre cada tool generaba una
  // catarata de mensajes, exactamente lo que este feature quería evitar.)
  let progressMessageId: string | null = null;
  let lastSentText = "";
  let pendingText: string | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt = 0;
  let sendChain: Promise<void> = Promise.resolve();
  let toolsInTurn = 0;
  // La burbuja compone dos fuentes: las líneas de progreso del compositor
  // (tools) arriba y el texto parcial de la respuesta (modo partial) abajo.
  let compositorText = "";
  let partialText = "";

  const composeBubbleText = (): string =>
    [compositorText.trim(), partialText.trim()].filter(Boolean).join("\n\n");

  const queueRender = () => {
    const text = composeBubbleText();
    if (!text) {
      return;
    }
    pendingText = text;
    scheduleFlush();
  };

  const flushNow = async () => {
    const text = pendingText;
    pendingText = null;
    if (!text || !text.trim() || text === lastSentText) {
      return;
    }
    lastFlushAt = Date.now();
    try {
      if (progressMessageId) {
        await sendEditXmpp(params.target, text, progressMessageId, sendOpts);
      } else {
        // Nota: sendMessageXmpp emite <active/> y presencia "available" al
        // final; el heartbeat del turno re-publica composing/dnd enseguida,
        // así que el parpadeo de presencia es breve y tolerable.
        const result = await sendMessageXmpp(params.target, text, sendOpts);
        progressMessageId = result.messageId;
      }
      lastSentText = text;
    } catch (error) {
      params.log?.(`[xmpp] progress update failed for ${params.target}: ${String(error)}`);
    }
  };

  const scheduleFlush = () => {
    if (flushTimer) {
      return;
    }
    const sinceLast = Date.now() - lastFlushAt;
    const wait = progressMessageId ? Math.max(0, MIN_EDIT_INTERVAL_MS - sinceLast) : 0;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      sendChain = sendChain.then(flushNow);
    }, wait);
    flushTimer.unref?.();
  };

  const compositor = createChannelProgressDraftCompositor({
    entry,
    mode,
    active,
    seed: `${params.account.accountId}:${params.target}`,
    update: (text) => {
      compositorText = text;
      queueRender();
    },
  });

  /** Texto parcial de la respuesta (modo partial): la burbuja lo transmite
   * en vivo debajo de las líneas de tools, como el draft de Telegram. */
  const handlePartialReply = (payload: { text?: string | null; delta?: string }) => {
    if (!partialEnabled) {
      return;
    }
    const text = typeof payload.text === "string" && payload.text.trim()
      ? payload.text
      : payload.delta
        ? partialText + payload.delta
        : "";
    if (!text.trim()) {
      return;
    }
    partialText = text;
    queueRender();
  };

  /** Immediate acknowledgement. It becomes the progress/final bubble through
   * XEP-0308, so feedback does not add a second permanent message. */
  const start = async () => {
    if (!active || progressMessageId) return;
    partialText = "Recibido · preparando…";
    queueRender();
    await closeWindow();
  };

  /** A visible turn may legitimately end without a reply payload (for
   * example, a tool-only agent turn). Never leave the acknowledgement or
   * pending state hanging in that case. */
  const finishWithoutReply = async () => {
    if (!active) return;
    await finalizeWithFinalText("Turno completado sin respuesta visible.");
  };

  /**
   * Se llama antes de entregar cualquier respuesta visible del agente. NO
   * cierra nada (la burbuja sigue viva para las tools que vengan después);
   * sólo drena la edición pendiente para que la burbuja esté al día antes de
   * que aparezca la respuesta debajo.
   */
  const closeWindow = async () => {
    if (!active) {
      return;
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    sendChain = sendChain.then(flushNow);
    await sendChain.catch(() => {});
  };

  /**
   * Finalización de preview estilo Telegram (finalEdit): si hay burbuja viva
   * y la respuesta final es texto puro que cabe en un solo body XMPP, la
   * burbuja SE CONVIERTE en la respuesta (una última corrección XEP-0308) y
   * no se manda mensaje aparte. Devuelve true si la entrega quedó cubierta.
   * Si no aplica (sin burbuja, texto largo, media), colapsa la burbuja a las
   * líneas de tools (para no dejar el parcial duplicado bajo la respuesta
   * real) y devuelve false para que el caller entregue normal (normalFallback).
   */
  const finalizeWithFinalText = async (finalText: string): Promise<boolean> => {
    if (!active) {
      return false;
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await sendChain.catch(() => {});
    if (!progressMessageId) {
      return false;
    }
    const consumeBubble = () => {
      progressMessageId = null;
      lastSentText = "";
      pendingText = null;
      partialText = "";
      compositorText = "";
      toolsInTurn = 0;
      compositor.markFinalReplyStarted();
      compositor.markFinalReplyDelivered();
      compositor.beginNewTurn();
    };
    const plain = markdownToPlain(finalText.trim());
    const bubbleId = progressMessageId;
    if (plain.trim() && plain.length <= XMPP_MAX_BODY) {
      try {
        await sendEditXmpp(params.target, finalText, bubbleId, sendOpts);
        consumeBubble();
        return true;
      } catch (error) {
        params.log?.(`[xmpp] preview finalize failed for ${params.target}: ${String(error)}`);
        return false;
      }
    }
    // normalFallback: la respuesta va como mensaje normal; dejar la burbuja
    // sólo con las líneas de tools para no duplicar el texto parcial.
    if (partialText.trim() && lastSentText !== compositorText) {
      try {
        await sendEditXmpp(params.target, compositorText.trim() || "✔", bubbleId, sendOpts);
      } catch {
        // best-effort
      }
    }
    consumeBubble();
    return false;
  };

  const handleToolStart = async (payload: {
    itemId?: string;
    toolCallId?: string;
    name?: string;
    phase?: string;
    args?: Record<string, unknown>;
    detailMode?: "explain" | "raw";
  }) => {
    if (payload.phase === "start") {
      toolsInTurn += 1;
    }
    await compositor.pushToolProgress(
      buildChannelProgressDraftLineForEntry(
        entry,
        {
          event: "tool",
          itemId: payload.itemId,
          toolCallId: payload.toolCallId,
          name: payload.name?.trim(),
          phase: payload.phase,
          args: payload.args,
        },
        payload.detailMode ? { detailMode: payload.detailMode } : undefined,
      ),
      { toolName: payload.name?.trim(), startImmediately: true },
    );
  };

  const handleItemEvent = async (payload: {
    itemId?: string;
    toolCallId?: string;
    kind?: string;
    title?: string;
    name?: string;
    phase?: string;
    status?: string;
    summary?: string;
    progressText?: string;
    meta?: string;
  }) => {
    if (payload.kind === "preamble") {
      return;
    }
    await compositor.pushToolProgress(
      buildChannelProgressDraftLineForEntry(entry, {
        event: "item",
        itemId: payload.itemId,
        toolCallId: payload.toolCallId,
        itemKind: payload.kind,
        title: payload.title,
        name: payload.name,
        phase: payload.phase,
        status: payload.status,
        summary: payload.summary,
        progressText: payload.progressText,
        meta: payload.meta,
      }),
    );
  };

  const handleApprovalEvent = async (payload: {
    phase?: string;
    title?: string;
    command?: string;
    reason?: string;
    message?: string;
  }) => {
    if (payload.phase !== "requested") {
      return;
    }
    await compositor.pushToolProgress(
      buildChannelProgressDraftLine({
        event: "approval",
        phase: payload.phase,
        title: payload.title,
        command: payload.command,
        reason: payload.reason,
        message: payload.message,
      }),
      { startImmediately: true },
    );
  };

  const handleCommandOutput = async (payload: {
    itemId?: string;
    toolCallId?: string;
    phase?: string;
    title?: string;
    name?: string;
    status?: string;
    exitCode?: number | null;
  }) => {
    if (payload.phase !== "end") {
      return;
    }
    await compositor.pushToolProgress(
      buildChannelProgressDraftLineForEntry(entry, {
        event: "command-output",
        itemId: payload.itemId,
        toolCallId: payload.toolCallId,
        phase: payload.phase,
        title: payload.title,
        name: payload.name,
        status: payload.status,
        exitCode: payload.exitCode,
      }),
    );
  };

  const handlePatchSummary = async (payload: {
    itemId?: string;
    toolCallId?: string;
    phase?: string;
    title?: string;
    name?: string;
    added?: string[];
    modified?: string[];
    deleted?: string[];
    summary?: string;
  }) => {
    if (payload.phase !== "end") {
      return;
    }
    await compositor.pushToolProgress(
      buildChannelProgressDraftLine({
        event: "patch",
        itemId: payload.itemId,
        toolCallId: payload.toolCallId,
        phase: payload.phase,
        title: payload.title,
        name: payload.name,
        added: payload.added,
        modified: payload.modified,
        deleted: payload.deleted,
        summary: payload.summary,
      }),
    );
  };

  return {
    active,
    closeWindow,
    finalizeWithFinalText,
    handleApprovalEvent,
    handleCommandOutput,
    handleItemEvent,
    handlePartialReply,
    handlePatchSummary,
    handleToolStart,
    finishWithoutReply,
    start,
    suppressDefaultToolProgressMessages: compositor.suppressDefaultToolProgressMessages,
  };
}
