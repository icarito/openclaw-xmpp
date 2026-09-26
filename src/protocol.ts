// Xmpp plugin module implements protocol behavior: pure helpers ported
// verbatim (behaviorally) from the NanoClaw adapter (src/channels/xmpp.ts).
// Kept dependency-free (no @xmpp/client import) so they stay easily testable.
import { randomUUID } from "node:crypto";
import { createElement as xml } from "@xmpp/xml";
import type { Element } from "@xmpp/xml";

export const NS_ORIGIN_ID = "urn:xmpp:sid:0";
export const NS_STANZA_ID = "urn:xmpp:sid:0";
export const NS_RECEIPTS = "urn:xmpp:receipts";
export const NS_CHAT_MARKERS = "urn:xmpp:chat-markers:0";
export const NS_HINTS = "urn:xmpp:hints";

/**
 * XMPP has no per-server body-length spec, but many servers (and mobile
 * clients) choke on multi-KB stanzas. Split long text on paragraph -> line ->
 * space -> hard-char boundaries so long agent responses arrive as several
 * readable messages instead of one wall (or a silently dropped oversized
 * stanza).
 */
export const XMPP_MAX_BODY = 4000;
const STALE_DELAY_MS = 5 * 60 * 1000;

export function splitForLimit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut <= 0) cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) cut = remaining.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * XEP-0203 marks messages replayed after an offline interval with their
 * original timestamp. Historical chat must not become fresh agent input:
 * reconnects should never turn an old queue into model turns.
 */
export function isStaleDelayedStanza(stanza: Element, now = Date.now()): boolean {
  const delay = stanza.getChild("delay", "urn:xmpp:delay");
  const stamp = delay?.attrs.stamp;
  if (typeof stamp !== "string") return false;
  const delayedAt = Date.parse(stamp);
  return Number.isFinite(delayedAt) && now - delayedAt > STALE_DELAY_MS;
}

/**
 * XMPP <body> is plain text -- clients render Markdown syntax literally.
 * Strip common inline/block markers to a readable plain-text form while
 * preserving content (link text + URL, list bullets, fenced code without
 * backticks). Deliberately light-touch: no full Markdown parse.
 */
export function markdownToPlain(md: string): string {
  return (
    md
      .replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => (code as string).replace(/\n$/, ""))
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*[-*]\s+/gm, "• ")
  );
}

/** Monotonic-ish stanza id generator, distinct sequence per process. */
let stanzaSeq = 0;
export function nextStanzaId(): string {
  stanzaSeq += 1;
  return `oc-${Date.now().toString(36)}-${stanzaSeq.toString(36)}`;
}

export function makeXmppMessageId(): string {
  return randomUUID();
}

/**
 * Decide whether a groupchat message mentions this bot. Accepts, cheapest
 * first: (1) an XEP-0372 <reference type='mention'/> pointing at our JID or
 * nick, (2) a plain-text token matching our nick with word boundaries and
 * an optional leading '@'.
 */
