// Xmpp plugin module implements outbound base behavior.
import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { chunkTextForOutbound } from "./channel-api.js";

export const xmppOutboundBaseAdapter = {
  deliveryMode: "direct" as const,
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown" as const,
  textChunkLimit: 4000,
  // XMPP <body> is plain text; markdownToPlain() in protocol.ts handles the
  // syntax stripping at send time. Still run the canonical delivery
  // sanitizer first so internal tool traces are dropped before formatting.
  sanitizeText: ({ text }: { text: string }) =>
    sanitizeForPlainText(sanitizeAssistantVisibleText(text)),
};
