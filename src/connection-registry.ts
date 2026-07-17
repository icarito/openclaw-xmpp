// Xmpp plugin module implements connection registry behavior.
//
// DEVIATION FROM IRC's PATTERN: IRC's send.ts opens a short-lived transient
// connection when no persistent client is passed in (connect, PRIVMSG,
// QUIT) — cheap and correct for IRC because a fresh connection can send to
// any channel/nick immediately after JOIN.
//
// XMPP cannot do this: MUC delivery generally requires an established
// occupant presence in the room (many servers reject/drop groupchat
// messages from a JID that hasn't joined), and opening+closing a full
// XMPP stream (SASL, resource bind, roster fetch) per outbound message is
// far more expensive than IRC's raw-socket PRIVMSG. So this plugin keeps a
// small per-account registry of the live, monitor-owned connection and
// send.ts/upload.ts read from it rather than dialing a transient one.
//
// monitor.ts registers/unregisters the active connection as it starts and
// stops; send.ts (outbound message-adapter path, which OpenClaw may invoke
// independently of the monitor loop) looks it up here.
//
// NOTE: we use globalThis instead of a module-level Map because jiti's
// on-disk compilation can produce separate module instances for the same
// source file (monitor.ts vs send.ts import paths may differ), causing
// the Map to be empty in one when populated in the other.
import type { XmppConnection } from "./client.js";

const REGISTRY_KEY = Symbol.for("openclaw.xmpp.activeConnections");

function getRegistry(): Map<string, XmppConnection> {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = new Map<string, XmppConnection>();
  }
  return g[REGISTRY_KEY] as Map<string, XmppConnection>;
}

export function registerActiveXmppConnection(accountId: string, connection: XmppConnection): void {
  getRegistry().set(accountId, connection);
}

export function unregisterActiveXmppConnection(accountId: string): void {
  getRegistry().delete(accountId);
}

export function getActiveXmppConnection(accountId: string): XmppConnection | undefined {
  return getRegistry().get(accountId);
}

export function listActiveXmppConnections(): Array<{ accountId: string; connection: XmppConnection }> {
  return [...getRegistry()].map(([accountId, connection]) => ({ accountId, connection }));
}
