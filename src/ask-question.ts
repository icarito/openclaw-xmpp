// Xmpp plugin module implements ask_user_question helpers, ported from
// src/channels/xmpp.ts (NanoClaw): normalizeXmppOptions, matchOptionReply,
// shortQuestionId. Pure functions, no NanoClaw dependency.

/**
 * Normalize an ask_question/card `options` payload (bare strings or
 * {label,value} objects) to a consistent {label,value} list.
 */
export function normalizeXmppOptions(raw: unknown[]): { label: string; value: string }[] {
  return raw.map((o) => {
    if (typeof o === "string") return { label: o, value: o };
    const obj = o as Record<string, unknown>;
    const label = String(obj?.label ?? obj?.value ?? "");
    return { label, value: String(obj?.value ?? label) };
  });
}

/**
 * Match a user's free-text reply against a pending question's options.
 * Accepts a 1-based index ("2"), or a case-insensitive exact/normalized
 * match on the option label or value. Returns the option's value or null.
 */
export function matchOptionReply(reply: string, options: { label: string; value: string }[]): string | null {
  const trimmed = reply.trim();
  const asIdx = Number(trimmed);
  if (Number.isInteger(asIdx) && asIdx >= 1 && asIdx <= options.length) {
    return options[asIdx - 1]!.value;
  }
  const lc = trimmed.toLowerCase();
  for (const opt of options) {
    if (opt.label.toLowerCase() === lc || opt.value.toLowerCase() === lc) return opt.value;
  }
  return null;
}

/**
 * Derive a short, human-facing id from a questionId. Shown as a `[xx]`
 * prefix so a user with several open questions can disambiguate a text
 * reply. Base36 of a cheap hash keeps it stable per questionId and short.
 */
export function shortQuestionId(questionId: string): string {
  let h = 0;
  for (let i = 0; i < questionId.length; i++) {
    h = (h * 31 + questionId.charCodeAt(i)) >>> 0;
  }
  return h.toString(36).slice(0, 3);
}
