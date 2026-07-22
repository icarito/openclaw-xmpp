// Xmpp plugin module implements client behavior: connection lifecycle,
// exponential reconnect backoff, XEP-0199 ping-driven liveness, MUC join.
//
// Ported from the NanoClaw adapter (src/channels/xmpp.ts) which hard-won
// three fixes worth preserving exactly:
//   1. @xmpp/client bundles @xmpp/reconnect with a FIXED 1s retry delay
//      forever. We take over its `.delay` property on every 'reconnecting'
//      event to get real exponential backoff (capped), so an actual outage
//      doesn't hammer the server every second.
//   2. XEP-0199 ping: a half-dead TCP connection (NAT/firewall silently
//      dropped it) can sit in "online" state indefinitely with no FIN/RST.
//      A periodic self-ping surfaces that within one interval instead of
//      whenever the next outbound message happens to fail.
//   3. MUC membership does not survive a stream restart — rooms must be
//      rejoined explicitly on every (re)connect.
import { client, xml, type Client } from "@xmpp/client";
import type { Element } from "@xmpp/xml";

import type { ResolvedXmppAccount } from "./accounts.js";

// Maps for tracking stream management state across client reconnections/restarts
const lastStreamIds = new Map<string, string>();
const lastInboundCounts = new Map<string, number>();

export type XmppInboundStanzaEvent = {
  stanza: Element;
};

export type XmppClientOptions = {
  account: ResolvedXmppAccount;
  abortSignal?: AbortSignal;
  onOnline?: (jid: string, connection: XmppConnection) => void | Promise<void>;
  onOffline?: () => void;
  onError?: (error: Error) => void;
  onStanza?: (stanza: Element) => void;
  /** IQ handler for disco#items / disco#info / ad-hoc commands (XEP-0050), wired to @xmpp/client's iqCallee below. */
  handleIq?: (stanza: Element) => Promise<Element | undefined>;
  log?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
  };
};

export type XmppConnection = {
  xmpp: Client;
  isConnected: () => boolean;
  send: (stanza: Element) => Promise<void>;
  joinRoom: (roomBareJid: string, nick: string) => void;
  stop: () => Promise<void>;
};

// ── Reconnection backoff (XEP-0199 ping-driven liveness + exponential backoff) ──
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const BACKOFF_FACTOR = 2;

// XEP-0199 ping interval/timeout. See module doc above for why this exists.
const PING_INTERVAL_MS = 55_000;
const PING_TIMEOUT_MS = 15_000;

/**
 * Open a persistent XMPP connection for one account, with exponential
 * reconnect backoff and XEP-0199 liveness ping wired in. Rooms passed via
 * account.mucRooms are (re)joined on every successful connect.
 */
