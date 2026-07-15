// Xmpp plugin module implements send behavior.
import { client, xml } from "@xmpp/client";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { resolveXmppAccount } from "./accounts.js";
import { bareJid, isGroupJid, normalizeXmppMessagingTarget } from "./normalize.js";
import { attachmentLabel, markdownToPlain, nextStanzaId, splitForLimit, XMPP_MAX_BODY } from "./protocol.js";
import { getXmppRuntime } from "./runtime.js";
import { getActiveXmppConnection } from "./connection-registry.js";
import { uploadFileXmpp } from "./upload.js";
import type { CoreConfig } from "./types.js";

type SendXmppOptions = {
  cfg: CoreConfig;
  accountId?: string;
  replyTo?: string;
  target?: string;
};

type SendXmppMediaOptions = SendXmppOptions & {
  /** Options forwarded to loadOutboundMediaFromUrl, matching the Matrix plugin's media fetch path. */
  maxBytes?: number;
  mediaAccess?: unknown;
  mediaLocalRoots?: unknown;
  mediaReadFile?: unknown;
};

type SendXmppResult = {
  messageId: string;
  target: string;
  receipt: MessageReceipt;
};

function recordXmppOutboundActivity(accountId: string): void {
  try {
    getXmppRuntime().channel.activity.record({
      channel: "xmpp",
      accountId,
      direction: "outbound",
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "XMPP runtime not initialized") {
      throw error;
    }
  }
}

function resolveTarget(to: string, opts?: SendXmppOptions): string {
  const fromArg = normalizeXmppMessagingTarget(to);
  if (fromArg) {
    return bareJid(fromArg);
  }
  const fromOpt = normalizeXmppMessagingTarget(opts?.target ?? "");
  if (fromOpt) {
    return bareJid(fromOpt);
  }
  throw new Error(`Invalid XMPP target: ${to}`);
}

/**
 * Send (or XEP-0308 correct) a text message to `to`. Mirrors the NanoClaw
 * adapter's deliver() text path: markdown -> plain, XMPP_MAX_BODY chunking,
 * and an edit path when replyTo is actually an editTargetId (see note on
 * `operation` below — this plugin's message-adapter passes edits through a
 * distinct call, see send.ts's sendEditXmpp).
 */
export async function sendMessageXmpp(
  to: string,
  text: string,
  opts: SendXmppOptions,
): Promise<SendXmppResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "XMPP send") as CoreConfig;
  const account = resolveXmppAccount({
    cfg,
    accountId: opts.accountId,
  });

  if (!account.configured) {
    throw new Error(
      `XMPP is not configured for account "${account.accountId}" (need jid and password in channels.xmpp).`,
    );
  }

  const target = resolveTarget(to, opts);
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "xmpp",
    accountId: account.accountId,
  });
  const prepared = convertMarkdownTables(text.trim(), tableMode);
  const plain = markdownToPlain(prepared);
  if (!plain.trim()) {
    throw new Error("Message must be non-empty for XMPP sends");
  }

  let connection = getActiveXmppConnection(account.accountId);
  const type = isGroupJid(target, account.mucDomain) ? "groupchat" : "chat";

  let transientCleanup: (() => Promise<void>) | null = null;
  if (!connection?.isConnected() && type === "chat") {
    const domain = account.jid.split("@")[1]!;
    const localpart = account.jid.split("@")[0]!;
    const transient = client({
      service: account.service,
      domain,
      username: localpart,
      password: account.password,
      resource: account.resource || "openclaw",
    });
    await transient.start();
    connection = {
      xmpp: transient,
      isConnected: () => true,
      send: async (stanza) => { await transient.send(stanza); },
      joinRoom: () => {},
      stop: async () => { await transient.stop(); },
    };
    transientCleanup = async () => { await transient.stop(); };
  }

  let firstId: string | undefined;
  if (connection?.isConnected()) {
    const chunks = splitForLimit(plain, XMPP_MAX_BODY);
    for (let i = 0; i < chunks.length; i++) {
      const id = nextStanzaId();
      if (i === 0) firstId = id;
      await connection.send(xml("message", { type, to: target, id }, xml("body", {}, chunks[i]!)));
    }
    try {
      await connection.send(
        xml("message", { type, to: target }, xml("active", { xmlns: "http://jabber.org/protocol/chatstates" })),
      );
    } catch {
      // best-effort
    }
  } else {
    throw new Error(
      `XMPP account "${account.accountId}" has no active connection (transient send is not supported for a persistent-presence channel like XMPP/MUC).`,
    );
  }

  try {
    await transientCleanup?.();
  } catch {
    // best-effort shutdown
  }

  recordXmppOutboundActivity(account.accountId);

  const messageId = firstId ?? nextStanzaId();
  return {
    messageId,
    target,
    receipt: createMessageReceiptFromOutboundResults({
      results: [
        {
          channel: "xmpp",
          messageId,
          conversationId: target,
        },
      ],
      kind: "text",
      ...(opts.replyTo ? { replyToId: opts.replyTo } : {}),
    }),
  };
}

