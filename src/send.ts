// Xmpp plugin module implements send behavior.
import { client, xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";
import crypto from "node:crypto";
import {
  encryptOmemoMessage,
  encryptMucOmemoMessage,
  isRoomOmemoCapable,
  buildOmemoMessageStanza,
} from "./omemo/index.js";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  interactiveReplyToPresentation,
  normalizeInteractiveReply,
  renderMessagePresentationFallbackText,
  resolveMessagePresentationControlValue,
  type InteractiveReply,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { resolveXmppAccount } from "./accounts.js";
import type { ResolvedXmppAccount } from "./accounts.js";
import { bareJid, isGroupJid, normalizeXmppMessagingTarget } from "./normalize.js";
import { shouldEncryptDirect } from "./omemo/inbound-mirror.js";
import {
  attachmentLabel,
  buildOriginIdElement,
  buildReceiptRequest,
  markdownToPlain,
  nextStanzaId,
  splitForLimit,
  XMPP_MAX_BODY,
} from "./protocol.js";
import { resolveHooksConfig, resolveReliabilityConfig } from "./config-defaults.js";
import { getOutboundBurstBreaker } from "./burst-breaker.js";
import { getOutboundSpool, resolveOutboundSpoolPath } from "./outbound-spool.js";
import { buildReplyElements, getInboundReplyContext } from "./reply-context.js";
import { CAPS_FEATURES, CAPS_IDENTITY, CAPS_NODE } from "./xep-0050.js";
import { getXmppRuntime } from "./runtime.js";
import { getActiveXmppConnection } from "./connection-registry.js";
import { uploadFileXmpp } from "./upload.js";
import { buildQuickResponseStanza, resolveInlineButtonsScope, type XmppInlineButtonsScope } from "./outbound-render.js";
import { DEFAULT_TTL_MS, registerXmppCommandNode, registerXmppCommandResponse } from "./command-node-registry.js";
import {
  getXmppAccountActivity,
  markXmppMessagePending,
  registerActivityExpiryHandler,
  setXmppAccountActivity,
} from "./activity-registry.js";
import type { CoreConfig } from "./types.js";

type SendXmppOptions = {
  cfg: CoreConfig;
  accountId?: string;
  replyTo?: string;
  target?: string;
  /** Transient send (progress placeholder, edit of a partial): not spooled, no receipt request. */
  ephemeral?: boolean;
};

type SendXmppMediaOptions = SendXmppOptions & {
  /** Options forwarded to loadOutboundMediaFromUrl, matching the Matrix plugin's media fetch path. */
  maxBytes?: number;
  mediaAccess?: unknown;
  mediaLocalRoots?: unknown;
  mediaReadFile?: unknown;
};

type SendXmppResult = {
  messageId: string;
  target: string;
  receipt: MessageReceipt;
};

// Button style forwarded to clients that render colored buttons (Cheogram,
// gtk-llm-chat). Mirrors the core InteractiveButtonStyle enum.
type XmppControlStyle = "primary" | "secondary" | "success" | "danger";
type XmppControl = { label: string; value: string; style?: XmppControlStyle };

function normalizeControlStyle(raw: unknown): XmppControlStyle | undefined {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return s === "primary" || s === "secondary" || s === "success" || s === "danger" ? s : undefined;
}

function pushControl(
  controls: XmppControl[],
  label: unknown,
  value: unknown,
  style?: unknown,
): void {
  const cleanLabel = typeof label === "string" ? label.trim() : "";
  const cleanValue = typeof value === "string" ? value.trim() : "";
  if (cleanLabel && cleanValue && !controls.some((c) => c.value === cleanValue)) {
    const normalizedStyle = normalizeControlStyle(style);
    controls.push({ label: cleanLabel, value: cleanValue, ...(normalizedStyle ? { style: normalizedStyle } : {}) });
  }
}

function collectPresentationControls(presentation: MessagePresentation | undefined): XmppControl[] {
  const controls: XmppControl[] = [];
  const blocks = Array.isArray(presentation?.blocks) ? presentation.blocks : [];
  for (const block of blocks) {
    if (block.type === "buttons") {
      for (const button of block.buttons ?? []) {
        pushControl(controls, button.label, resolveMessagePresentationControlValue(button), (button as { style?: unknown }).style);
      }
    } else if (block.type === "select") {
      for (const option of block.options ?? []) {
        pushControl(controls, option.label, resolveMessagePresentationControlValue(option), (option as { style?: unknown }).style);
      }
    }
  }
  return controls;
}

function collectApprovalFallbackControls(fallback: string): XmppControl[] {
  const controls: XmppControl[] = [];
  // Convey approval semantics through button color where the client supports
  // it: allow=success (green), deny=danger (red). Purely additive — the label
  // and value are unchanged, so text-only clients are unaffected.
  const labels: Record<string, { label: string; style: XmppControlStyle }> = {
    "allow-once": { label: "Allow Once", style: "success" },
    "allow-always": { label: "Allow Always", style: "success" },
    deny: { label: "Deny", style: "danger" },
  };
  for (const line of fallback.split(/\r?\n/)) {
    const value = line.trim();
    const match = value.match(/^\/approve\s+\S+\s+(\S+)/);
    if (!match) continue;
    const decision = match[1] ?? "";
    const meta = labels[decision];
    pushControl(controls, meta?.label ?? decision, value, meta?.style);
  }
  return controls;
}

/**
 * Decide whether inline buttons may be rendered for a specific target, honoring
 * the configured scope. `dm`/`group` gate by chat type; `allowlist` gates by
 * whether the target JID is in the account allowFrom; `all` always allows;
 * `off` never allows. When this returns false the caller degrades to a plain
 * numbered-text message (the body always carries a self-sufficient fallback).
 */
function inlineButtonsAllowsTarget(params: {
  scope: XmppInlineButtonsScope;
  isGroup: boolean;
  target: string;
  allowFrom?: Array<string | number>;
}): boolean {
  switch (params.scope) {
    case "all":
      return true;
    case "dm":
      return !params.isGroup;
    case "group":
      return params.isGroup;
    case "allowlist": {
      const bare = bareJid(params.target).toLowerCase();
      return (params.allowFrom ?? []).some((entry) => {
        const normalized = String(entry).trim().toLowerCase();
        return normalized === "*" || normalized === bare;
      });
    }
    case "off":
    default:
      return false;
  }
}

/**
 * Elimina bloques de fence triple sin contenido (o solo whitespace) entre
 * las marcas de apertura y cierre -- p.ej. ```sh\n\n``` -- que el core
 * produce vía formatFencedCodeBlock cuando el campo envuelto (command,
 * warningText) llega vacío. Red de seguridad independiente de cuál ruta de
 * entrega generó el texto (ver approval-handler.runtime.ts y channel.ts,
 * que ya evitan este caso en el camino feliz vía buildCompactExecApprovalText).
 */
// Exportada para test unitario directo (src/tests/send.test.ts); sin uso
// fuera de este módulo en runtime.
export function stripEmptyFencedCodeBlocks(text: string): string {
  return text.replace(/```[^\n`]*\n[ \t]*\n?```\n?/g, "\n");
}

// Exportada para test unitario directo (src/tests/send.test.ts); sin uso
// fuera de este módulo en runtime.
export function compactApprovalFallbackText(fallback: string): string {
  const lines = stripEmptyFencedCodeBlocks(fallback).split(/\r?\n/);
  const out: string[] = [];
  let skipApproveBlock = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (
      line.startsWith("Full id:") ||
      line.startsWith("Other options:") ||
      line.startsWith("The effective approval policy")
    ) {
      skipApproveBlock = line === "Other options:";
      continue;
    }
    if (line === "Run:" || line === "Other options:") {
      skipApproveBlock = true;
      continue;
    }
    if (skipApproveBlock) {
      if (!line || line.startsWith("/approve ")) {
        continue;
      }
      skipApproveBlock = false;
    }
    if (line.startsWith("/approve ")) {
      continue;
    }
    out.push(rawLine);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function recordXmppOutboundActivity(accountId: string): void {
  try {
    getXmppRuntime().channel.activity.record({
      channel: "xmpp",
      accountId,
      direction: "outbound",
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "XMPP runtime not initialized") {
      throw error;
    }
  }
}

function logXmppSend(message: string): void {
  // console.error (→ openclaw.error.log): el log del runtime del plugin se
  // filtra del archivo principal, y estas líneas de diagnóstico ("payload
  // controls=...") nunca aparecían — eso ya produjo un diagnóstico falso de
  // "sendPayloadXmpp nunca corre". stderr sí persiste.
  console.error(`[xmpp] ${message}`);
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  const causeText = cause instanceof Error
    ? `; cause=${cause.name}: ${cause.message}`
    : cause !== undefined
      ? `; cause=${String(cause)}`
      : "";
  return `${error.name}: ${error.message}${causeText}`;
}

function resolveTarget(to: string, opts?: SendXmppOptions): string {
  const fromArg = normalizeXmppMessagingTarget(to);
  if (fromArg) {
    return bareJid(fromArg);
  }
  const fromOpt = normalizeXmppMessagingTarget(opts?.target ?? "");
  if (fromOpt) {
    return bareJid(fromOpt);
  }
  throw new Error(`Invalid XMPP target: ${to}`);
}

function capsVerHash(): string {
  const identityStr = `${CAPS_IDENTITY.category}/${CAPS_IDENTITY.type}//${CAPS_IDENTITY.name}<`;
  const featuresStr = CAPS_FEATURES.map((f) => `${f}<`).join("");
  return crypto.createHash("sha1").update(identityStr + featuresStr, "utf8").digest("base64");
}

function buildStatusPresence(
  to: string,
  activity: "available" | "processing" | "paused" | "pending",
  statusText?: string,
): ReturnType<typeof xml> {
  // "pending" usa el mismo <show>away</show> que "paused": XMPP no tiene un
  // quinto valor entre disponible y ocupado, así que un cliente que sólo mira
  // el color ya ve "ausente" -- el texto en <status> (el contador) es lo que
  // distingue "llegó un mensaje" de "está pausado a propósito".
  const show = (activity === "processing" || activity === "paused" || activity === "pending") ? "away" : undefined;
  const defaultStatus = activity === "processing" ? "Procesando"
    : activity === "paused" ? "Ausente"
    : activity === "pending" ? "Mensaje recibido"
    : "Disponible";
  return xml(
    "presence",
    { to },
    ...(show ? [xml("show", {}, show)] : []),
    xml("status", {}, statusText ?? defaultStatus),
    xml("c", { xmlns: "http://jabber.org/protocol/caps", hash: "sha-1", node: CAPS_NODE, ver: capsVerHash() }),
  );
}

/**
 * Burst breaker por cuenta: al tripular publica la actividad `paused` y una
 * presencia away hacia el destino, sin descartar nunca el turno final. Solo
 * el lane de reintento (`normal`) queda frenado; control/aprobaciones y el
 * turno final están exentos.
 */
function resolveAccountBurstBreaker(account: ResolvedXmppAccount) {
  const { burstBreaker } = resolveReliabilityConfig(account.config);
  return getOutboundBurstBreaker(account.accountId, burstBreaker, (destination) => {
    setXmppAccountActivity(account.accountId, "paused", destination);
    const connection = getActiveXmppConnection(account.accountId);
    if (connection?.isConnected()) {
      try {
        void connection.send(buildStatusPresence(destination, "paused"));
      } catch {
        // best-effort
      }
    }
  });
}

/**
 * Publica de inmediato que un mensaje entró y está en cola, sin esperar al
 * siguiente tick del loop de telemetría (10s). El registro en memoria
 * (activity-registry) es lo que decide si el agente ya estaba "busy" -- en
 * ese caso este emisor no debe pisar el dnd real con un away de cola.
 */
export async function sendPendingStatusXmpp(
  to: string,
  pendingCount: number,
  opts: SendXmppOptions,
): Promise<void> {
  const cfg = requireRuntimeConfig(opts.cfg, "XMPP pending status") as CoreConfig;
  const account = resolveXmppAccount({ cfg, accountId: opts.accountId });
  if (!account.configured) return;
  let target: string;
  try {
    target = resolveTarget(to, opts);
  } catch {
    return;
  }
  const connection = getActiveXmppConnection(account.accountId);
  if (!connection?.isConnected()) return;
  const type = isGroupJid(target, account.mucDomain) ? "groupchat" : "chat";
  if (getXmppAccountActivity(account.accountId)?.activity === "busy") return;
  markXmppMessagePending(account.accountId, target);
  if (type !== "chat") return; // sólo tiene sentido presencia directa 1:1
  const label = pendingCount === 1 ? "1 mensaje por procesar" : `${pendingCount} mensajes por procesar`;
  try {
    await connection.send(buildStatusPresence(target, "pending", label));
  } catch {
    // best-effort
  }
}

/**
 * Send (or XEP-0308 correct) a text message to `to`. Mirrors the NanoClaw
 * adapter's deliver() text path: markdown -> plain, XMPP_MAX_BODY chunking,
 * and an edit path when replyTo is actually an editTargetId (see note on
 * `operation` below — this plugin's message-adapter passes edits through a
 * distinct call, see send.ts's sendEditXmpp).
 */
export async function sendMessageXmpp(
  to: string,
  text: string,
  opts: SendXmppOptions,
): Promise<SendXmppResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "XMPP send") as CoreConfig;
  const account = resolveXmppAccount({
    cfg,
    accountId: opts.accountId,
  });

  if (!account.configured) {
    throw new Error(
      `XMPP is not configured for account "${account.accountId}" (need jid and password in channels.xmpp).`,
    );
  }

  const target = resolveTarget(to, opts);
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "xmpp",
    accountId: account.accountId,
  });
  const prepared = convertMarkdownTables(text.trim(), tableMode);
  const plain = markdownToPlain(prepared);
  if (!plain.trim()) {
    throw new Error("Message must be non-empty for XMPP sends");
  }

  let connection = getActiveXmppConnection(account.accountId);
  const type = isGroupJid(target, account.mucDomain) ? "groupchat" : "chat";

  let transientCleanup: (() => Promise<void>) | null = null;
  if (!connection?.isConnected() && type === "chat") {
    const domain = account.jid.split("@")[1]!;
    const localpart = account.jid.split("@")[0]!;
    const transient = client({
      service: account.service,
      domain,
      username: localpart,
      password: account.password,
      resource: account.resource || "openclaw",
    });
    await transient.start();
    connection = {
      xmpp: transient,
      isConnected: () => true,
      send: async (stanza) => { await transient.send(stanza); },
      joinRoom: async () => {},
      discoInfo: async () => undefined,
      iqRequest: (stanza, timeoutMs = 30_000) => transient.iqCaller.request(stanza, timeoutMs),
      stop: async () => { await transient.stop(); },
    };
    transientCleanup = async () => { await transient.stop(); };
  }

  let firstId: string | undefined;
  if (connection?.isConnected()) {
    const chunks = splitForLimit(plain, XMPP_MAX_BODY);
    const logger = getXmppRuntime().logging.getChildLogger({
      channel: "xmpp",
      accountId: account.accountId,
    });
    const reliability = resolveReliabilityConfig(account.config);
    const hooks = resolveHooksConfig(account.config);
    const durable = opts.ephemeral !== true;
    const spoolEnabled = durable && reliability.spool.enabled;
    const spool = spoolEnabled
      ? getOutboundSpool(account.accountId, {
          path: resolveOutboundSpoolPath(account.accountId),
          maxAgeMs: reliability.spool.maxAgeMs,
          maxAttempts: reliability.spool.maxAttempts,
        })
      : null;
    const breaker = resolveAccountBurstBreaker(account);
    // La conexión persistente (registrada por monitor) ya cuenta cada envío
    // en su ledger XEP-0198 vía client.trackedSend; la transitoria no, así que
    // solo en ese caso el spool contabiliza el envío desde aquí.
    const usingPersistentConnection = connection === getActiveXmppConnection(account.accountId);
    // XEP-0461: recuperar el remitente y el texto originales para la cita.
    // Sólo se emite en la ruta de texto plano: con OMEMO el plugin sólo cifra
    // el <body> (una <reply/> hermana filtraría metadatos), así que ahí se
    // omite.
    const replyContext = durable && opts.replyTo
      ? getInboundReplyContext(account.accountId, opts.replyTo)
      : undefined;
    const replyElementsForChunk = (chunkIndex: number): Element[] => {
      if (!durable || !opts.replyTo || chunkIndex !== 0) return [];
      const to = replyContext?.to ?? (type === "chat" ? target : undefined);
      if (!to) return [];
      return buildReplyElements({ id: opts.replyTo, to, ...(replyContext?.text ? { text: replyContext.text } : {}) });
    };
    const sendDurable = async (stanza: Element, id: string, turn: boolean): Promise<void> => {
      if (durable) {
        stanza.append(buildOriginIdElement(id));
        if (hooks.receipts) stanza.append(buildReceiptRequest());
        spool?.enqueue({ originId: id, to: target, type, stanza });
      }
      try {
        await connection.send(stanza);
      } catch (error) {
        spool?.requeue(id, error);
        throw error;
      }
      if (!usingPersistentConnection) spool?.noteSent(durable ? id : undefined);
      breaker.record(target, "final", { turn });
    };
    try {
      for (let i = 0; i < chunks.length; i++) {
        const id = nextStanzaId();
        if (i === 0) firstId = id;

        if (account.config.omemo?.enabled) {
          let encryptedElement: Element | null = null;
          if (type === "groupchat") {
            if (isRoomOmemoCapable(account.accountId, target)) {
              encryptedElement = await encryptMucOmemoMessage(account.accountId, target, chunks[i]!, logger);
            } else {
              logger.warn(`[${account.accountId}] OMEMO MUC fallback: room ${target} is semi-anonymous/anonymous or has no occupants with OMEMO, sending plaintext`);
            }
          } else if (shouldEncryptDirect(account.accountId, bareJid(target), account.config.omemo)) {
            encryptedElement = await encryptOmemoMessage(account.accountId, target, chunks[i]!, logger);
            if (!encryptedElement) {
              logger.warn(`[${account.accountId}] OMEMO fallback: recipient ${target} has no OMEMO devices published, sending plaintext`);
            }
          }

          if (encryptedElement) {
            const stanza = buildOmemoMessageStanza(target, encryptedElement, type);
            stanza.attrs.id = id;
            await sendDurable(stanza, id, i === chunks.length - 1);
            continue;
          }
          if (account.config.omemo.requireEncryption) {
            throw new Error(`OMEMO encryption required for ${target}, but no compatible devices were available`);
          }
        }

        await sendDurable(
          xml("message", { type, to: target, id }, xml("body", {}, chunks[i]!), ...replyElementsForChunk(i)),
          id,
          i === chunks.length - 1,
        );
      }
    } finally {
      // Pase lo que pase con el cuerpo, el agente deja de estar ocupado: si
      // salimos por excepción sin soltar el dnd, el contacto queda "ocupado"
      // hasta el próximo turno (o para siempre si el proceso muere).
      setXmppAccountActivity(account.accountId, "available", target);
      try {
        await connection.send(
          xml("message", { type, to: target }, xml("active", { xmlns: "http://jabber.org/protocol/chatstates" })),
        );
        if (type === "chat") await connection.send(buildStatusPresence(target, "available"));
      } catch {
        // best-effort
      }
    }
  } else {
    throw new Error(
      `XMPP account "${account.accountId}" has no active connection (transient send is not supported for a persistent-presence channel like XMPP/MUC).`,
    );
  }

  try {
    await transientCleanup?.();
  } catch {
    // best-effort shutdown
  }

  recordXmppOutboundActivity(account.accountId);

  const messageId = firstId ?? nextStanzaId();
  return {
    messageId,
    target,
    receipt: createMessageReceiptFromOutboundResults({
      results: [
        {
          channel: "xmpp",
          messageId,
          conversationId: target,
        },
      ],
      kind: "text",
      ...(opts.replyTo ? { replyToId: opts.replyTo } : {}),
    }),
  };
}

