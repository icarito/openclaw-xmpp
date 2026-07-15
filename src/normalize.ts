import { buildChannelOutboundSessionRoute } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Xmpp helper module supports normalize behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Bare JID (user@domain), stripping any /resource. */
export function bareJid(full: string): string {
  const slash = full.indexOf("/");
  return slash < 0 ? full : full.slice(0, slash);
}

export function isGroupJid(bare: string, mucDomain: string | undefined): boolean {
  if (!mucDomain) {
    return false;
  }
  return normalizeLowercaseStringOrEmpty(bare).endsWith(`@${normalizeLowercaseStringOrEmpty(mucDomain)}`);
}

/**
 * A JID is minimally valid if it has a non-empty localpart and domain
 * (resource is optional). Not a full RFC 7622 validator — good enough to
 * reject obviously-malformed targets before we hand them to @xmpp/client.
 */
const JID_PATTERN = /^[^\s@/]+@[^\s@/]+(\/[^\s]*)?$/u;

export function looksLikeXmppTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  return JID_PATTERN.test(trimmed);
}

export function normalizeXmppMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  let target = trimmed;
  const lowered = normalizeLowercaseStringOrEmpty(target);
  if (lowered.startsWith("xmpp:")) {
    target = target.slice("xmpp:".length).trim();
  }
  if (normalizeLowercaseStringOrEmpty(target).startsWith("channel:")) {
    target = target.slice("channel:".length).trim();
  }
  if (normalizeLowercaseStringOrEmpty(target).startsWith("user:")) {
    target = target.slice("user:".length).trim();
  }
  if (!target || !looksLikeXmppTargetId(target)) {
    return undefined;
  }
  return target;
}

export function resolveXmppOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
  mucDomain?: string;
}) {
  const target = normalizeXmppMessagingTarget(params.target);
  if (!target) {
    return null;
  }
  const bare = bareJid(target);
  const chatType = isGroupJid(bare, params.mucDomain) ? "group" : "direct";
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "xmpp",
    accountId: params.accountId,
    recipientSessionExact: chatType === "direct" ? "direct-alias" : false,
    peer: { kind: chatType, id: bare },
    chatType,
    from: `xmpp:${bare}`,
    to: bare,
  });
}

export function normalizeXmppAllowEntry(raw: string): string {
  let value = normalizeLowercaseStringOrEmpty(raw);
  if (!value) {
    return "";
  }
  if (value.startsWith("xmpp:")) {
    value = value.slice("xmpp:".length);
  }
  if (value.startsWith("user:")) {
    value = value.slice("user:".length);
  }
  // Allowlist entries are matched against the bare JID; strip any resource.
  return bareJid(value.trim());
}

/** Allowlist candidates for a message sender: bare JID (the only verified identity XMPP gives us). */
export function buildXmppAllowlistCandidates(senderJid: string): string[] {
  const bare = normalizeLowercaseStringOrEmpty(bareJid(senderJid));
  return bare ? [bare] : [];
}