/**
 * Send a file as a real XEP-0363 HTTP Upload (fetch the media OpenClaw
 * resolved for us via loadOutboundMediaFromUrl, PUT it to an upload slot,
 * then send a <message> with the download URL as an XEP-0066 OOB link plus
 * a caption). Mirrors the file-attachment branch in the NanoClaw adapter's
 * deliver() (src/channels/xmpp.ts), and follows the same integration
 * pattern the Matrix plugin uses for its own media upload (fetch via the
 * SDK helper, then hand the buffer to the channel's native upload API).
 *
 * Falls back to embedding the OpenClaw-hosted mediaUrl as a plain link if
 * no XEP-0363 upload component is discoverable via disco (some servers
 * don't run one), so media is never silently dropped.
 */
export async function sendFileXmpp(
  to: string,
  text: string,
  mediaUrl: string,
  opts: SendXmppMediaOptions,
): Promise<SendXmppResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "XMPP media send") as CoreConfig;
  const account = resolveXmppAccount({ cfg, accountId: opts.accountId });
  if (!account.configured) {
    throw new Error(`XMPP is not configured for account "${account.accountId}".`);
  }
  const target = resolveTarget(to, opts);
  const connection = getActiveXmppConnection(account.accountId);
  if (!connection?.isConnected()) {
    throw new Error(`XMPP account "${account.accountId}" has no active connection.`);
  }
  const type = isGroupJid(target, account.mucDomain) ? "groupchat" : "chat";
  const caption = markdownToPlain(text.trim());
  const domain = account.jid.split("@")[1]!;

  const media = await loadOutboundMediaFromUrl(mediaUrl, {
    maxBytes: opts.maxBytes,
    mediaAccess: opts.mediaAccess,
    mediaLocalRoots: opts.mediaLocalRoots,
    mediaReadFile: opts.mediaReadFile,
  } as never);

  const filename = media.fileName ?? mediaUrl.split("/").pop()?.split("?")[0] ?? "file";
  const id = nextStanzaId();

  const uploadResult = await uploadFileXmpp(connection.xmpp, domain, filename, media.buffer);
  if (!uploadResult.ok) {
    // No upload component, or the PUT failed -- degrade to a plain link
    // rather than silently dropping the attachment.
    const fallbackText = caption
      ? `${caption}\n\n[${filename} — upload unavailable] ${mediaUrl}`
      : `[${filename} — upload unavailable] ${mediaUrl}`;
    await connection.send(xml("message", { type, to: target, id }, xml("body", {}, fallbackText)));
    recordXmppOutboundActivity(account.accountId);
    return {
      messageId: id,
      target,
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "xmpp", messageId: id, conversationId: target }],
        kind: "media",
      }),
    };
  }

  const label = attachmentLabel(media.contentType ?? "application/octet-stream", media.buffer.length);
  const bodyText = caption
    ? `${caption}\n\n[${label}] ${filename}: ${uploadResult.getUrl}`
    : `[${label}] ${filename}: ${uploadResult.getUrl}`;
  await connection.send(
    xml(
      "message",
      { type, to: target, id },
      xml("body", {}, bodyText),
      xml("x", { xmlns: "jabber:x:oob" }, xml("url", {}, uploadResult.getUrl)),
    ),
  );
  recordXmppOutboundActivity(account.accountId);

  return {
    messageId: id,
    target,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "xmpp", messageId: id, conversationId: target }],
      kind: "media",
    }),
  };
}

/**
 * XEP-0308 Last Message Correction: send a NEW stanza (own fresh id)
 * carrying <replace id='ORIGINAL'/>. Corrections must be a single stanza —
 * if the edited body exceeds XMPP_MAX_BODY we truncate to the first chunk
 * (edits are typically short status updates, not full responses). Mirrors
 * xmpp.ts deliver()'s operation === 'edit' branch.
 */
export async function sendEditXmpp(
  to: string,
  text: string,
  editTargetId: string,
  opts: SendXmppOptions,
): Promise<SendXmppResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "XMPP edit") as CoreConfig;
  const account = resolveXmppAccount({ cfg, accountId: opts.accountId });
  if (!account.configured) {
    throw new Error(`XMPP is not configured for account "${account.accountId}".`);
  }
  const target = resolveTarget(to, opts);
  const plain = markdownToPlain(text.trim());
  const connection = getActiveXmppConnection(account.accountId);
  if (!connection?.isConnected()) {
    throw new Error(`XMPP account "${account.accountId}" has no active connection.`);
  }
  const type = isGroupJid(target, account.mucDomain) ? "groupchat" : "chat";
  const id = nextStanzaId();
  const body = plain.length > XMPP_MAX_BODY ? splitForLimit(plain, XMPP_MAX_BODY)[0]! : plain;
  await connection.send(
    xml(
      "message",
      { type, to: target, id },
      xml("body", {}, body),
      xml("replace", { xmlns: "urn:xmpp:message-correct:0", id: editTargetId }),
    ),
  );
  recordXmppOutboundActivity(account.accountId);
  return {
    messageId: id,
    target,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "xmpp", messageId: id, conversationId: target }],
      kind: "text",
    }),
  };
}
