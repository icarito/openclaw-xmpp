// Xmpp plugin module implements monitor behavior.
import type { Element } from "@xmpp/xml";
import { xml } from "@xmpp/client";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createChannelApprovalHandlerFromCapability } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ChannelApprovalHandler } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import { resolveXmppAccount } from "./accounts.js";
import { clearXmppAccountActivity, getXmppAccountActivity, registerActivityChangeHandler, setXmppAccountActivity } from "./activity-registry.js";
import {
  xmppApprovalNativeAdapter,
  xmppApprovalNativeRuntime,
} from "./approval-handler.runtime.js";
import { connectXmppClient, type XmppConnection } from "./client.js";
import { registerActiveXmppConnection, unregisterActiveXmppConnection } from "./connection-registry.js";
import { handleXmppInbound } from "./inbound.js";
import { bareJid, isGroupJid } from "./normalize.js";
import {
  buildChatMarker,
  buildReceiptReceived,
  classifyCarbonStanza,
  extractChatMarker,
  extractReceiptId,
  extractOobUrl,
  extractReply,
  hasNoStoreHint,
  hasReceiptRequest,
  isStaleDelayedStanza,
  makeXmppMessageId,
  messageMentionsBot,
  stripInlineOobMarkup,
} from "./protocol.js";
import { resolveHooksConfig, resolveHistoryConfig, resolveReliabilityConfig } from "./config-defaults.js";
import { publishActivityHookEvent, publishApprovalHookEvent } from "./hooks/pep-events.js";
import { rememberInboundReplyContext } from "./reply-context.js";
import { NS_REACTIONS } from "./reactions.js";
import { getOutboundBurstBreaker } from "./burst-breaker.js";
import { getOutboundSpool, resolveOutboundSpoolPath, type OutboundSpool } from "./outbound-spool.js";
import { getDispatchDedupe, resolveDispatchDedupePath } from "./dispatch-dedupe.js";
import { InboundDebouncer, shouldDebounceInbound } from "./inbound-debounce.js";
import {
  describeXmppFeaturePreflight,
  getXmppFeaturePreflight,
  preflightXmppFeatures,
} from "./preflight-features.js";
import { MamClient, stanzaArchiveId, type MamArchivedMessage } from "./mam.js";
import {
  dmPeerKey,
  getMamWatermark,
  parsePeerKey,
  resolveMamWatermarkPath,
  roomPeerKey,
} from "./mam-watermark.js";
import {
  applyCatchupMessages,
  decideArchiveReplay,
  formatCatchupContext,
  getCatchupContextStore,
} from "./history-context.js";
import { getApprovalCardRegistry } from "./approval-card-registry.js";
import { registerXmppCommands, type XmppCommandRuntime } from "./commands.js";
import { sendEditXmpp, sendMessageXmpp } from "./send.js";
import { resolveInlineButtonsScope } from "./outbound-render.js";
import { startTelemetryLoop, type TelemetryLoopHandle } from "./telemetry.js";
import type { RuntimeEnv } from "./runtime-api.js";
import { getXmppRuntime } from "./runtime.js";
import type { CoreConfig, XmppInboundMessage } from "./types.js";
import {
  initializeOmemo,
  shutdownOmemo,
  decryptOmemoMessage,
  isOmemoEncrypted,
  handleMucPresence,
} from "./omemo/index.js";

type XmppMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  onMessage?: (message: XmppInboundMessage) => void | Promise<void>;
  /** Forwarded from gateway.startAccount's ctx so the native approval runtime can register itself, same as Telegram's monitor.ts. */
  channelRuntime?: ChannelRuntimeSurface;
};

const XMPP_MONITOR_RECONNECT_DELAY_MS = 1000;
const XMPP_INBOUND_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/** Instancia única del handler nativo de aprobaciones por cuenta (ver el
 * bloque de arranque en monitorXmppProvider — evita cards duplicadas). */
const nativeApprovalHandlers = new Map<string, ChannelApprovalHandler>();

type RecentInboundEntry = { key: string; at: number };

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 24);
}

function resolveDedupePath(accountId: string): string | null {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) return null;
  return join(stateDir, "channel-cache", "xmpp", `${accountId}-recent-inbound.json`);
}

function loadRecentInbound(path: string | null, now: number): Map<string, number> {
  const entries = new Map<string, number>();
  if (!path || !existsSync(path)) return entries;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { entries?: RecentInboundEntry[] };
    for (const entry of raw.entries ?? []) {
      if (typeof entry.key !== "string" || typeof entry.at !== "number") continue;
      if (now - entry.at <= XMPP_INBOUND_DEDUPE_WINDOW_MS) entries.set(entry.key, entry.at);
    }
  } catch {
    // Corrupt dedupe state must not block inbound chat.
  }
  return entries;
}

