// Xmpp plugin module implements message adapter behavior.
import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";
import { sendEditXmpp, sendFileXmpp, sendMessageXmpp, sendPayloadXmpp } from "./send.js";
import type { CoreConfig } from "./types.js";

function mediaLoaderOptions(params: Record<string, unknown>) {
  return {
    ...(typeof params.maxBytes === "number" ? { maxBytes: params.maxBytes } : {}),
    ...(params.mediaAccess !== undefined ? { mediaAccess: params.mediaAccess } : {}),
    ...(params.mediaLocalRoots !== undefined ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    ...(params.mediaReadFile !== undefined ? { mediaReadFile: params.mediaReadFile } : {}),
  };
}

export const xmppMessageAdapter = defineChannelMessageAdapter({
  id: "xmpp",
  presentationCapabilities: {
    buttons: true,
    selects: true,
    context: true,
    divider: true,
  },
  renderPresentation: async ({ payload, presentation }) => ({
    ...payload,
    channelData: {
      ...(payload.channelData ?? {}),
      xmpp: {
        ...((payload.channelData?.xmpp as Record<string, unknown> | undefined) ?? {}),
        presentation,
      },
    },
  }),
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      payload: true,
      replyTo: true,
      edit: true,
    },
  },
  send: {
    text: async ({ cfg, to, text, accountId, replyToId }) =>
      await sendMessageXmpp(to, text, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      }),
    // Real XEP-0363 upload (fetch + PUT to an upload slot), falling back to
    // a plain link if no upload component is discoverable. See send.ts's
    // sendFileXmpp doc comment for why this differs from IRC's "just paste
    // the URL as text" media handler.
    media: async (params) => {
      const { cfg, to, text, mediaUrl, accountId, replyToId } = params;
      if (!mediaUrl) {
        return await sendMessageXmpp(to, text, {
          cfg: cfg as CoreConfig,
          accountId: accountId ?? undefined,
          replyTo: replyToId ?? undefined,
        });
      }
      return await sendFileXmpp(to, text, mediaUrl, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
        ...mediaLoaderOptions(params as Record<string, unknown>),
      });
    },
    edit: async ({ cfg, to, text, accountId, editTargetId }) =>
      await sendEditXmpp(to, text, editTargetId, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
      }),
    payload: async (params) => {
      const { cfg, to, text, payload, mediaUrl, accountId, replyToId } = params;
      if (mediaUrl) {
        return await sendFileXmpp(to, text, mediaUrl, {
          cfg: cfg as CoreConfig,
          accountId: accountId ?? undefined,
          replyTo: replyToId ?? undefined,
          ...mediaLoaderOptions(params as Record<string, unknown>),
        });
      }
      return await sendPayloadXmpp(to, text, payload, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      });
    },
  },
});
