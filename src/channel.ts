// Xmpp plugin module implements channel behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  composeAccountWarningCollectors,
  createAllowlistProviderOpenWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import {
  createChannelDirectoryAdapter,
  createResolvedDirectoryEntriesLister,
} from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  listXmppAccountIds,
  resolveDefaultXmppAccountId,
  resolveXmppAccount,
  type ResolvedXmppAccount,
} from "./accounts.js";
import {
  buildBaseChannelStatusSummary,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  type ChannelPlugin,
} from "./channel-api.js";
import { XmppChannelConfigSchema } from "./config-schema.js";
import { startXmppGatewayAccount } from "./gateway.js";
import { xmppMessageAdapter } from "./message-adapter.js";
import { bareJid, looksLikeXmppTargetId, normalizeXmppAllowEntry, normalizeXmppMessagingTarget, resolveXmppOutboundSessionRoute } from "./normalize.js";
import { xmppOutboundBaseAdapter } from "./outbound-base.js";
import { resolveXmppGroupRequireMention, resolveXmppGroupToolPolicy } from "./policy.js";
import { probeXmpp } from "./probe.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { xmppSetupAdapter } from "./setup-core.js";
import { xmppSetupWizard } from "./setup-surface.js";
import type { CoreConfig, XmppProbe } from "./types.js";

const meta = {
  id: "xmpp",
  label: "XMPP",
  selectionLabel: "XMPP (Jabber JID + password)",
  docsPath: "/channels/xmpp",
  docsLabel: "xmpp",
  blurb: "XMPP/Jabber accounts with 1:1 chat, MUC rooms, and ad-hoc commands.",
  order: 85,
  detailLabel: "XMPP",
  systemImage: "message",
  markdownCapable: false,
};

const loadXmppChannelRuntime = createLazyRuntimeModule(() => import("./channel-runtime.js"));

function normalizePairingTarget(raw: string): string {
  const normalized = normalizeXmppAllowEntry(raw);
  return normalized ? bareJid(normalized) : "";
}

const listXmppDirectoryPeersFromConfig = createResolvedDirectoryEntriesLister<ResolvedXmppAccount>({
  kind: "user",
  resolveAccount: adaptScopedAccountAccessor(resolveXmppAccount),
  resolveSources: (account) => [
    account.config.allowFrom ?? [],
    account.config.groupAllowFrom ?? [],
    ...Object.values(account.config.groups ?? {}).map((group) => group.allowFrom ?? []),
  ],
  normalizeId: (entry) => normalizePairingTarget(entry) || null,
});

const listXmppDirectoryGroupsFromConfig = createResolvedDirectoryEntriesLister<ResolvedXmppAccount>({
  kind: "group",
  resolveAccount: adaptScopedAccountAccessor(resolveXmppAccount),
  resolveSources: (account) => [account.config.mucRooms ?? [], Object.keys(account.config.groups ?? {})],
  normalizeId: (entry) => {
    const normalized = normalizeXmppMessagingTarget(entry);
    return normalized ? bareJid(normalized) : null;
  },
});

const xmppConfigAdapter = createScopedChannelConfigAdapter<ResolvedXmppAccount, ResolvedXmppAccount>({
  sectionKey: "xmpp",
  listAccountIds: listXmppAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveXmppAccount),
  defaultAccountId: resolveDefaultXmppAccountId,
  clearBaseFields: ["name", "jid", "password", "passwordFile", "service", "resource", "mucDomain", "mucRooms"],
  resolveAllowFrom: (account: ResolvedXmppAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: normalizeXmppAllowEntry,
    }),
  resolveDefaultTo: (account: ResolvedXmppAccount) => account.config.defaultTo,
});

const resolveXmppDmPolicy = createScopedDmSecurityResolver<ResolvedXmppAccount>({
  channelKey: "xmpp",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => normalizeXmppAllowEntry(raw),
});