function saveRecentInbound(path: string | null, entries: Map<string, number>, now: number): void {
  if (!path) return;
  try {
    const filtered = [...entries.entries()]
      .filter(([, at]) => now - at <= XMPP_INBOUND_DEDUPE_WINDOW_MS)
      .map(([key, at]) => ({ key, at }));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify({ entries: filtered }, null, 2) + "\n");
    renameSync(`${path}.tmp`, path);
  } catch {
    // Best-effort only. The live handler can still process messages safely.
  }
}

function buildInboundDedupeKeys(stanza: Element, type: string, platformId: string, body: string, oobUrl: string | null): string[] {
  const keys: string[] = [];
  const stanzaId = stanza.attrs.id;
  if (typeof stanzaId === "string" && stanzaId.trim()) {
    keys.push(`id:${type}:${platformId}:${stanzaId}`);
  }

  // Body-only dedupe is intentionally limited to delayed replay: without a
  // stanza id, a user can legitimately send the same short text twice.
  if (stanza.getChild("delay", "urn:xmpp:delay")) {
    keys.push(`delayed:${type}:${platformId}:${hashText(`${body}\0${oobUrl ?? ""}`)}`);
  }
  return keys;
}

export async function monitorXmppProvider(opts: XmppMonitorOptions): Promise<{ stop: () => void }> {
  const core = getXmppRuntime();
  const cfg = opts.config ?? (core.config.current() as CoreConfig);
  const account = resolveXmppAccount({
    cfg,
    accountId: opts.accountId,
  });

  const runtime: RuntimeEnv = resolveLoggerBackedRuntime(opts.runtime, core.logging.getChildLogger());

  if (!account.configured) {
    throw new Error(
      `XMPP is not configured for account "${account.accountId}" (need jid and password in channels.xmpp).`,
    );
  }

  const logger = core.logging.getChildLogger({
    channel: "xmpp",
    accountId: account.accountId,
  });

  let nativeApprovalHandler: ChannelApprovalHandler | null = null;
  // Start the handler as part of the account monitor lifecycle. The gateway's
  // generic channel-runtime bootstrap does not observe dynamically loaded XMPP
  // accounts reliably in this build, which otherwise leaves in-line approval
  // requests pending without ever presenting their card.
  // Piloto ampliado a toda la flota (tarea 6.6): con xmpp en
  // NATIVE_APPROVAL_CHANNELS el turno espera in-línea para TODAS las cuentas,
  // y channel.ts declara la superficie nativa para todas (lo que suprime la
  // card del forwarder) -- limitar el handler a una sola cuenta dejaba al
  // resto con aprobaciones invisibles que morían por timeout.
  if (
    process.env.XMPP_NATIVE_APPROVAL_DELIVERY === "1" &&
    (account.config.allowFrom ?? []).length > 0 &&
    resolveInlineButtonsScope(account.config.capabilities) !== "off"
  ) {
    // SINGLETON por cuenta: los re-arranques del provider (restart policy del
    // gateway, reloads) volvían a entrar aquí sin que la instancia anterior
    // muriera, acumulando N handlers → N cards duplicadas por approval
    // (~3x medido el 2026-07-19: 51 entregas para 18 approvals).
    const staleHandler = nativeApprovalHandlers.get(account.accountId);
    if (staleHandler) {
      nativeApprovalHandlers.delete(account.accountId);
      await staleHandler.stop().catch(() => {});
      logger.info?.("stopped stale native approval handler instance");
    }
    logger.info?.("starting native approval handler directly");
    nativeApprovalHandler = await createChannelApprovalHandlerFromCapability({
      capability: {
        native: xmppApprovalNativeAdapter,
        nativeRuntime: xmppApprovalNativeRuntime,
      },
      label: `xmpp/native-approvals:${account.accountId}`,
      clientDisplayName: `XMPP Native Approvals (${account.accountId})`,
      channel: "xmpp",
      channelLabel: "XMPP",
      cfg,
      accountId: account.accountId,
      context: { accountId: account.accountId },
    });
    if (!nativeApprovalHandler) {
      throw new Error("XMPP native approval capability did not create a handler");
    }
    nativeApprovalHandlers.set(account.accountId, nativeApprovalHandler);
    await nativeApprovalHandler.start();
    logger.info?.("native approval handler started");
  }

  let connection: XmppConnection | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let telemetryLoop: TelemetryLoopHandle | null = null;
  const monitorAbort = new AbortController();
  let removeAbortListener: (() => void) | null = null;
  if (opts.abortSignal) {
    const forwardAbort = () => monitorAbort.abort();
    if (opts.abortSignal.aborted) {
      forwardAbort();
    } else {
      opts.abortSignal.addEventListener("abort", forwardAbort, { once: true });
      removeAbortListener = () => opts.abortSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  const botNick = account.jid.split("@")[0]!;
  const dedupePath = resolveDedupePath(account.accountId);
  const recentInbound = loadRecentInbound(dedupePath, Date.now());

  // ── xmpp-first-class-channel: fiabilidad de entrega / anti-fuga ──
  const reliability = resolveReliabilityConfig(account.config);
  const history = resolveHistoryConfig(account.config);
  const hooks = resolveHooksConfig(account.config);
  const outboundSpool: OutboundSpool | null = reliability.spool.enabled
    ? getOutboundSpool(account.accountId, {
        path: resolveOutboundSpoolPath(account.accountId),
        maxAgeMs: reliability.spool.maxAgeMs,
        maxAttempts: reliability.spool.maxAttempts,
      })
    : null;
  const dispatchDedupe = reliability.dispatchDedupe.enabled
    ? getDispatchDedupe(account.accountId, {
        path: resolveDispatchDedupePath(account.accountId),
        ttlMs: reliability.dispatchDedupe.ttlMs,
      })
    : null;
  const burstBreaker = getOutboundBurstBreaker(account.accountId, reliability.burstBreaker, (destination) => {
    setXmppAccountActivity(account.accountId, "paused", destination);
  });
  let lastOnlineResumed = false;

  // PEP activity hooks (tarea 7.2): mirror every activity transition onto the
  // versioned node so ad-hoc clients can subscribe instead of polling status.
  // Deduped against the last published state; publish failures are swallowed.
  let lastPublishedActivity: string | null = null;
  registerActivityChangeHandler(account.accountId, (_accountId, activity, target, pendingCount) => {
    if (!hooks.pepEvents) return;
    const dedupe = `${activity}:${target ?? ""}:${pendingCount ?? ""}`;
    if (dedupe === lastPublishedActivity) return;
    lastPublishedActivity = dedupe;
    void publishActivityHookEvent({
      accountId: account.accountId,
      state: activity,
      originJid: target ?? null,
      target: target ?? null,
      ...(pendingCount !== undefined ? { pendingCount } : {}),
      log: logger,
    });
  });

  // ── xmpp-first-class-channel (fase B): historial MAM / watermark ──
  const watermark = getMamWatermark(account.accountId, {
    path: resolveMamWatermarkPath(account.accountId),
    seenTtlMs: history.windowMs,
  });
  const catchupContext = getCatchupContextStore(account.accountId);
  const mamClient = new MamClient({
    accountId: account.accountId,
    selfJid: account.jid,
    maxPages: history.maxPages,
    iqRequest: (iq, timeoutMs) => {
      if (!connection?.isConnected()) {
        throw new Error(`XMPP MAM query attempted without an active connection (${account.accountId})`);
      }
      return connection.iqRequest(iq, timeoutMs);
    },
    log: logger,
  });
  let catchupInFlight = false;
  let approvalReconciled = false;

  const inboundDebouncer = reliability.debounce.enabled
    ? new InboundDebouncer({
        windowMs: reliability.debounce.windowMs,
        flush: (message) => dispatchInboundMessage(message),
      })
    : null;

  const sendPlain = (toPlatformId: string, text: string): void => {
    if (!connection?.isConnected()) return;
    const type = isGroupJid(toPlatformId, account.mucDomain) ? "groupchat" : "chat";
    connection.send(xml("message", { type, to: toPlatformId }, xml("body", {}, text))).catch(() => {});
  };

  /**
   * Reenvía los salientes pendientes del spool al abrir una sesión nueva (o
   * tras un resume fallido), con el MISMO origin-id y backoff acotado. El
   * breaker frena la cadena si un mismo destino acumula fallos.
   */
  async function resendPendingOutbound(onlineConnection: XmppConnection): Promise<void> {
    if (!outboundSpool || !reliability.spool.resendOnReconnect) return;
    const due = outboundSpool.listDue();
    if (due.length === 0) return;
    logger.info(`[${account.accountId}] resending ${due.length} spooled outbound message(s)`);
    for (const entry of due) {
      if (!burstBreaker.allow(entry.to, "normal")) {
        logger.warn(`[${account.accountId}] spool resend paused by burst breaker for ${entry.to}`);
        break;
      }
      try {
        await onlineConnection.send(outboundSpool.toElement(entry));
        // El contador del stream lo lleva client.ts (trackedSend) en cuanto
        // el envío sale por la conexión persistente; no se duplica aquí.
        burstBreaker.record(entry.to, "normal");
        logger.info(`[${account.accountId}] resent spooled message ${entry.originId} to ${entry.to}`);
      } catch (error) {
        const updated = outboundSpool.requeue(entry.originId, error);
        if (updated?.state === "dead") {
          logger.error(
            `[${account.accountId}] spooled message ${entry.originId} dead-lettered: ${updated.lastError}`,
          );
        } else {
          logger.warn(
            `[${account.accountId}] spool resend failed for ${entry.originId}: ${String(error)}`,
          );
        }
      }
    }
  }

  /** Convierte un mensaje archivado en un turno (solo con spawnTurns opt-in). */
  function dispatchCatchupTurn(archived: MamArchivedMessage): void {
    const from = archived.from ?? "";
    if (!from) return;
    const platformId = bareJid(from);
    const isGroup = archived.type === "groupchat" || isGroupJid(platformId, account.mucDomain);
    const senderNick = isGroup ? from.split("/")[1] : undefined;
    const message: XmppInboundMessage = {
      messageId: archived.originId ?? archived.archiveId?.id ?? makeXmppMessageId(),
      target: platformId,
      rawFrom: from,
      senderJid: platformId,
      ...(senderNick ? { senderNick } : {}),
      text: archived.body,
      timestamp: archived.delayMs ?? Date.now(),
      isGroup,
      // Opt-in explícito del operador: los recuperados se tratan como
      // dirigidos al bot para que el turno se ejecute.
      wasMentioned: true,
      isCarbonCopy: false,
    };
    void dispatchInboundMessage(message).catch((err: unknown) =>
      logger.error(`[${account.accountId}] catch-up turn dispatch failed: ${String(err)}`),
    );
  }

  /** MAM availability from the disco preflight: room archive vs account archive. */
  function mamAvailable(isGroup: boolean): boolean {
    const preflight = getXmppFeaturePreflight(account.accountId);
    if (!preflight) return false;
    return isGroup ? preflight.muc?.mam2 === true : preflight.server?.mam2 === true;
  }

  /**
   * Catch-up observacional (tarea 5.3): recupera el archivo desde el watermark
   * de cada peer, actualiza el watermark en orden y entrega los mensajes como
   * contexto de sesión (nunca turnos) salvo `history.spawnTurns`.
   */
  async function runHistoryCatchup(): Promise<void> {
    if (!history.catchup || catchupInFlight) return;
    const preflight = getXmppFeaturePreflight(account.accountId);
    if (!preflight?.server?.mam2 && !preflight?.muc?.mam2) {
      logger.warn?.(`[${account.accountId}] history catch-up disabled: server does not advertise MAM v2`);
      return;
    }
    catchupInFlight = true;
    try {
      const targets: Array<{ peerKey: string; archive: string; with?: string }> = [];
      for (const peerKey of watermark.peersList()) {
        const parsed = parsePeerKey(peerKey);
        if (!parsed) continue;
        if (!mamAvailable(parsed.kind === "room")) continue;
        if (parsed.kind === "dm") targets.push({ peerKey, archive: bareJid(account.jid), with: parsed.jid });
        else targets.push({ peerKey, archive: parsed.jid });
      }
      // Los rooms auto-join siempre tienen catch-up, aun en el primer arranque.
      if (preflight.muc?.mam2) {
        for (const room of account.mucRooms) {
          const peerKey = roomPeerKey(room);
          if (!targets.some((target) => target.peerKey === peerKey)) {
            targets.push({ peerKey, archive: room });
          }
        }
      }
      for (const target of targets) {
        const anchor = watermark.anchor(target.peerKey);
        try {
          const result = await mamClient.catchup({
            archive: target.archive,
            ...(target.with ? { with: target.with } : {}),
            ...(anchor.anchor ? { anchor: anchor.anchor } : {}),
            ...(anchor.at !== undefined ? { anchorAt: anchor.at } : {}),
            windowMs: history.windowMs,
          });
          if (result.degraded) {
            logger.warn?.(
              `[${account.accountId}] MAM anchor purged for ${target.archive}; degraded to fetch-latest`,
            );
          }
          const applied = applyCatchupMessages({
            peerKey: target.peerKey,
            messages: result.messages,
            watermark,
            context: history.spawnTurns ? undefined : catchupContext,
            spawnTurns: history.spawnTurns,
            dispatch: history.spawnTurns ? (archived) => dispatchCatchupTurn(archived) : undefined,
          });
          if (applied.contextCount > 0 || applied.turnCount > 0) {
            logger.info(
              `[${account.accountId}] MAM catch-up ${target.archive}: ${applied.contextCount} context, ${applied.turnCount} turn(s)${result.degraded ? " (degraded)" : ""}`,
            );
          }
        } catch (error) {
          logger.warn?.(`[${account.accountId}] MAM catch-up failed for ${target.archive}: ${String(error)}`);
        }
      }
    } finally {
      catchupInFlight = false;
    }
  }

  /**
   * Reconciliación de cards de aprobación huérfanas (tareas 6.1/6.2). Corre
   * una sola vez por proceso, cuando ya hay conexión para editar.
   */
  async function reconcileApprovalCards(): Promise<void> {
    if (approvalReconciled) return;
    approvalReconciled = true;
    try {
      const registry = getApprovalCardRegistry(account.accountId);
      const orphaned = registry.list();
      const result = await registry.reconcile({
        editCard: (card, text) =>
          sendEditXmpp(card.jid, text, card.stanzaId, {
            cfg,
            accountId: card.accountId && card.accountId !== "default" ? card.accountId : account.accountId,
          }).then(() => undefined),
        log: logger,
      });
      if (result.reconciled > 0 || result.failed > 0) {
        logger.info(
          `[${account.accountId}] reconciled ${result.reconciled} orphan approval card(s) (failed=${result.failed})`,
        );
      }
      // PEP: cada card que cruzó el reinicio queda cerrada -> "expired".
      if (hooks.pepEvents) {
        for (const card of orphaned) {
          void publishApprovalHookEvent({
            accountId: account.accountId,
            state: "expired",
            approvalId: card.approvalId,
            stanzaId: card.stanzaId,
            jid: card.jid,
            sessionKey: card.sessionKey ?? null,
            expiresAtMs: card.expiresAt,
            log: logger,
          });
        }
      }
    } catch (error) {
      logger.warn?.(`[${account.accountId}] approval card reconciliation failed: ${String(error)}`);
    }
  }

  function scheduleReconnect() {
    if (stopped || monitorAbort.signal.aborted || reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch((error: unknown) => {
        if (stopped || monitorAbort.signal.aborted) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[${account.accountId}] XMPP reconnect failed: ${message}`);
        scheduleReconnect();
      });
    }, XMPP_MONITOR_RECONNECT_DELAY_MS);
  }

  async function connect() {
    if (stopped || monitorAbort.signal.aborted) {
      return;
    }

    // Wire the XEP-0050 command runtime (see commands.ts) once per connect
    // attempt; agentGroupId resolution and per-instance action registration
    // both live there so this file stays transport-only.
    const commandRuntime: XmppCommandRuntime = registerXmppCommands({
      account,
      cfg,
      runtime,
      sendPlain,
    });

    const nextConnection = await connectXmppClient({
      account,
      abortSignal: monitorAbort.signal,
      log: {
        debug: (m) => core.logging.shouldLogVerbose() && logger.debug?.(`[${account.accountId}] ${m}`),
        info: (m) => logger.info(`[${account.accountId}] ${m}`),
        warn: (m) => logger.warn?.(`[${account.accountId}] ${m}`),
        error: (m) => logger.error(`[${account.accountId}] ${m}`),
      },
      handleIq: (stanza) => commandRuntime.handleIq(stanza),
      outboundSpool: outboundSpool ?? undefined,
      mucMaxStanzas: history.mucMaxStanzas,
      onStreamManagement: (event) => {
        if (event.type === "ack" || event.type === "resumed") {
          const acked = outboundSpool?.ackUpTo(event.h) ?? [];
          if (acked.length > 0) {
            logger.info(`[${account.accountId}] XEP-0198 acked ${acked.length} spooled message(s) up to h=${event.h}`);
          }
        } else if (event.type === "online") {
          lastOnlineResumed = event.resumed;
          if (!event.resumed) outboundSpool?.beginStream();
        }
      },
      onOnline: async (jid, onlineConnection) => {
        connection = onlineConnection;
        registerActiveXmppConnection(account.accountId, onlineConnection);
        telemetryLoop?.stop();
        telemetryLoop = startTelemetryLoop({ account, cfg, connection: onlineConnection, logger });
        logger.info(`[${account.accountId}] connected as ${jid}`);

        if (account.config.omemo?.enabled) {
          try {
            await initializeOmemo(account.accountId, account.jid, account.config.omemo.deviceLabel, logger, account.config.omemo.protocol ?? "legacy");
          } catch (err) {
            logger.error(`[${account.accountId}] OMEMO initialization failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        // Un turno que muere entre setTyping y clearTyping (rebound de sesión,
        // kill -9, restart del proceso) deja una presencia dnd/processing
        // dirigida (buildStatusPresence con `to=<peer>`) que el cliente del
        // contacto sigue mostrando: el timer de expiración de
        // activity-registry (90s) es la red de seguridad normal, pero vive en
        // memoria del proceso y se pierde con él, igual que con cualquier
        // restart — nada vuelve a corregir esa presencia dirigida después.
        // clearXmppAccountActivity ya sabe hacer esto (dispara el mismo
        // expiryHandler que usa el TTL normal, que re-emite "available" hacia
        // el último target conocido) — solo faltaba llamarlo aquí, en la
        // única otra transición que puede dejar un turno a medias sin que
        // ningún timer sobreviva para corregirlo. Sin embargo esto NO cubre
        // el caso en que el registro en memoria también se perdió con el
        // proceso (ya no hay "target" que recordar) — por eso además se
        // manda una <presence/> SIN `to` (no dirigida): es el anuncio
        // estándar "disponible" hacia todo el roster, y sobrescribe
        // cualquier presencia dirigida vieja para cualquier peer, se sepa
        // cuál era o no.
        clearXmppAccountActivity(account.accountId);
        try {
          await onlineConnection.send(xml("presence", {}));
        } catch {
          // best-effort, igual que el resto de los emisores de presencia.
        }

        // Preflight de disco (tarea 1.3): cachea MAM v2 del server y del MUC
        // domain para el node status y la fase B. Fail-closed. El catch-up
        // MAM solo corre DESPUÉS de que el preflight confirme soporte.
        void preflightXmppFeatures({
          account,
          discoInfo: (target) => onlineConnection.discoInfo(target),
          log: logger,
        })
          .then(() => runHistoryCatchup())
          .catch((err: unknown) => logger.debug?.(`[${account.accountId}] feature preflight failed: ${String(err)}`));

        // Cards de aprobación que cruzaron un reinicio: cerrarlas con XEP-0308.
        void reconcileApprovalCards();

        // Sesión nueva (o resume fallido): recuperar salientes no reconocidos
        // del spool con el MISMO origin-id y backoff. Un resume exitoso ya
        // marcó lo cubierto por `h`, así que no se reenvía nada.
        if (!lastOnlineResumed) {
          void resendPendingOutbound(onlineConnection).catch((err: unknown) =>
            logger.error(`[${account.accountId}] spool resend failed: ${String(err)}`),
          );
        }
      },
      onOffline: () => {
        unregisterActiveXmppConnection(account.accountId);
        telemetryLoop?.stop();
        telemetryLoop = null;
        if (stopped || monitorAbort.signal.aborted) {
          return;
        }
        connection = null;
        logger.warn?.(
          `[${account.accountId}] XMPP connection closed; reconnecting in ${XMPP_MONITOR_RECONNECT_DELAY_MS}ms`,
        );
        scheduleReconnect();
      },
      onError: (error) => {
        logger.error(`[${account.accountId}] XMPP error: ${error.message}`);
      },
      onStanza: (stanza: Element) => {
        handleStanza(stanza, commandRuntime).catch((err) => {
          logger.error(`[${account.accountId}] stanza handling failed: ${String(err)}`);
        });
      },
    });

    if (stopped || monitorAbort.signal.aborted) {
      await nextConnection.stop();
      return;
    }
    connection = nextConnection;

    // connectXmppClient owns MUC rejoin before it reports the account online.
  }

  async function handleStanza(stanza: Element, commandRuntime: XmppCommandRuntime): Promise<void> {
    // XEP-0313 archive results arrive as <message><result/></message> while a
    // MAM query is in flight (or from a server push): buffer them for the
    // client and never treat them as inbound chat.
    if (mamClient.handleStanza(stanza)) return;

    // Auto-accept presence subscription requests so rosters in clients like
    // Gajim/Dino don't get stuck pending. Do not send a reciprocal subscribe
    // here: several bot accounts may see each other's requests, and mirroring
    // subscribe stanzas from this handler can create a presence ping-pong.
    if (stanza.is("presence")) {
      handleMucPresence(stanza, account.accountId, logger);
      const ptype = stanza.attrs.type;
      const from = stanza.attrs.from as string | undefined;
      if (!from || !connection) return;
      const bare = bareJid(from);
      if (ptype === "subscribe") {
        await connection.send(xml("presence", { to: bare, type: "subscribed" }));
      } else if (ptype === "unsubscribe") {
        await connection.send(xml("presence", { to: bare, type: "unsubscribed" }));
      }
      return;
    }

    // IQ stanzas are handled by the registered iqCallee handlers in
    // client.ts (XEP-0050 / disco) -- do not respond here.
    if (stanza.is("iq")) {
      return;
    }

    if (!stanza.is("message")) return;
    // XEP-0280 wraps messages sent from another resource in <received/>.
    // Sent carbons were already handled by the originating resource.
    const carbon = classifyCarbonStanza(stanza);
    if (carbon.kind === "sent") return;
    const realStanza = carbon.stanza;
    const isCarbonCopy = carbon.isCarbonCopy;

    const type = realStanza.attrs.type;
    if (type !== "chat" && type !== "groupchat") return;

    // XEP-0184 receipt: the recipient confirmed delivery of one of our
    // spooled messages. Ack it and never turn it into agent input.
    const receiptId = extractReceiptId(realStanza);
    if (receiptId) {
      const acked = outboundSpool?.ack(receiptId) ?? false;
      logger.debug?.(`[${account.accountId}] XEP-0184 receipt for ${receiptId}${acked ? " (spool acked)" : ""}`);
      return;
    }
    // XEP-0333 chat markers are informational only.
    const inboundMarker = extractChatMarker(realStanza);
    if (inboundMarker) {
      logger.debug?.(`[${account.accountId}] XEP-0333 ${inboundMarker.marker} for ${inboundMarker.id}`);
      return;
    }
    // XEP-0444: an incoming reaction is informational; never a turn. (Its
    // stanza carries no <body>, but detecting it explicitly keeps the intent
    // documented and logs the elision.)
    if (realStanza.getChild("reactions", NS_REACTIONS)) {
      logger.debug?.(`[${account.accountId}] XEP-0444 inbound reaction ignored`);
      return;
    }

    let body = realStanza.getChildText("body") || "";
    let wasEncrypted = false;

    if (account.config.omemo?.enabled && isOmemoEncrypted(realStanza)) {
      logger.debug?.(`[${account.accountId}] OMEMO encrypted message detected`);
      try {
        const decryptedBody = await decryptOmemoMessage(account.accountId, realStanza, logger);
        if (decryptedBody) {
          body = decryptedBody;
          wasEncrypted = true;
          logger.debug?.(`[${account.accountId}] OMEMO decrypted body successfully`);
        } else {
          logger.warn?.(`[${account.accountId}] OMEMO decryption returned null or failed`);
        }
      } catch (err) {
        logger.error?.(`[${account.accountId}] OMEMO decryption error: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (!account.config.omemo?.enabled && isOmemoEncrypted(realStanza)) {
      logger.debug?.(`[${account.accountId}] OMEMO encrypted message ignored because OMEMO is disabled`);
      return;
    }

    const from = realStanza.attrs.from as string | undefined;
    if (!from) return;

    const oobUrl = extractOobUrl(realStanza, body);
    // A decrypted-OMEMO body may carry the OOB <x> fragment as literal text
    // (see extractOobUrl); strip it so neither the agent nor the user sees
    // raw XML once the URL has already been recovered above.
    if (oobUrl) body = stripInlineOobMarkup(body);
    if (type === "groupchat") {
      logger.info(
        `[${account.accountId}] inbound MUC stanza from ${from} body=${body ? "present" : "empty"} oob=${oobUrl ? "present" : "absent"}`,
      );
    }
    if (!body && !oobUrl) return; // chat states, receipts, etc.
    // A decrypted-OMEMO body may carry the OOB <x> fragment as literal text
    // (see extractOobUrl); strip it so neither the agent nor the user sees
    // raw XML once the URL has already been recovered above.
    if (oobUrl) body = stripInlineOobMarkup(body);

    const platformId = bareJid(from);
    const isGroup = type === "groupchat" || isGroupJid(platformId, account.mucDomain);

    // MUC reflects our own messages back to us.
    if (type === "groupchat") {
      const senderNick = from.split("/")[1];
      if (senderNick === botNick) return;
    }

    // Guard XEP-0203 reconfigurado (tarea 5.5): con MAM activo, una stanza
    // cuyo archive-id ya vimos (catch-up o en vivo) se descarta por dedupe y
    // se registra como replay; el guard de 5 min queda como red de seguridad.
    // Sin MAM, decideArchiveReplay reproduce el guard actual tal cual.
    const archiveId = stanzaArchiveId(realStanza);
    const peerKey = isGroup ? roomPeerKey(platformId) : dmPeerKey(platformId);
    const mamEnabled = mamAvailable(isGroup);
    const archiveDecision = decideArchiveReplay({
      mamEnabled,
      archiveId,
      seen: archiveId ? watermark.isSeen(peerKey, archiveId) : false,
      staleByAge: isStaleDelayedStanza(realStanza),
    });
    if (archiveDecision === "replay") {
      logger.info(
        `[${account.accountId}] dropped MAM replay from ${from} archive-id=${archiveId?.id ?? "-"} (covered by watermark)`,
      );
      return;
    }
    if (archiveDecision === "stale") {
      logger.info(`[${account.accountId}] dropped stale delayed message from ${from}`);
      return;
    }
    if (mamEnabled && archiveId) watermark.setLast(peerKey, archiveId);

    // XEP-0184 receipt request + XEP-0333 markers: acknowledge a durable
    // inbound message and let the sender's client show it as displayed.
    // Never for ephemeral stanzas carrying <no-store/>.
    if (
      hooks.receipts &&
      !hasNoStoreHint(realStanza) &&
      typeof realStanza.attrs.id === "string" &&
      realStanza.attrs.id &&
      connection?.isConnected()
    ) {
      const ackTarget = type === "groupchat" ? platformId : bareJid(from);
      const ackType = type === "groupchat" ? "groupchat" : "chat";
      const inboundId = String(realStanza.attrs.id);
      if (hasReceiptRequest(realStanza)) {
        await connection
          .send(buildReceiptReceived(ackTarget, inboundId, ackType))
          .catch((err: unknown) => logger.debug?.(`[${account.accountId}] receipt reply failed: ${String(err)}`));
      }
      await connection
        .send(buildChatMarker(ackTarget, inboundId, "displayed", ackType))
        .catch((err: unknown) => logger.debug?.(`[${account.accountId}] chat marker failed: ${String(err)}`));
    }

    const dedupeKeys = buildInboundDedupeKeys(realStanza, type, platformId, body, oobUrl);
    if (dedupeKeys.some((key) => recentInbound.has(key))) {
      logger.info(`[${account.accountId}] dropped duplicate message from ${from}`);
      return;
    }
    const dedupeNow = Date.now();
    for (const key of dedupeKeys) recentInbound.set(key, dedupeNow);
    saveRecentInbound(dedupePath, recentInbound, dedupeNow);

    // XEP-0050 textual fallback (/nc ...) and pending-session interception,
    // plus /session commands -- all handled by commands.ts, never forwarded
    // to the agent.
    if (body && commandRuntime.handleMessage(platformId, body, realStanza)) return;
    if (commandRuntime.hasPending(platformId)) return;

    const senderNick = isGroup ? from.split("/")[1] : undefined;
    const wasMentioned = isGroup ? messageMentionsBot(realStanza, body, botNick, account.jid) : true;
    const replyTo = extractReply(realStanza) ?? undefined;

    const message: XmppInboundMessage = {
      messageId: (realStanza.attrs.id as string) || makeXmppMessageId(),
      target: platformId,
      rawFrom: from,
      senderJid: isGroup ? platformId : platformId,
      senderNick,
      text: body,
      timestamp: Date.now(),
      isGroup,
      wasMentioned,
      replyTo,
      oobUrl: oobUrl ?? undefined,
      isCarbonCopy,
      wasEncrypted,
    };

    // XEP-0461: remember who sent this id so a durable reply can carry
    // <reply id to/> plus the XEP-0428 fallback quote (tarea 7.4).
    rememberInboundReplyContext(account.accountId, message.messageId, { to: from, text: body });

    const activity = getXmppAccountActivity(account.accountId)?.activity;
    const turnBusy = activity === "busy" || activity === "processing";
    if (
      inboundDebouncer &&
      shouldDebounceInbound({
        message,
        isControlCommand: false,
        hasPendingInteraction: false,
        turnBusy,
      })
    ) {
      inboundDebouncer.push(`debounce:${account.accountId}:${platformId}`, message);
      return;
    }
    await dispatchInboundMessage(message);
  }

  /**
   * Fold recovered history into the next real turn (modo observacional). The
   * buffer is drained only after the dispatch claim succeeded, so a duplicate
   * never consumes context meant for a later legitimate turn.
   */
  function withCatchupContext(message: XmppInboundMessage): XmppInboundMessage {
    const peerKey = message.isGroup ? roomPeerKey(message.target) : dmPeerKey(message.target);
    const entries = catchupContext.drain(peerKey);
    if (entries.length === 0) return message;
    const prefix = formatCatchupContext(entries);
    logger.info(
      `[${account.accountId}] injecting ${entries.length} recovered history message(s) as context for ${message.target}`,
    );
    return { ...message, text: message.text ? `${prefix}\n\n${message.text}` : prefix };
  }

  async function dispatchInboundMessage(message: XmppInboundMessage): Promise<void> {
    const dispatchKey = `dispatch:${account.accountId}:${message.target}:${message.messageId}`;
    if (dispatchDedupe) {
      if (dispatchDedupe.claim(dispatchKey) === "duplicate") {
        logger.info(`[${account.accountId}] dropped duplicate dispatch ${message.messageId} from ${message.target}`);
        return;
      }
    }
    try {
      const outgoing = withCatchupContext(message);
      core.channel.activity.record({
        channel: "xmpp",
        accountId: account.accountId,
        direction: "inbound",
        at: message.timestamp,
      });

      if (opts.onMessage) {
        await opts.onMessage(outgoing);
        dispatchDedupe?.commit(dispatchKey);
        return;
      }

      await handleXmppInbound({
        message: outgoing,
        account,
        config: cfg,
        runtime,
        sendReply: async (target, text, replyToId) => {
          // Normal replies (including streaming updates/finals) must use the
          // OMEMO-aware outbound path. sendPlain is reserved for XEP-0050
          // command/runtime fallbacks; using it here leaks plaintext stanzas.
          await sendMessageXmpp(target, text, {
            cfg,
            accountId: account.accountId,
            ...(replyToId ? { replyTo: replyToId } : {}),
          });
          opts.statusSink?.({ lastOutboundAt: Date.now() });
          core.channel.activity.record({
            channel: "xmpp",
            accountId: account.accountId,
            direction: "outbound",
          });
        },
        statusSink: opts.statusSink,
      });
      const commit = dispatchDedupe?.commit(dispatchKey);
      if (commit?.duplicateCommit) {
        // Un commit repetido es un turno duplicado: fatal, no se re-ejecuta.
        logger.error(`[${account.accountId}] duplicate dispatch commit for ${message.messageId} (fatal)`);
      }
    } catch (error) {
      dispatchDedupe?.rollback(dispatchKey);
      throw error;
    }
  }

  await connect();

  return {
    stop: () => {
      stopped = true;
      removeAbortListener?.();
      removeAbortListener = null;
      if (!monitorAbort.signal.aborted) {
        monitorAbort.abort();
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      telemetryLoop?.stop();
      telemetryLoop = null;
      inboundDebouncer?.clear();
      registerActivityChangeHandler(account.accountId, null);

      if (account.config.omemo?.enabled) {
        shutdownOmemo(account.accountId, logger).catch((err) => {
          logger.warn(`[${account.accountId}] OMEMO shutdown error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }

      if (nativeApprovalHandler && nativeApprovalHandlers.get(account.accountId) === nativeApprovalHandler) {
        nativeApprovalHandlers.delete(account.accountId);
      }
      void nativeApprovalHandler?.stop();
      nativeApprovalHandler = null;
      unregisterActiveXmppConnection(account.accountId);
      void connection?.stop();
      connection = null;
    },
  };
}