export async function sendPayloadXmpp(
  to: string,
  text: string,
  payload: {
    presentation?: MessagePresentation;
    interactive?: InteractiveReply;
    text?: string | null;
    mediaUrl?: string | null;
    channelData?: Record<string, unknown>;
  },
  opts: SendXmppOptions,
): Promise<SendXmppResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "XMPP payload send") as CoreConfig;
  const account = resolveXmppAccount({ cfg, accountId: opts.accountId });
  if (!account.configured) {
    throw new Error(`XMPP is not configured for account "${account.accountId}".`);
  }
  const target = resolveTarget(to, opts);
  const connection = getActiveXmppConnection(account.accountId);
  if (!connection?.isConnected()) {
    throw new Error(`XMPP account "${account.accountId}" has no active connection.`);
  }

  const xmppData = payload.channelData?.xmpp as Record<string, unknown> | undefined;
  const presentation =
    payload.presentation ??
    (xmppData?.presentation as MessagePresentation | undefined) ??
    (() => {
      const interactive = normalizeInteractiveReply(payload.interactive);
      return interactive ? interactiveReplyToPresentation(interactive) : undefined;
    })();
  const explicitText = (text || payload.text || "").trim();
  // Approval payloads already carry a channel-specific compact rendering.
  // Re-rendering their presentation here resurrects the verbose core fallback
  // (including empty warning fences, the full UUID and policy metadata) and
  // effectively discards that compact text.
  const fallback = xmppData?.approval && explicitText
    ? explicitText
    : renderMessagePresentationFallbackText({
        presentation,
        text: explicitText || null,
        emptyFallback: "Approval required.",
      });
  const controls = collectPresentationControls(presentation);
  if (controls.length === 0) {
    controls.push(...collectApprovalFallbackControls(fallback));
  }
  logXmppSend(
    `payload controls=${controls.length} labels=${controls.map((c) => c.label).join("|") || "-"} ` +
    `fallbackApprove=${fallback.includes("/approve ")}`,
  );

  if (controls.length === 0) {
    logXmppSend("payload fell back to plain text");
    return await sendMessageXmpp(to, compactApprovalFallbackText(fallback), opts);
  }

  const type = isGroupJid(target, account.mucDomain) ? "groupchat" : "chat";

  // Honor capabilities.inlineButtons scope: when buttons aren't permitted for
  // this target, degrade to a plain numbered-text message. The compacted
  // fallback body already lists each option as "N) label" and the command-node
  // response registry accepts "N"/label/value replies, so users can still act.
  const inlineButtonsScope = resolveInlineButtonsScope(account.config.capabilities);
  const buttonsAllowed = inlineButtonsAllowsTarget({
    scope: inlineButtonsScope,
    isGroup: type === "groupchat",
    target,
    allowFrom: account.config.allowFrom,
  });
  if (!buttonsAllowed) {
    logXmppSend(`payload buttons suppressed (scope=${inlineButtonsScope}, group=${type === "groupchat"}) -> plain text`);
    return await sendMessageXmpp(to, compactApprovalFallbackText(fallback), opts);
  }

  const id = nextStanzaId();
  const approvalData = xmppData?.approval as Record<string, unknown> | undefined;
  const explicitExpiresAtMs = typeof approvalData?.expiresAtMs === "number" ? approvalData.expiresAtMs : undefined;
  const expiresAtMs = explicitExpiresAtMs ?? Date.now() + DEFAULT_TTL_MS;
  const responseTtlMs = Math.max(0, expiresAtMs - Date.now());
  const ttlOptions = { ttlMs: responseTtlMs };
  const commandItems = controls.map((control, index) => {
    const node = `cmd:${id}:${index}`;
    registerXmppCommandNode({
      accountId: account.accountId,
      node,
      commandText: control.value,
      ...ttlOptions,
    });
    for (const responseText of [String(index + 1), control.label, control.value]) {
      registerXmppCommandResponse({
        accountId: account.accountId,
        jid: target,
        responseText,
        commandText: control.value,
        ...ttlOptions,
      });
    }
    return { jid: `${account.jid}/${account.resource}`, node, label: control.label, ...(control.style ? { style: control.style } : {}) };
  });

  await connection.send(
    buildQuickResponseStanza(
      presentation?.title ?? "OpenClaw",
      compactApprovalFallbackText(fallback),
      controls,
      target,
      type,
      id,
      { expiresAtMs, commandItems },
    ),
  );
  recordXmppOutboundActivity(account.accountId);
  return {
    messageId: id,
    target,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "xmpp", messageId: id, conversationId: target }],
      kind: "text",
      ...(opts.replyTo ? { replyToId: opts.replyTo } : {}),
    }),
  };
}

