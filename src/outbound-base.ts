// Xmpp plugin module implements outbound base behavior.
import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import type { ChannelOutboundPayloadHint } from "openclaw/plugin-sdk/channel-contract";
import { chunkTextForOutbound } from "./channel-api.js";

/**
 * XMPP must retain the deterministic same-chat approval payload UNLESS the
 * native approval runtime (approval-handler.runtime.ts, registered via
 * registerChannelRuntimeContext in monitor.ts) is the one actually delivering
 * it. A shared approval forwarder can accept a request without resolving an
 * XMPP delivery target -- suppressing based on forwarder config alone (the
 * old approach) risked a live approval with no card at all. `hint.nativeRouteActive`
 * is the core's own signal that a native runtime for this channel/account is
 * live right now, so suppressing on it can't produce that failure mode: if
 * the native runtime is active, it IS delivering the compact card.
 */
function shouldSuppressLocalXmppApprovalPrompt(hint?: ChannelOutboundPayloadHint): boolean {
  return hint?.kind === "approval-pending" && hint.nativeRouteActive === true;
}

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
  shouldSuppressLocalPayloadPrompt: ({ hint }: { hint?: ChannelOutboundPayloadHint }) =>
    shouldSuppressLocalXmppApprovalPrompt(hint),
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
