// Xmpp plugin module implements XEP-0444 Message Reactions (change
// xmpp-first-class-channel, tarea 7.5). Reactions are opt-in
// (`hooks.reactions`): DMs always eligible; MUC rooms only when
// non-anonymous, the same eligibility policy OMEMO applies in
// src/omemo/muc-occupants.ts. Inbound reactions are ignored by the monitor
// (never a turn) — this module only covers emission.
import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";
import { resolveXmppAccount } from "./accounts.js";
import { getActiveXmppConnection } from "./connection-registry.js";
import { resolveHooksConfig } from "./config-defaults.js";
import { bareJid, isGroupJid } from "./normalize.js";
import { getRoomAnonymity } from "./omemo/muc-occupants.js";
import type { CoreConfig } from "./types.js";

export const NS_REACTIONS = "urn:xmpp:reactions:0";

/** Emoji used to acknowledge a resolved approval card. */
export const REACTION_APPROVED = "✅";
export const REACTION_DENIED = "🚫";

/** Build the XEP-0444 `<message><reactions/></message>` stanza. */
export function buildReactionStanza(params: {
  to: string;
  type: string;
  messageId: string;
  reactions: string[];
  id?: string;
}): Element {
  const reactions = params.reactions.map((emoji) => xml("reaction", {}, emoji));
  return xml(
    "message",
    { type: params.type, to: params.to, ...(params.id ? { id: params.id } : {}) },
    xml("reactions", { xmlns: NS_REACTIONS, id: params.messageId }, ...reactions),
  );
}

export type ReactionEligibility = {
  allowed: boolean;
  reason?: "disabled" | "semi-anonymous-room" | "anonymous-room";
};

/**
 * Eligibility gate shared by every emitter: disabled config never reacts; a
 * DM always may; a MUC room only when the tracked room is non-anonymous.
 */
export function resolveReactionEligibility(params: {
  accountId: string;
  target: string;
  isGroup: boolean;
  reactionsEnabled: boolean;
}): ReactionEligibility {
  if (!params.reactionsEnabled) return { allowed: false, reason: "disabled" };
  if (!params.isGroup) return { allowed: true };
  const anonymity = getRoomAnonymity(params.accountId, params.target);
  if (anonymity === "non-anonymous") return { allowed: true };
  return {
    allowed: false,
    reason: anonymity === "semi-anonymous" ? "semi-anonymous-room" : "anonymous-room",
  };
}

/**
 * Emit a reaction to `messageId` on `to`. Returns true when the stanza was
 * sent; false when disabled, ineligible (MUC semi/anonymous) or the account
 * has no live connection. Never throws: reactions are cosmetic acknowledgers.
 */
export async function sendReactionXmpp(params: {
  cfg: CoreConfig;
  accountId?: string;
  to: string;
  messageId: string;
  reactions: string[];
  log?: (line: string) => void;
}): Promise<boolean> {
  try {
    if (!params.messageId || params.reactions.length === 0) return false;
    const account = resolveXmppAccount({ cfg: params.cfg, accountId: params.accountId });
    if (!account.configured) return false;
    const hooks = resolveHooksConfig(account.config);
    const target = bareJid(params.to);
    const type = isGroupJid(target, account.mucDomain) ? "groupchat" : "chat";
    const eligibility = resolveReactionEligibility({
      accountId: account.accountId,
      target,
      isGroup: type === "groupchat",
      reactionsEnabled: hooks.reactions,
    });
    if (!eligibility.allowed) {
      params.log?.(
        `[xmpp] reaction to ${target} elided (${eligibility.reason ?? "ineligible"})`,
      );
      return false;
    }
    const connection = getActiveXmppConnection(account.accountId);
    if (!connection?.isConnected()) return false;
    await connection.send(
      buildReactionStanza({ to: target, type, messageId: params.messageId, reactions: params.reactions }),
    );
    return true;
  } catch (error) {
    params.log?.(`[xmpp] reaction failed for ${params.to}: ${String(error)}`);
    return false;
  }
}

/** Map an approval-resolution edit text to the reaction emoji, if any. */
export function reactionForApprovalText(text: string): string | null {
  if (/🚫|denegado/i.test(text)) return REACTION_DENIED;
  if (/✅|aprobado/i.test(text)) return REACTION_APPROVED;
  return null;
}