/**
 * Send a file as a real XEP-0363 HTTP Upload (fetch the media OpenClaw
 * resolved for us via loadOutboundMediaFromUrl, PUT it to an upload slot,
 * then send a <message> with the download URL as an XEP-0066 OOB link plus
 * a caption). Mirrors the file-attachment branch in the NanoClaw adapter's
 * deliver() (src/channels/xmpp.ts), and follows the same integration
 * pattern the Matrix plugin uses for its own media upload (fetch via the
 * SDK helper, then hand the buffer to the channel's native upload API).
 *
 * Falls back to embedding the OpenClaw-hosted mediaUrl as a plain link if
 * no XEP-0363 upload component is discoverable via disco (some servers
 * don't run one), so media is never silently dropped.
 */
export async function sendFileXmpp(
  to: string,
  text: string,
  mediaUrl: string,
  opts: SendXmppMediaOptions,
): Promise<SendXmppResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "XMPP media send") as CoreConfig;
  const account = resolveXmppAccount({ cfg, accountId: opts.accountId });
  if (!account.configured) {
    throw new Error(`XMPP is not configured for account "${account.accountId}".`);
  }
  const target = resolveTarget(to, opts);
  const connection = getActiveXmppConnection(account.accountId);
  if (!connection?.isConnected()) {
    throw new Error(`XMPP account "${account.accountId}" has no active connection.`);
  }
  const type = isGroupJid(target, account.mucDomain) ? "groupchat" : "chat";
  const caption = markdownToPlain(text.trim());
  const domain = account.jid.split("@")[1]!;

  let media: Awaited<ReturnType<typeof loadOutboundMediaFromUrl>>;
  try {
    media = await loadOutboundMediaFromUrl(mediaUrl, {
      maxBytes: opts.maxBytes,
      mediaAccess: opts.mediaAccess,
      mediaLocalRoots: opts.mediaLocalRoots,
      mediaReadFile: opts.mediaReadFile,
    } as never);
  } catch (error) {
    logXmppSend(`media load failed url=${mediaUrl} error=${describeError(error)}`);
    if (/^https?:\/\//i.test(mediaUrl)) {
      const fallbackText = caption
        ? `${caption}\n\n[media unavailable] ${mediaUrl}`
        : `[media unavailable] ${mediaUrl}`;
      const id = nextStanzaId();
      await connection.send(xml("message", { type, to: target, id }, xml("body", {}, fallbackText)));
      recordXmppOutboundActivity(account.accountId);
      return {
        messageId: id,
        target,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "xmpp", messageId: id, conversationId: target }],
          kind: "media",
        }),
      };
    }
    throw error;
  }

  const filename = media.fileName ?? mediaUrl.split("/").pop()?.split("?")[0] ?? "file";
  const id = nextStanzaId();

  const uploadResult = await uploadFileXmpp(connection.xmpp, domain, filename, media.buffer);
  if (!uploadResult.ok) {
    const failedUpload = uploadResult as Extract<typeof uploadResult, { ok: false }>;
    logXmppSend(
      `media upload unavailable url=${mediaUrl} filename=${filename} reason=${failedUpload.reason}` +
        `${failedUpload.status !== undefined ? ` status=${failedUpload.status}` : ""}` +
        `${failedUpload.error ? ` error=${failedUpload.error}` : ""}`,
    );
    // No upload component, or the PUT failed -- degrade to a plain link
    // rather than silently dropping the attachment.
    const fallbackText = caption
      ? `${caption}\n\n[${filename} — upload unavailable] ${mediaUrl}`
      : `[${filename} — upload unavailable] ${mediaUrl}`;
    await connection.send(xml("message", { type, to: target, id }, xml("body", {}, fallbackText)));
    recordXmppOutboundActivity(account.accountId);
    return {
      messageId: id,
      target,
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "xmpp", messageId: id, conversationId: target }],
        kind: "media",
      }),
    };
  }

  const label = attachmentLabel(media.contentType ?? "application/octet-stream", media.buffer.length);
  const bodyText = caption
    ? `${caption}\n\n[${label}] ${filename}: ${uploadResult.getUrl}`
    : `[${label}] ${filename}: ${uploadResult.getUrl}`;
  // XEP-0385 (Stateless Inline Media Sharing) + XEP-0428 (Fallback
  // Indication): plain jabber:x:oob is enough per spec, but clients seen in
  // the wild (Dino, Gajim) only auto-preview images in MUC rooms when the
  // richer <reference><media-sharing> shape declares content-type/size/hash
  // up front -- Cheogram already sends this on inbound attachments we
  // receive. Without it, occupants only get a clickable link, never an
  // inline image, even though the OOB url itself is valid and reachable.
  const sha256Hash = crypto.createHash("sha256").update(media.buffer).digest("base64");
  await connection.send(
    xml(
      "message",
      { type, to: target, id },
      xml("body", {}, bodyText),
      xml("x", { xmlns: "jabber:x:oob" }, xml("url", {}, uploadResult.getUrl)),
      xml(
        "reference",
        { xmlns: "urn:xmpp:reference:0", type: "data" },
        xml(
          "media-sharing",
          { xmlns: "urn:xmpp:sims:1" },
          xml(
            "file",
            { xmlns: "urn:xmpp:jingle:apps:file-transfer:5" },
            xml("media-type", {}, media.contentType ?? "application/octet-stream"),
            xml("name", {}, filename),
            xml("size", {}, String(media.buffer.length)),
            xml("hash", { xmlns: "urn:xmpp:hashes:2", algo: "sha-256" }, sha256Hash),
          ),
          xml(
            "sources",
            {},
            xml("reference", { xmlns: "urn:xmpp:reference:0", type: "data", uri: uploadResult.getUrl }),
          ),
        ),
      ),
      xml("fallback", { xmlns: "urn:xmpp:fallback:0", for: "jabber:x:oob" }, xml("body", {})),
    ),
  );
  recordXmppOutboundActivity(account.accountId);

  return {
    messageId: id,
    target,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "xmpp", messageId: id, conversationId: target }],
      kind: "media",
    }),
  };
}

