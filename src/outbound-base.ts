// Xmpp plugin module implements outbound base behavior.
import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { chunkTextForOutbound } from "./channel-api.js";

export const xmppOutboundBaseAdapter = {
  deliveryMode: "direct" as const,
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown" as const,
  textChunkLimit: 4000,
  presentationCapabilities: {
    buttons: true,
    selects: true,
    context: true,
    divider: true,
  },
  renderPresentation: async ({
    payload,
    presentation,
  }: {
    payload: { channelData?: Record<string, unknown> };
    presentation: unknown;
  }) => ({
    ...payload,
    channelData: {
      ...(payload.channelData ?? {}),
      xmpp: {
        ...((payload.channelData?.xmpp as Record<string, unknown> | undefined) ?? {}),
        presentation,
      },
    },
  }),
  // XMPP <body> is plain text; markdownToPlain() in protocol.ts handles the
  // syntax stripping at send time. Still run the canonical delivery
  // sanitizer first so internal tool traces are dropped before formatting.
  sanitizeText: ({ text }: { text: string }) =>
    sanitizeForPlainText(sanitizeAssistantVisibleText(text)),
};
