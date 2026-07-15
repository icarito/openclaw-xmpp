// Xmpp plugin module implements protocol behavior: pure helpers ported
// verbatim (behaviorally) from the NanoClaw adapter (src/channels/xmpp.ts).
// Kept dependency-free (no @xmpp/client import) so they stay easily testable.
import { randomUUID } from "node:crypto";
import type { Element } from "@xmpp/xml";

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
 * inbound stanza: either an <x xmlns='jabber:x:oob'><url/> child, or a
 * bare-URL body (common client behavior when sharing a file).
 */
export function extractOobUrl(stanza: Element, body: string): string | null {
  const x = stanza.getChild("x", "jabber:x:oob");
  const url = x?.getChildText("url");
  if (url) return url;
  const trimmed = body.trim();
  if (/^https?:\/\/\S+$/.test(trimmed)) return trimmed;
  return null;
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
