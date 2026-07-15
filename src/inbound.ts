// Xmpp plugin module implements inbound behavior.
//
// This follows the SAME core.channel.inbound.dispatchReply pattern IRC's
// src/inbound.ts uses (channel ingress resolver -> pairing -> route/envelope
// -> dispatchReply). Only the identity model differs: XMPP has one stable
// identity per message (the bare JID from a sealed s2s/c2s `from`), so there
// is no nick/user/host tri-state to reconcile the way IRC's ircIngressIdentity
// aliases do.
import { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
import {
  channelIngressRoutes,
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-outbound";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import {
  deliverFormattedTextWithAttachments,
  type OutboundReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedXmppAccount } from "./accounts.js";
import { bareJid, buildXmppAllowlistCandidates, normalizeXmppAllowEntry } from "./normalize.js";
import { resolveXmppGroupMatch, resolveXmppGroupRequireMention } from "./policy.js";
import { getXmppRuntime } from "./runtime.js";
import { sendMessageXmpp } from "./send.js";
import type { CoreConfig, XmppInboundMessage } from "./types.js";

const CHANNEL_ID = "xmpp" as const;
type XmppGroupPolicy = "open" | "allowlist" | "disabled";

const xmppIngressIdentity = defineStableChannelIngressIdentity({
  key: "xmpp-jid",
  normalizeEntry: normalizeXmppAllowEntry,
  normalizeSubject: normalizeLowercaseStringOrEmpty,
  sensitivity: "pii",
  aliases: [],
  isWildcardEntry: (entry) => normalizeXmppAllowEntry(entry) === "*",
  resolveEntryId: ({ entryIndex }) => `xmpp-entry-${entryIndex + 1}:jid`,
});

function createXmppIngressSubject(message: XmppInboundMessage) {
  const candidates = buildXmppAllowlistCandidates(message.senderJid);
  return {
    stableId: candidates[0] ?? "",
    aliases: {},
  };
}

function routeDescriptorsForXmppGroup(params: {
  isGroup: boolean;
  groupPolicy: XmppGroupPolicy;
  groupAllowed: boolean;
  hasConfiguredGroups: boolean;
  groupEnabled: boolean;
  routeGroupAllowFrom: string[];
}) {
  if (!params.isGroup) {
    return [];
  }
  return channelIngressRoutes(
    params.groupPolicy === "allowlist" && {
      id: "xmpp:room",
      allowed: params.hasConfiguredGroups && params.groupAllowed,
      precedence: 0,
      matchId: "xmpp-room",
      blockReason: "channel_not_allowlisted",
    },
    !params.groupEnabled && {
      id: "xmpp:room-enabled",
      enabled: false,
      precedence: 10,
      blockReason: "channel_disabled",
    },
    params.routeGroupAllowFrom.length > 0 && {
      id: "xmpp:room-sender",
      precedence: 20,
      senderPolicy: "replace",
      senderAllowFrom: params.routeGroupAllowFrom,
    },
  );
}

async function deliverXmppReply(params: {
  payload: OutboundReplyPayload;
  cfg: CoreConfig;
  target: string;
  accountId: string;
  sendReply?: (target: string, text: string, replyToId?: string) => Promise<void>;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}) {
  await deliverFormattedTextWithAttachments({
    payload: params.payload,
    send: async ({ text, replyToId }) => {
      if (params.sendReply) {
        await params.sendReply(params.target, text, replyToId);
      } else {
        await sendMessageXmpp(params.target, text, {
          cfg: params.cfg,
          accountId: params.accountId,
          replyTo: replyToId,
        });
      }
      params.statusSink?.({ lastOutboundAt: Date.now() });
    },
  });
}

export async function handleXmppInbound(params: {
  message: XmppInboundMessage;
  account: ResolvedXmppAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  sendReply?: (target: string, text: string, replyToId?: string) => Promise<void>;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getXmppRuntime();
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }

  statusSink?.({ lastInboundAt: message.timestamp });

  const senderDisplay = message.senderNick
    ? `${message.senderNick} <${message.senderJid}>`
    : message.senderJid;
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: config.channels?.xmpp !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "xmpp",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.channel,
    log: (messageLocal) => runtime.log?.(messageLocal),
  });

  const groupMatch = resolveXmppGroupMatch({
    groups: account.config.groups,
    target: message.target,
  });

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const requireMention = message.isGroup
    ? resolveXmppGroupRequireMention({ groups: account.config.groups, target: message.target })
    : false;
  const wasMentioned =
    core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes) || message.wasMentioned;
  const routeGroupAllowFrom = normalizeStringEntries(
    groupMatch.groupConfig?.allowFrom?.length
      ? groupMatch.groupConfig.allowFrom
      : groupMatch.wildcardConfig?.allowFrom,
  );
  const accessGroupPolicy: XmppGroupPolicy =
    groupPolicy === "open" &&
    (routeGroupAllowFrom.length > 0 || (account.config.groupAllowFrom?.length ?? 0) > 0)
      ? "allowlist"
      : groupPolicy;
  const access = await createChannelIngressResolver({
    channelId: CHANNEL_ID,
    accountId: account.accountId,
    identity: xmppIngressIdentity,
    cfg: config as OpenClawConfig,
    readStoreAllowFrom: async () => await pairing.readAllowFromStore(),
  }).message({
    subject: createXmppIngressSubject(message),
    conversation: {
      kind: message.isGroup ? "group" : "direct",
      id: message.target,
    },
    route: routeDescriptorsForXmppGroup({
      isGroup: message.isGroup,
      groupPolicy,
      groupAllowed: groupMatch.allowed,
      hasConfiguredGroups: groupMatch.hasConfiguredGroups,
      groupEnabled:
        groupMatch.groupConfig?.enabled !== false && groupMatch.wildcardConfig?.enabled !== false,
      routeGroupAllowFrom,
    }),
    mentionFacts: message.isGroup
      ? {
          canDetectMention: true,
          wasMentioned,
          hasAnyMention: wasMentioned,
        }
      : undefined,
    dmPolicy,
    groupPolicy: accessGroupPolicy,
    policy: {
      groupAllowFromFallbackToAllowFrom: false,
      mutableIdentifierMatching: allowNameMatching ? "enabled" : "disabled",
      activation: {
        requireMention: message.isGroup && requireMention,
        allowTextCommands,
      },
    },
    allowFrom: account.config.allowFrom,
    groupAllowFrom: account.config.groupAllowFrom,
    command: {
      allowTextCommands,
      hasControlCommand,
    },
  });
  const commandAuthorized = access.commandAccess.authorized;

  if (access.ingress.admission === "pairing-required") {
    await pairing.issueChallenge({
      senderId: normalizeLowercaseStringOrEmpty(bareJid(message.senderJid)),
      senderIdLine: `Your XMPP JID: ${senderDisplay}`,
      meta: { name: message.senderNick || undefined },
      sendPairingReply: async (text) => {
        await deliverXmppReply({
          payload: { text },
          cfg: config,
          target: bareJid(message.senderJid),
          accountId: account.accountId,
          sendReply: params.sendReply,
          statusSink,
        });
      },
      onReplyError: (err) => {
        runtime.error?.(`xmpp: pairing reply failed for ${senderDisplay}: ${String(err)}`);
      },
    });
    runtime.log?.(`xmpp: drop DM sender ${senderDisplay} (dmPolicy=${dmPolicy})`);
    return;
  }
  if (access.ingress.admission === "skip") {
    runtime.log?.(`xmpp: drop room ${message.target} (missing-mention)`);
    return;
  }
  if (access.ingress.admission !== "dispatch") {
    if (
      message.isGroup &&
      access.ingress.decisiveGateId === "command" &&
      access.commandAccess.shouldBlockControlCommand
    ) {
      logInboundDrop({
        log: (line) => runtime.log?.(line),
        channel: CHANNEL_ID,
        reason: "control command (unauthorized)",
        target: senderDisplay,
      });
      return;
    }
    if (message.isGroup) {
      if (access.routeAccess.reason === "channel_not_allowlisted") {
        runtime.log?.(`xmpp: drop room ${message.target} (not allowlisted)`);
      } else if (access.routeAccess.reason === "channel_disabled") {
        runtime.log?.(`xmpp: drop room ${message.target} (disabled)`);
      } else {
        runtime.log?.(`xmpp: drop group sender ${senderDisplay} (policy=${groupPolicy})`);
      }
    } else {
      runtime.log?.(`xmpp: drop DM sender ${senderDisplay} (dmPolicy=${dmPolicy})`);
    }
    return;
  }

  const peerId = message.target;
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: message.isGroup ? "group" : "direct",
      id: peerId,
    },
    runtime: core.channel,
    sessionStore: config.session?.store,
  });

  const fromLabel = message.isGroup ? message.target : senderDisplay;
  const { storePath, body } = buildEnvelope({
    channel: "XMPP",
    from: fromLabel,
    timestamp: message.timestamp,
    body: rawBody,
  });

  const groupSystemPrompt = normalizeOptionalString(groupMatch.groupConfig?.systemPrompt);
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(account.config);

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: message.isGroup ? `channel:${message.target}` : `xmpp:${senderDisplay}`,
    To: message.isGroup ? `channel:${message.target}` : `xmpp:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: message.isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: message.senderNick || undefined,
    SenderId: senderDisplay,
    GroupSubject: message.isGroup ? message.target : undefined,
    GroupSystemPrompt: message.isGroup ? groupSystemPrompt : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: message.isGroup ? wasMentioned : undefined,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: message.isGroup ? `channel:${message.target}` : `xmpp:${peerId}`,
    CommandAuthorized: commandAuthorized,
  });

  await core.channel.inbound.dispatchReply({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    agentId: route.agentId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: core.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher: core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    delivery: {
      deliver: async (payload) => {
        await deliverXmppReply({
          payload,
          cfg: config,
          target: peerId,
          accountId: account.accountId,
          sendReply: params.sendReply,
          statusSink,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`xmpp ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyPipeline: {},
    replyOptions: {
      skillFilter: groupMatch.groupConfig?.skills,
      disableBlockStreaming:
        typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : undefined,
    },
    record: {
      onRecordError: (err) => {
        runtime.error?.(`xmpp: failed updating session meta: ${String(err)}`);
      },
    },
  });
}