/**
 * XEP-0085 chat state notifications: send <composing/> (start/refresh
 * typing) or <active/> (clear typing). Ported from xmpp.ts's setTyping()
 * (which sent <composing/> paired with a 'processing' presence status) and
 * the plain <active/> clear already used at the end of sendMessageXmpp
 * above. Wired into channel.ts's base.heartbeat.sendTyping/clearTyping
 * (the plugin-SDK hook Matrix uses for the same purpose via
 * sendTypingMatrix) -- best-effort only, mirroring xmpp.ts's own
 * try/catch-and-log-debug behavior; a failed typing indicator must never
 * fail the calling turn.
 */
/**
 * Devuelve al contacto a "disponible" cuando el busy caducó sin que nadie
 * llamara a clearTypingXmpp() (turno abortado, excepción, proceso caído). Sin
 * esto el <presence> dnd que ya recibió el servidor se queda ahí: el agente
 * aparece "ocupado" indefinidamente aunque no esté haciendo nada.
 */
function publishExpiredBusyPresence(accountId: string, target: string | null | undefined): void {
  if (!target) return;
  const connection = getActiveXmppConnection(accountId);
  if (!connection?.isConnected()) return;
  try {
    void connection.send(buildStatusPresence(target, "available"));
  } catch {
    // best-effort: la presencia se recalcula igual en la próxima conexión.
  }
}