export async function connectXmppClient(options: XmppClientOptions): Promise<XmppConnection> {
  const { account } = options;
  if (!account.jid.trim()) {
    throw new Error("XMPP jid is required");
  }
  if (!account.password.trim()) {
    throw new Error("XMPP password is required");
  }

  const domain = account.jid.split("@")[1];
  const localpart = account.jid.split("@")[0]!;
  const xmpp = client({
    service: account.service,
    domain,
    username: localpart,
    password: account.password,
    resource: account.resource || "openclaw",
  });

  let connected = false;
  let backoffMs = BACKOFF_BASE_MS;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  const joinedRooms = new Set<string>();

  const log = options.log ?? {};
  const connectionLabel = `${account.jid}/${account.resource || "openclaw"}`;

  xmpp.on("error", (err: Error) => {
    log.warn?.(`XMPP connection error: ${err.message}`);
    options.onError?.(err);
  });

  xmpp.on("status", (status: string) => {
    log.info?.(`XMPP connection status: ${status} (${connectionLabel})`);
  });

  // @xmpp/reconnect (bundled in @xmpp/client) already retries on
  // 'disconnect'; we take over its delay for exponential backoff with a cap.
  xmpp.reconnect.on("reconnecting", () => {
    log.warn?.(`XMPP reconnecting (delayMs=${backoffMs})`);
    xmpp.reconnect.delay = backoffMs;
    backoffMs = Math.min(backoffMs * BACKOFF_FACTOR, BACKOFF_MAX_MS);
  });
  xmpp.reconnect.on("reconnected", () => {
    log.info?.(`XMPP reconnected as ${account.jid}`);
  });

  const botNick = localpart;

  const rejoinRooms = (): void => {
    for (const room of joinedRooms) {
      xmpp.send(xml("presence", { to: `${room}/${botNick}` })).catch(() => {});
    }
    if (joinedRooms.size > 0) {
      log.info?.(`XMPP rejoined ${joinedRooms.size} MUC room(s)`);
    }
  };

  const joinRoom = (roomBareJid: string, nick: string): void => {
    joinedRooms.add(roomBareJid);
    if (connected) {
      xmpp.send(xml("presence", { to: `${roomBareJid}/${nick}` })).catch(() => {});
    }
  };

  // Seed auto-join rooms from account config; actual join happens once
  // 'online' fires (or immediately below if already online).
  for (const room of account.mucRooms) {
    joinedRooms.add(room);
  }

  const stopPing = (): void => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  const sendPing = async (): Promise<void> => {
    if (!connected) return;
    try {
      await xmpp.iqCaller.request(
        xml("iq", { type: "get", to: account.jid, id: `ping-${Date.now()}` }, xml("ping", { xmlns: "urn:xmpp:ping" })),
        PING_TIMEOUT_MS,
      );
      log.debug?.("XMPP ping ok");
    } catch (err) {
      log.warn?.(`XMPP ping timeout — forcing reconnect: ${String(err)}`);
      await xmpp.disconnect().catch(() => {});
    }
  };

  let wasResumed = false;
  const sm = (xmpp as any).streamManagement;
  if (sm) {
    sm.on("resumed", () => {
      wasResumed = true;
      log.info?.(`[${account.accountId}] XEP-0198 Stream Management: session resumed`);
    });
    sm.on("fail", (stanza: any) => {
      log.warn?.(`[${account.accountId}] XEP-0198 Stream Management: stanza failed to send: ${stanza?.toString()?.slice(0, 100)}`);
    });
    sm.on("ack", () => {
      log.debug?.(`[${account.accountId}] XEP-0198 Stream Management: stanza acknowledged`);
    });
  }

  xmpp.on("online", async () => {
    connected = true;
    backoffMs = BACKOFF_BASE_MS;
    rejoinRooms();
    stopPing();
    pingTimer = setInterval(() => void sendPing(), PING_INTERVAL_MS);
    log.info?.(`XMPP channel connected as ${connectionLabel}`);

    if (previousStreamId && !wasResumed) {
      log.warn?.(`[${account.accountId}] XMPP stream resumption failed — started normal session`);
    }

    // Enable XEP-0280 Message Carbons
    try {
      const enableCarbons = xml(
        "iq",
        { type: "set", id: `carbons-${Date.now()}` },
        xml("enable", { xmlns: "urn:xmpp:carbons:2" })
      );
      await xmpp.send(enableCarbons);
      log.info?.(`[${account.accountId}] XEP-0280 Message Carbons enabled`);
    } catch (err) {
      log.warn?.(`[${account.accountId}] Failed to enable carbons: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (sm && sm.enabled && sm.id) {
      lastStreamIds.set(account.accountId, sm.id);
    }

    // NOTE(xmpp-migration): pass `connection` (constructed below, before
    // `xmpp.start()`) rather than relying on the caller's own
    // `await connectXmppClient(...)` return value — @xmpp/client can emit
    // 'online' synchronously from inside `xmpp.start()`, before that await
    // resolves, which caused a "Cannot access before initialization" crash
    // when the caller (monitor.ts) tried to read its own not-yet-assigned
    // local variable from inside this callback.
    await options.onOnline?.(account.jid, connection);
  });

  xmpp.on("offline", () => {
    connected = false;
    stopPing();
    log.warn?.(`XMPP channel disconnected (${connectionLabel})`);
    options.onOffline?.();
  });

  if (options.onStanza) {
    xmpp.on("stanza", (stanza: Element) => {
      if (sm) {
        lastInboundCounts.set(account.accountId, sm.inbound);
      }
      options.onStanza?.(stanza);
    });
  }

  // Register formal IQ callee handlers so XEP-0050/disco responses are
  // canonical (the generic 'stanza' event races @xmpp/client's automatic
  // service-unavailable middleware for unclaimed get/set IQs).
  if (options.handleIq) {
    const handleIq = options.handleIq;
    const iqCallee = (
      xmpp as unknown as {
        iqCallee?: {
          get: (ns: string, name: string, handler: (ctx: { stanza: Element }) => Promise<Element | undefined>) => void;
          set: (ns: string, name: string, handler: (ctx: { stanza: Element }) => Promise<Element | undefined>) => void;
        };
      }
    ).iqCallee;
    const DISCO_ITEMS_NS = "http://jabber.org/protocol/disco#items";
    const DISCO_INFO_NS = "http://jabber.org/protocol/disco#info";
    const COMMAND_NS = "http://jabber.org/protocol/commands";
    iqCallee?.get(DISCO_ITEMS_NS, "query", (ctx) => handleIq(ctx.stanza));
    iqCallee?.get(DISCO_INFO_NS, "query", (ctx) => handleIq(ctx.stanza));
    iqCallee?.set(COMMAND_NS, "command", (ctx) => handleIq(ctx.stanza));
  }

  if (options.abortSignal) {
    const abort = () => {
      void xmpp.stop().catch(() => {});
    };
    if (options.abortSignal.aborted) {
      abort();
    } else {
      options.abortSignal.addEventListener("abort", abort, { once: true });
    }
  }

  // Constructed before `xmpp.start()` (see NOTE above `onOnline` call) so the
  // 'online' handler can hand this same object to the caller even if it
  // fires before `xmpp.start()`'s own promise resolves.
  const connection: XmppConnection = {
    xmpp,
    isConnected: () => connected,
    send: async (stanza: Element) => {
      if (!connected) {
        throw new Error(`XMPP account ${account.accountId} is not connected`);
      }
      await xmpp.send(stanza);
    },
    joinRoom,
    stop: async () => {
      connected = false;
      stopPing();
      await xmpp.stop();
    },
  };

  const previousStreamId = lastStreamIds.get(account.accountId);
  const streamManagementConfig = account.config.streamManagement;
  const smEnabled = streamManagementConfig?.enabled !== false;

  if (sm) {
    sm.allowResume = smEnabled;
    if (streamManagementConfig?.resumptionMaxSeconds) {
      sm.preferredMaximum = streamManagementConfig.resumptionMaxSeconds;
    }
  }

  // Define resume on xmpp instance
  (xmpp as any).resume = async (prevId: string) => {
    log.info?.(`Attempting to resume previous stream: ${prevId}`);
    if (sm) {
      sm.id = prevId;
      sm.inbound = lastInboundCounts.get(account.accountId) || 0;
    }
    await xmpp.start();
  };

  if (smEnabled && previousStreamId) {
    try {
      await (xmpp as any).resume(previousStreamId);
    } catch (err) {
      log.warn?.(`Resume attempt failed: ${err instanceof Error ? err.message : String(err)}, starting normal connection...`);
      if (sm) sm.id = "";
      await xmpp.start();
    }
  } else {
    await xmpp.start();
  }

  return connection;
}