const collectXmppGroupPolicyWarnings =
  createAllowlistProviderOpenWarningCollector<ResolvedXmppAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.xmpp !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    buildOpenWarning: {
      surface: "XMPP rooms",
      openBehavior: "allows all rooms and senders (mention-gated)",
      remediation: 'Prefer channels.xmpp.groupPolicy="allowlist" with channels.xmpp.groups',
    },
  });

const collectXmppSecurityWarnings = composeAccountWarningCollectors<
  ResolvedXmppAccount,
  {
    account: ResolvedXmppAccount;
    cfg: CoreConfig;
  }
>(
  collectXmppGroupPolicyWarnings,
  (account) =>
    !account.config.mucDomain &&
    (account.config.mucRooms?.length ?? 0) > 0 &&
    "- channels.xmpp.mucRooms is set but channels.xmpp.mucDomain is empty; rooms will not be recognized as groups (outbound replies will use type=chat instead of type=groupchat).",
);

export const xmppPlugin: ChannelPlugin<ResolvedXmppAccount, XmppProbe> = createChatChannelPlugin({
  base: {
    id: "xmpp",
    meta: {
      ...meta,
      quickstartAllowFrom: true,
    },
    setup: xmppSetupAdapter,
    setupWizard: xmppSetupWizard,
    capabilities: {
      chatTypes: ["direct", "group"],
      media: true,
      blockStreaming: true,
      nativeCommands: true,
    },
    reload: { configPrefixes: ["channels.xmpp"] },
    configSchema: XmppChannelConfigSchema,
    config: {
      ...xmppConfigAdapter,
      hasConfiguredState: ({ env }) =>
        typeof env?.XMPP_JID === "string" &&
        env.XMPP_JID.trim().length > 0 &&
        typeof env?.XMPP_PASSWORD === "string" &&
        env.XMPP_PASSWORD.trim().length > 0,
      isConfigured: (account) => account.configured,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            jid: account.jid,
            service: account.service,
            mucDomain: account.mucDomain,
            passwordSource: account.passwordSource,
          },
        }),
    },
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
    doctor: {
      groupAllowFromFallbackToAllowFrom: false,
      collectMutableAllowlistWarnings: () => [],
    },
    groups: {
      resolveRequireMention: ({ cfg, accountId, groupId }) => {
        const account = resolveXmppAccount({ cfg: cfg as CoreConfig, accountId });
        if (!groupId) {
          return true;
        }
        return resolveXmppGroupRequireMention({ groups: account.config.groups, target: groupId });
      },
      resolveToolPolicy: ({ cfg, accountId, groupId }) => {
        const account = resolveXmppAccount({ cfg: cfg as CoreConfig, accountId });
        if (!groupId) {
          return undefined;
        }
        return resolveXmppGroupToolPolicy({ groups: account.config.groups, target: groupId });
      },
    },
    messaging: {
      targetPrefixes: ["xmpp"],
      normalizeTarget: normalizeXmppMessagingTarget,
      resolveOutboundSessionRoute: (params) =>
        resolveXmppOutboundSessionRoute({
          ...params,
          mucDomain: resolveXmppAccount({ cfg: params.cfg as CoreConfig, accountId: params.accountId }).mucDomain,
        }),
      targetResolver: {
        looksLikeId: looksLikeXmppTargetId,
        hint: "<user@domain|room@conference.domain>",
      },
    },
    message: xmppMessageAdapter,
    resolver: {
      resolveTargets: async ({ inputs, kind }) => {
        return inputs.map((input) => {
          const normalized = normalizeXmppMessagingTarget(input);
          if (!normalized) {
            return {
              input,
              resolved: false,
              note: "invalid XMPP target",
            };
          }
          const bare = bareJid(normalized);
          if (kind === "group") {
            return {
              input,
              resolved: true,
              id: bare,
              name: bare,
            };
          }
          return {
            input,
            resolved: true,
            id: bare,
            name: bare,
          };
        });
      },
    },
    directory: createChannelDirectoryAdapter({
      listPeers: async (params) => listXmppDirectoryPeersFromConfig(params),
      listGroups: async (params) => {
        const entries = await listXmppDirectoryGroupsFromConfig(params);
        return entries.map((entry) => Object.assign({}, entry, { name: entry.id }));
      },
    }),
    status: createComputedAccountStatusAdapter<ResolvedXmppAccount, XmppProbe>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      buildChannelSummary: ({ account, snapshot }) => ({
        ...buildBaseChannelStatusSummary(snapshot),
        jid: account.jid,
        service: account.service,
        mucDomain: account.mucDomain,
        probe: snapshot.probe,
        lastProbeAt: snapshot.lastProbeAt ?? null,
      }),
      probeAccount: async ({ cfg, account, timeoutMs }) =>
        probeXmpp(cfg as CoreConfig, { accountId: account.accountId, timeoutMs }),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        extra: {
          jid: account.jid,
          service: account.service,
          mucDomain: account.mucDomain,
          passwordSource: account.passwordSource,
        },
      }),
    }),
    gateway: {
      startAccount: async (ctx) =>
        await startXmppGatewayAccount({
          ...ctx,
          cfg: ctx.cfg as CoreConfig,
        }),
    },
    // XEP-0085 chat state notifications. Same plugin-SDK heartbeat hook
    // Matrix wires to its own sendTypingMatrix (see extensions/matrix/src/
    // channel.ts's `heartbeat` block) -- ported from xmpp.ts's setTyping(),
    // which sent <composing/> while the agent was working and relied on
    // deliver() to send <active/> once the reply landed (sendMessageXmpp
    // already does that <active/> clear; clearTyping below is for the case
    // where a turn ends with no outbound message, e.g. a silent/errored turn).
    heartbeat: {
      sendTyping: async ({ cfg, to, accountId }) => {
        const { sendTypingXmpp } = await loadXmppChannelRuntime();
        await sendTypingXmpp(to, { cfg: cfg as CoreConfig, accountId: accountId ?? undefined });
      },
      clearTyping: async ({ cfg, to, accountId }) => {
        const { clearTypingXmpp } = await loadXmppChannelRuntime();
        await clearTypingXmpp(to, { cfg: cfg as CoreConfig, accountId: accountId ?? undefined });
      },
    },
  },
  pairing: {
    text: {
      idLabel: "xmppUser",
      message: PAIRING_APPROVED_MESSAGE,
      normalizeAllowEntry: (entry) => normalizeXmppAllowEntry(entry),
      notify: async ({ cfg, id, message }) => {
        const target = normalizePairingTarget(id);
        if (!target) {
          throw new Error(`invalid XMPP pairing id: ${id}`);
        }
        const { sendMessageXmpp } = await loadXmppChannelRuntime();
        await sendMessageXmpp(target, message, {
          cfg: cfg as CoreConfig,
        });
      },
    },
  },
  security: {
    resolveDmPolicy: resolveXmppDmPolicy,
    collectWarnings: collectXmppSecurityWarnings,
  },
  outbound: {
    base: xmppOutboundBaseAdapter,
    attachedResults: {
      channel: "xmpp",
      sendText: async ({ cfg, to, text, accountId, replyToId }) => {
        const { sendMessageXmpp } = await loadXmppChannelRuntime();
        return await sendMessageXmpp(to, text, {
          cfg: cfg as CoreConfig,
          accountId: accountId ?? undefined,
          replyTo: replyToId ?? undefined,
        });
      },
      sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId }) => {
        if (!mediaUrl) {
          const { sendMessageXmpp } = await loadXmppChannelRuntime();
          return await sendMessageXmpp(to, text, {
            cfg: cfg as CoreConfig,
            accountId: accountId ?? undefined,
            replyTo: replyToId ?? undefined,
          });
        }
        const { sendFileXmpp } = await loadXmppChannelRuntime();
        return await sendFileXmpp(to, text, mediaUrl, {
          cfg: cfg as CoreConfig,
          accountId: accountId ?? undefined,
          replyTo: replyToId ?? undefined,
        });
      },
    },
  },
});