registerActivityExpiryHandler(publishExpiredBusyPresence);

export async function sendTypingXmpp(to: string, opts: SendXmppOptions): Promise<void> {
  const cfg = requireRuntimeConfig(opts.cfg, "XMPP typing") as CoreConfig;
  const account = resolveXmppAccount({ cfg, accountId: opts.accountId });
  if (!account.configured) return;
  let target: string;
  try {
    target = resolveTarget(to, opts);
  } catch {
    return;
  }
  const connection = getActiveXmppConnection(account.accountId);
  if (!connection?.isConnected()) return;
  const type = isGroupJid(target, account.mucDomain) ? "groupchat" : "chat";
  setXmppAccountActivity(account.accountId, "processing", target);
  try {
    if (type === "chat") await connection.send(buildStatusPresence(target, "processing"));
    await connection.send(
      xml("message", { type, to: target }, xml("composing", { xmlns: "http://jabber.org/protocol/chatstates" })),
    );
  } catch {
    // best-effort, same as xmpp.ts's setTyping()
  }
}

export async function clearTypingXmpp(to: string, opts: SendXmppOptions): Promise<void> {
  const cfg = requireRuntimeConfig(opts.cfg, "XMPP typing") as CoreConfig;
  const account = resolveXmppAccount({ cfg, accountId: opts.accountId });
  if (!account.configured) return;
  let target: string;
  try {
    target = resolveTarget(to, opts);
  } catch {
    return;
  }
  const connection = getActiveXmppConnection(account.accountId);
  if (!connection?.isConnected()) return;
  const type = isGroupJid(target, account.mucDomain) ? "groupchat" : "chat";
  setXmppAccountActivity(account.accountId, "available", target);
  try {
    await connection.send(
      xml("message", { type, to: target }, xml("active", { xmlns: "http://jabber.org/protocol/chatstates" })),
    );
    if (type === "chat") await connection.send(buildStatusPresence(target, "available"));
  } catch {
    // best-effort
  }
}