export function messageMentionsBot(stanza: Element, body: string, nick: string, jid: string): boolean {
  const refs = stanza.getChildren("reference");
  for (const ref of refs) {
    if (ref.attrs.type === "mention") {
      const uri = (ref.attrs.uri as string) || "";
      if (uri.includes(jid) || uri.toLowerCase().includes(nick.toLowerCase())) return true;
    }
  }
  const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@])@?${escaped}\\b`, "i").test(body);
}

/**
 * Extract reply context (XEP-0461 Message Replies). Returns the quoted
 * body's fallback text if present.
 */
export function extractReply(stanza: Element): { text: string; sender: string } | null {
  const reply = stanza.getChild("reply", "urn:xmpp:reply:0");
  if (!reply) return null;
  const to = (reply.attrs.to as string) || "";
  const fallback = stanza.getChild("fallback", "urn:xmpp:fallback:0");
  const fallbackText = fallback ? fallback.getChildText("body") || "" : "";
  const slash = to.indexOf("/");
  const sender = to ? (slash < 0 ? to : to.slice(0, slash)) : "unknown";
  return { text: fallbackText, sender };
}

/**
 * Detect an out-of-band file (XEP-0066) or HTTP-upload (XEP-0363) URL in an
 * inbound stanza: either an <x xmlns='jabber:x:oob'><url/> child, a
 * bare-URL body (common client behavior when sharing a file), or an
 * inline-as-text <x xmlns='jabber:x:oob'> that a client folded into the
 * plaintext body itself.
 *
 * OMEMO can only encrypt the <body> text, not sibling stanza elements, so
 * clients that attach a file under OMEMO (gtk-llm-chat, the Android app)
 * put the literal "<url>\n<x xmlns='jabber:x:oob'>...</x>" string inside
 * the plaintext they encrypt. After decryption that text lands in `body`
 * with no real <x> child on the stanza, so it must be recovered by parsing
 * the body text itself, not just by trying stanza.getChild(...).
 */
const INLINE_OOB_URL_RE = /<x\s+xmlns=['"]jabber:x:oob['"]\s*>\s*<url>([^<]+)<\/url>\s*<\/x>/i;

export function extractOobUrl(stanza: Element, body: string): string | null {
  const x = stanza.getChild("x", "jabber:x:oob");
  const url = x?.getChildText("url");
  if (url) return url;
  const trimmed = body.trim();
  if (/^https?:\/\/\S+$/.test(trimmed)) return trimmed;
  const inlineMatch = trimmed.match(INLINE_OOB_URL_RE);
  if (inlineMatch) return inlineMatch[1]!.trim();
  return null;
}

/**
 * Strip a decrypted-OMEMO inline "<x xmlns='jabber:x:oob'>...</x>" fragment
 * out of a body so the agent/user never sees raw XML text — the URL itself
 * (already recovered by extractOobUrl) carries the same information.
 */
export function stripInlineOobMarkup(body: string): string {
  return body.replace(INLINE_OOB_URL_RE, "").trim();
}

/**
 * Voice notes (Conversations/Dino/Monal "hold to record") are short
 * opus/ogg clips, typically well under 1MB; anything larger in an audio
 * MIME type is more likely a shared song/recording.
 */
const VOICE_NOTE_MAX_BYTES = 1_000_000;

export function attachmentLabel(mimeType: string, sizeBytes: number): string {
  const [top, sub] = mimeType.split("/");
  if (top === "audio") {
    const isVoiceCodec = sub === "ogg" || sub === "opus" || mimeType.includes("opus");
    return isVoiceCodec && sizeBytes <= VOICE_NOTE_MAX_BYTES ? "Voice message" : "Audio";
  }
  if (top === "image") return "Photo";
  if (top === "video") return "Video";
  if (mimeType === "application/pdf") return "Document: PDF";
  if (top === "application" || top === "text") return sub ? `Document: ${sub.toUpperCase()}` : "Document";
  return "File";
}

/**
 * Recognise a context-management command (/clear, /compact) in a message
 * body. Matches only a command that begins the message (optionally with
 * trailing args).
 */
export function detectContextCommand(body: string): string | null {
  const trimmed = body.trim();
  if (/^\/clear\b/i.test(trimmed)) return "context cleared";
  if (/^\/compact\b/i.test(trimmed)) return "context compacted";
  return null;
}

// ── XEP-0359 origin-id, XEP-0184 receipts, XEP-0333 markers, XEP-0334 hints ──

/** Build the XEP-0359 `<origin-id/>` element for a stanza id. */
export function buildOriginIdElement(id: string): Element {
  return xml("origin-id", { xmlns: NS_ORIGIN_ID, id });
}

export function getOriginId(stanza: Element): string | undefined {
  const origin = stanza.getChild("origin-id", NS_ORIGIN_ID);
  const id = origin?.attrs.id;
  return typeof id === "string" && id.trim() ? id : undefined;
}

/** Composite XEP-0359 stanza-id key `(by, id)` used for archive dedupe. */
export function getStanzaIdKey(stanza: Element): { by: string; id: string } | null {
  const stanzaId = stanza.getChild("stanza-id", NS_STANZA_ID);
  const id = stanzaId?.attrs.id;
  const by = stanzaId?.attrs.by;
  if (typeof id !== "string" || !id.trim()) return null;
  return { by: typeof by === "string" ? by : "", id };
}

/** XEP-0184 `<request/>` asking the recipient for a delivery receipt. */
export function buildReceiptRequest(): Element {
  return xml("request", { xmlns: NS_RECEIPTS });
}

/** XEP-0184 `<received/>` acknowledging an inbound message by its id. */
export function buildReceiptReceived(to: string, id: string, type: string): Element {
  return xml(
    "message",
    { type, to, id: `oc-rcpt-${id}`.slice(0, 120) },
    xml("received", { xmlns: NS_RECEIPTS, id }),
  );
}

export function hasReceiptRequest(stanza: Element): boolean {
  return Boolean(stanza.getChild("request", NS_RECEIPTS));
}

/** Returns the acked message id carried by a XEP-0184 `<received/>`. */
export function extractReceiptId(stanza: Element): string | undefined {
  const received = stanza.getChild("received", NS_RECEIPTS);
  const id = received?.attrs.id;
  return typeof id === "string" && id.trim() ? id : undefined;
}

export type XmppChatMarker = "received" | "displayed";

export function buildChatMarker(
  to: string,
  id: string,
  marker: XmppChatMarker,
  type: string,
): Element {
  return xml(
    "message",
    { type, to, id: `oc-marker-${marker}-${id}`.slice(0, 120) },
    xml(marker, { xmlns: NS_CHAT_MARKERS, id }),
  );
}

export function extractChatMarker(stanza: Element): { marker: XmppChatMarker; id: string } | null {
  for (const marker of ["received", "displayed"] as const) {
    const child = stanza.getChild(marker, NS_CHAT_MARKERS);
    const id = child?.attrs.id;
    if (typeof id === "string" && id.trim()) return { marker, id };
  }
  return null;
}

/** XEP-0334 hint that a stanza is transient (must not fill MAM/push). */
export function hasNoStoreHint(stanza: Element): boolean {
  return Boolean(stanza.getChild("no-store", NS_HINTS));
}

/** XEP-0334 hint that a stanza must not be carbon-copied to other resources. */
export function hasNoCopyHint(stanza: Element): boolean {
  return Boolean(stanza.getChild("no-copy", NS_HINTS));
}

// ── XEP-0280 carbons unwrapping ──

export type CarbonClassification = {
  /** `sent` carbons must be ignored; `received` ones are unwrapped. */
  kind: "sent" | "received" | "none";
  stanza: Element;
  isCarbonCopy: boolean;
};

/**
 * Classify a XEP-0280 carbon wrapper. A `<sent/>` carbon is a copy of a
 * message this same account already sent from another resource, so it must be
 * ignored (never a turn); a `<received/>` carbon carries the real inbound
 * message and is unwrapped.
 */
export function classifyCarbonStanza(stanza: Element): CarbonClassification {
  if (stanza.getChild("sent", "urn:xmpp:carbons:2")) {
    return { kind: "sent", stanza, isCarbonCopy: false };
  }
  const received = stanza.getChild("received", "urn:xmpp:carbons:2");
  if (received) {
    const inner = received.getChild("forwarded", "urn:xmpp:forward:0")?.getChild("message");
    if (inner) return { kind: "received", stanza: inner, isCarbonCopy: true };
  }
  return { kind: "none", stanza, isCarbonCopy: false };
}


