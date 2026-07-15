// Xmpp plugin module implements message adapter behavior.
import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";
import { sendEditXmpp, sendFileXmpp, sendMessageXmpp } from "./send.js";
import type { CoreConfig } from "./types.js";

export const xmppMessageAdapter = defineChannelMessageAdapter({
  id: "xmpp",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
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
    media: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) => {
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
      });
    },
    edit: async ({ cfg, to, text, accountId, editTargetId }) =>
      await sendEditXmpp(to, text, editTargetId, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
      }),
  },
});
