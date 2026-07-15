// Xmpp plugin module implements monitor behavior.
import type { Element } from "@xmpp/xml";
import { xml } from "@xmpp/client";
import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveXmppAccount } from "./accounts.js";
import { connectXmppClient, type XmppConnection } from "./client.js";
import { registerActiveXmppConnection, unregisterActiveXmppConnection } from "./connection-registry.js";
import { handleXmppInbound } from "./inbound.js";
import { bareJid, isGroupJid } from "./normalize.js";
import { extractOobUrl, extractReply, isStaleDelayedStanza, makeXmppMessageId, messageMentionsBot } from "./protocol.js";
import { registerXmppCommands, type XmppCommandRuntime } from "./commands.js";
import { startTelemetryLoop, type TelemetryLoopHandle } from "./telemetry.js";
import type { RuntimeEnv } from "./runtime-api.js";
import { getXmppRuntime } from "./runtime.js";
import type { CoreConfig, XmppInboundMessage } from "./types.js";

type XmppMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  onMessage?: (message: XmppInboundMessage) => void | Promise<void>;
};

const XMPP_MONITOR_RECONNECT_DELAY_MS = 1000;

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

  const sendPlain = (toPlatformId: string, text: string): void => {
    if (!connection?.isConnected()) return;
    const type = isGroupJid(toPlatformId, account.mucDomain) ? "groupchat" : "chat";
    connection.send(xml("message", { type, to: toPlatformId }, xml("body", {}, text))).catch(() => {});
  };

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
      onOnline: async (jid, onlineConnection) => {
        connection = onlineConnection;
        registerActiveXmppConnection(account.accountId, onlineConnection);
        telemetryLoop?.stop();
        telemetryLoop = startTelemetryLoop({ account, connection: onlineConnection, logger });
        logger.info(`[${account.accountId}] connected as ${jid}`);
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

    // Auto-join configured MUC rooms now that the connection is live.
    for (const room of account.mucRooms) {
      connection.joinRoom(room, botNick);
    }
  }

  async function handleStanza(stanza: Element, commandRuntime: XmppCommandRuntime): Promise<void> {
    // Auto-accept presence subscription requests so rosters in clients
    // like Gajim/Dino don't get stuck pending.
    if (stanza.is("presence")) {
      const ptype = stanza.attrs.type;
      const from = stanza.attrs.from as string | undefined;
      if (!from || !connection) return;
      const bare = bareJid(from);
      if (ptype === "subscribe") {
        await connection.send(xml("presence", { to: bare, type: "subscribed" }));
        await connection.send(xml("presence", { to: bare, type: "subscribe" }));
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
    const type = stanza.attrs.type;
    if (type !== "chat" && type !== "groupchat") return;
    if (isStaleDelayedStanza(stanza)) {
      logger.info(`[${account.accountId}] dropped stale delayed message from ${String(stanza.attrs.from)}`);
      return;
    }

    const body = stanza.getChildText("body") || "";
    const from = stanza.attrs.from as string | undefined;
    if (!from) return;

    const oobUrl = extractOobUrl(stanza, body);
    if (!body && !oobUrl) return; // chat states, receipts, etc.

    const platformId = bareJid(from);
    const isGroup = type === "groupchat" || isGroupJid(platformId, account.mucDomain);

    // MUC reflects our own messages back to us.
    if (type === "groupchat") {
      const senderNick = from.split("/")[1];
      if (senderNick === botNick) return;
    }

    // XEP-0050 textual fallback (/nc ...) and pending-session interception,
    // plus /session commands -- all handled by commands.ts, never forwarded
    // to the agent.
    if (body && commandRuntime.handleMessage(platformId, body, stanza)) return;
    if (commandRuntime.hasPending(platformId)) return;

    const senderNick = isGroup ? from.split("/")[1] : undefined;
    const wasMentioned = isGroup ? messageMentionsBot(stanza, body, botNick, account.jid) : true;
    const replyTo = extractReply(stanza) ?? undefined;

    const message: XmppInboundMessage = {
      messageId: (stanza.attrs.id as string) || makeXmppMessageId(),
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
    };

    core.channel.activity.record({
      channel: "xmpp",
      accountId: account.accountId,
      direction: "inbound",
      at: message.timestamp,
    });

    if (opts.onMessage) {
      await opts.onMessage(message);
      return;
    }

    await handleXmppInbound({
      message,
      account,
      config: cfg,
      runtime,
      sendReply: async (target, text) => {
        sendPlain(target, text);
        opts.statusSink?.({ lastOutboundAt: Date.now() });
        core.channel.activity.record({
          channel: "xmpp",
          accountId: account.accountId,
          direction: "outbound",
        });
      },
      statusSink: opts.statusSink,
    });
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
      unregisterActiveXmppConnection(account.accountId);
      void connection?.stop();
      connection = null;
    },
  };
}
