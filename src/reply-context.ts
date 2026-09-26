// Xmpp plugin module implements the outbound XEP-0461 reply surface (change
// xmpp-first-class-channel, tarea 7.4).
//
// When the agent answers an inbound message, the core reply pipeline hands
// the plugin the inbound stanza id (`replyToId`). XEP-0461 needs BOTH the id
// and the JID of the original sender, plus a fallback copy of the quoted text
// for clients that do not implement replies (XEP-0428). The inbound handler
// remembers that context per (accountId, messageId) here so the send path can
// build the stanzas without changing the core contract.
import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";

const TTL_MS = 15 * 60 * 1000;
const REGISTRY_KEY = "__openclawXmppReplyContext";

export const NS_REPLY = "urn:xmpp:reply:0";
export const NS_FALLBACK = "urn:xmpp:fallback:0";

export type InboundReplyContext = {
  /** Full JID the original message came from (occupant JID in MUC). */
  to: string;
  /** Plain-text body of the original message (fallback quote). */
  text: string;
  expiresAt: number;
};

type Registry = Map<string, InboundReplyContext>;

function registry(): Registry {
  const g = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY]!;
}

function key(accountId: string, messageId: string): string {
  return `${accountId}\0${messageId}`;
}

/** Remember the original sender/text for an inbound message id. Best-effort. */
export function rememberInboundReplyContext(
  accountId: string,
  messageId: string,
  context: { to: string; text: string },
  now = Date.now(),
): void {
  if (!accountId || !messageId || !context.to) return;
  registry().set(key(accountId, messageId), {
    to: context.to,
    text: context.text ?? "",
    expiresAt: now + TTL_MS,
  });
}

/** Look up a remembered context, pruning it when expired. */
export function getInboundReplyContext(
  accountId: string,
  messageId: string,
  now = Date.now(),
): InboundReplyContext | undefined {
  const store = registry();
  const entry = store.get(key(accountId, messageId));
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    store.delete(key(accountId, messageId));
    return undefined;
  }
  return entry;
}

export function clearInboundReplyContext(accountId: string): void {
  const prefix = `${accountId}\0`;
  for (const registryKey of registry().keys()) {
    if (registryKey.startsWith(prefix)) registry().delete(registryKey);
  }
}

/**
 * Build the XEP-0461 `<reply/>` element plus its XEP-0428 `<fallback/>`
 * sibling. `to` is the original sender's JID (full JID / occupant JID); the
 * fallback body carries the quoted text for clients that cannot render
 * replies.
 */
export function buildReplyElements(params: {
  id: string;
  to: string;
  text?: string;
}): Element[] {
  const reply = xml("reply", { xmlns: NS_REPLY, id: params.id, to: params.to });
  const fallbackChildren = params.text && params.text.trim()
    ? [xml("body", {}, params.text)]
    : [];
  const fallback = xml("fallback", { xmlns: NS_FALLBACK, for: NS_REPLY }, ...fallbackChildren);
  return [reply, fallback];
}