/**
 * XEP-0308 Last Message Correction: send a NEW stanza (own fresh id)
 * carrying <replace id='ORIGINAL'/>. Corrections must be a single stanza —
 * if the edited body exceeds XMPP_MAX_BODY we truncate to the first chunk
 * (edits are typically short status updates, not full responses). Mirrors
 * xmpp.ts deliver()'s operation === 'edit' branch.
 */
export async function sendEditXmpp(
  to: string,
  text: string,
  editTargetId: string,
  opts: SendXmppOptions & {
    /**
     * Edición intermedia de la burbuja de streaming: lleva <no-store/>
     * (XEP-0334) para que mod_cloud_notify no dispare un push por CADA
     * parcial (decenas por turno = el spam de notificaciones) y el MAM no
     * archive cada versión intermedia. La edición FINAL (la respuesta real)
     * va sin el hint: esa sí debe notificar y quedar en el archivo.
     */
    ephemeral?: boolean;
    /** XEP-0461: id del mensaje entrante al que esta edición final responde. */
    replyTo?: string;
  },
): Promise<SendXmppResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "XMPP edit") as CoreConfig;
  const account = resolveXmppAccount({ cfg, accountId: opts.accountId });
  if (!account.configured) {
    throw new Error(`XMPP is not configured for account "${account.accountId}".`);
  }
  const target = resolveTarget(to, opts);
  const plain = markdownToPlain(text.trim());
  const connection = getActiveXmppConnection(account.accountId);
  if (!connection?.isConnected()) {
    throw new Error(`XMPP account "${account.accountId}" has no active connection.`);
  }
  const type = isGroupJid(target, account.mucDomain) ? "groupchat" : "chat";
  const id = nextStanzaId();
  const body = plain.length > XMPP_MAX_BODY ? splitForLimit(plain, XMPP_MAX_BODY)[0]! : plain;
  // Solo la edición FINAL (no efímera) es un final durable: ahí sí van
  // origin-id y solicitud de receipt XEP-0184. Los parciales llevan
  // <no-store/> y jamás solicitan acuse.
  const hooks = resolveHooksConfig(account.config);
  const durableEdit = opts.ephemeral !== true && hooks.receipts;
  // XEP-0461 en la edición FINAL (la que se convierte en la respuesta). Con
  // OMEMO se omite: el plugin sólo cifra el <body>, y una <reply/> hermana
  // filtraría metadatos del mensaje citado.
  const replyElements = !opts.ephemeral && opts.replyTo && !account.config.omemo?.enabled
    ? (() => {
        const ctx = getInboundReplyContext(account.accountId, opts.replyTo!);
        const to = ctx?.to ?? (type === "chat" ? target : undefined);
        if (!to) return [] as Element[];
        return buildReplyElements({ id: opts.replyTo!, to, ...(ctx?.text ? { text: ctx.text } : {}) });
      })()
    : [];

  // Keep the XEP-0308 correlation on the outer stanza while encrypting only
  // the edited body. <replace/> exposes the stanza id being corrected, not
  // the message text; dropping it turns every streaming update into a new
  // bubble in Gajim, Dino and gtk-llm-chat.
  if (account.config.omemo?.enabled) {
    const logger = getXmppRuntime().logging.getChildLogger({
      channel: "xmpp",
      accountId: account.accountId,
    });
    let encryptedElement: Element | null = null;
    if (type === "groupchat") {
      if (isRoomOmemoCapable(account.accountId, target)) {
        encryptedElement = await encryptMucOmemoMessage(account.accountId, target, body, logger);
      } else {
        logger.warn(`[${account.accountId}] OMEMO MUC edit fallback: room ${target} is not OMEMO-capable`);
      }
    } else if (shouldEncryptDirect(account.accountId, bareJid(target), account.config.omemo)) {
      encryptedElement = await encryptOmemoMessage(account.accountId, target, body, logger);
      if (!encryptedElement) {
        logger.warn(`[${account.accountId}] OMEMO edit fallback: recipient ${target} has no compatible devices`);
      }
    }

    if (encryptedElement) {
      const stanza = buildOmemoMessageStanza(target, encryptedElement, type, {
        replaceId: editTargetId,
        ephemeral: opts.ephemeral,
      });
      stanza.attrs.id = id;
      if (durableEdit) {
        stanza.append(buildOriginIdElement(id));
        stanza.append(buildReceiptRequest());
      }
      await connection.send(stanza);
      recordXmppOutboundActivity(account.accountId);
      return {
        messageId: id,
        target,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "xmpp", messageId: id, conversationId: target }],
          kind: "text",
        }),
      };
    }
    if (account.config.omemo.requireEncryption) {
      throw new Error(`OMEMO encryption required for ${target}, but no compatible devices were available`);
    }
  }
  await connection.send(
    xml(
      "message",
      { type, to: target, id },
      xml("body", {}, body),
      xml("replace", { xmlns: "urn:xmpp:message-correct:0", id: editTargetId }),
      ...replyElements,
      ...(opts.ephemeral ? [xml("no-store", { xmlns: "urn:xmpp:hints" })] : []),
      ...(durableEdit ? [buildOriginIdElement(id), buildReceiptRequest()] : []),
    ),
  );
  recordXmppOutboundActivity(account.accountId);
  return {
    messageId: id,
    target,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "xmpp", messageId: id, conversationId: target }],
      kind: "text",
    }),
  };
}
