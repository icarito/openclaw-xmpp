// Xmpp plugin module implements setup surface behavior.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import type { ChannelSetupDmPolicy, ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import {
  createAllowFromSection,
  createPromptParsedAllowFromForAccount,
  createSetupTranslator,
  createStandardChannelSetupStatus,
  formatDocsLink,
  setSetupChannelEnabled,
} from "openclaw/plugin-sdk/setup";
import {
  normalizeOptionalString,
  normalizeStringEntries,
  normalizeStringifiedOptionalString,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultXmppAccountId, resolveXmppAccount } from "./accounts.js";
import { bareJid, normalizeXmppAllowEntry, normalizeXmppMessagingTarget } from "./normalize.js";
import {
  setXmppAllowFrom,
  setXmppDmPolicy,
  setXmppGroupAccess,
  updateXmppAccountConfig,
  xmppSetupAdapter,
} from "./setup-core.js";
import type { CoreConfig } from "./types.js";

const t = createSetupTranslator();

const channel = "xmpp" as const;
const USE_ENV_FLAG = "__xmppUseEnv";

function parseListInput(raw: string): string[] {
  return normalizeStringEntries(raw.split(/[\n,;]+/g));
}

function normalizeGroupEntry(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === "*") return "*";
  const normalized = normalizeXmppMessagingTarget(trimmed) ?? trimmed;
  return bareJid(normalized);
}

const promptXmppAllowFrom = createPromptParsedAllowFromForAccount<CoreConfig>({
  defaultAccountId: (cfg) => resolveDefaultXmppAccountId(cfg),
  noteTitle: t("wizard.xmpp.allowlistTitle"),
  noteLines: [
    t("wizard.xmpp.allowlistIntro"),
    t("wizard.xmpp.examples"),
    "- alice@example.org",
    t("wizard.xmpp.multipleEntries"),
  ],
  message: t("wizard.xmpp.allowFromPrompt"),
  placeholder: "alice@example.org, bob@example.org",
  parseEntries: (raw) => ({
    entries: normalizeStringEntries(parseListInput(raw).map((entry) => normalizeXmppAllowEntry(entry))),
  }),
  getExistingAllowFrom: ({ cfg }) => cfg.channels?.xmpp?.allowFrom ?? [],
  applyAllowFrom: ({ cfg, allowFrom }) => setXmppAllowFrom(cfg, allowFrom),
});

const xmppDmPolicy: ChannelSetupDmPolicy = {
  label: "XMPP",
  channel,
  policyKey: "channels.xmpp.dmPolicy",
  allowFromKey: "channels.xmpp.allowFrom",
  getCurrent: (cfg) => (cfg as CoreConfig).channels?.xmpp?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setXmppDmPolicy(cfg as CoreConfig, policy),
  promptAllowFrom: async ({ cfg, prompter, accountId }) =>
    await promptXmppAllowFrom({ cfg: cfg as CoreConfig, prompter, accountId }),
};

export const xmppSetupWizard: ChannelSetupWizard = {
  channel,
  status: createStandardChannelSetupStatus({
    channelLabel: "XMPP",
    configuredLabel: t("wizard.channels.statusConfigured"),
    unconfiguredLabel: t("wizard.channels.statusNeedsHostNick"),
    configuredHint: t("wizard.channels.statusConfigured"),
    unconfiguredHint: t("wizard.channels.statusNeedsHostNick"),
    configuredScore: 1,
    unconfiguredScore: 0,
    includeStatusLine: true,
    resolveConfigured: ({ cfg, accountId }) =>
      resolveXmppAccount({ cfg: cfg as CoreConfig, accountId }).configured,
  }),
  introNote: {
    title: t("wizard.xmpp.setupTitle"),
    lines: [
      t("wizard.xmpp.helpNeedsJidPassword"),
      t("wizard.xmpp.helpMucOptional"),
      t("wizard.xmpp.helpGroupControl"),
      t("wizard.xmpp.helpMentionGate"),
      t("wizard.xmpp.helpEnvVars"),
      `Docs: ${formatDocsLink("/channels/xmpp", "channels/xmpp")}`,
    ],
    shouldShow: ({ cfg, accountId }) => !resolveXmppAccount({ cfg: cfg as CoreConfig, accountId }).configured,
  },
  prepare: async ({ cfg, accountId, credentialValues, prompter }) => {
    const resolved = resolveXmppAccount({ cfg: cfg as CoreConfig, accountId });
    const isDefaultAccount = accountId === DEFAULT_ACCOUNT_ID;
    const envJid = isDefaultAccount ? (normalizeOptionalString(process.env.XMPP_JID) ?? "") : "";
    const envPassword = isDefaultAccount ? (normalizeOptionalString(process.env.XMPP_PASSWORD) ?? "") : "";
    const envReady = Boolean(envJid && envPassword && !resolved.config.jid && !resolved.config.password);

    if (envReady) {
      const useEnv = await prompter.confirm({
        message: t("wizard.xmpp.envPrompt"),
        initialValue: true,
      });
      if (useEnv) {
        return {
          cfg: updateXmppAccountConfig(cfg as CoreConfig, accountId, { enabled: true }),
          credentialValues: { ...credentialValues, [USE_ENV_FLAG]: "1" },
        };
      }
    }

    return {
      cfg: updateXmppAccountConfig(cfg as CoreConfig, accountId, { enabled: true }),
      credentialValues: { ...credentialValues, [USE_ENV_FLAG]: "0" },
    };
  },
  credentials: [],
  textInputs: [
    {
      inputKey: "token",
      message: t("wizard.xmpp.jidPrompt"),
      currentValue: ({ cfg, accountId }) =>
        resolveXmppAccount({ cfg: cfg as CoreConfig, accountId }).config.jid || undefined,
      shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
      validate: ({ value }) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
      normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
      applySet: async ({ cfg, accountId, value }) =>
        updateXmppAccountConfig(cfg as CoreConfig, accountId, { enabled: true, jid: value }),
    },
    {
      inputKey: "httpHost",
      message: t("wizard.xmpp.servicePrompt"),
      placeholder: "xmpp://127.0.0.1:5222",
      required: false,
      applyEmptyValue: true,
      currentValue: ({ cfg, accountId }) =>
        resolveXmppAccount({ cfg: cfg as CoreConfig, accountId }).config.service || undefined,
      shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
      normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
      applySet: async ({ cfg, accountId, value }) =>
        updateXmppAccountConfig(cfg as CoreConfig, accountId, { enabled: true, service: value || undefined }),
    },
    {
      inputKey: "userId",
      message: t("wizard.xmpp.mucDomainPrompt"),
      placeholder: "conference.example.org",
      required: false,
      applyEmptyValue: true,
      currentValue: ({ cfg, accountId }) =>
        resolveXmppAccount({ cfg: cfg as CoreConfig, accountId }).config.mucDomain || undefined,
      shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
      normalizeValue: ({ value }) => normalizeStringifiedOptionalString(value) ?? "",
      applySet: async ({ cfg, accountId, value }) =>
        updateXmppAccountConfig(cfg as CoreConfig, accountId, { enabled: true, mucDomain: value || undefined }),
    },
    {
      inputKey: "groupChannels",
      message: t("wizard.xmpp.autoJoinPrompt"),
      placeholder: "room1@conference.example.org, room2@conference.example.org",
      required: false,
      applyEmptyValue: true,
      currentValue: ({ cfg, accountId }) =>
        resolveXmppAccount({ cfg: cfg as CoreConfig, accountId }).config.mucRooms?.join(", "),
      shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1",
      normalizeValue: ({ value }) =>
        parseListInput(value)
          .map((entry) => normalizeGroupEntry(entry))
          .filter((entry): entry is string => Boolean(entry && entry !== "*"))
          .join(", "),
      applySet: async ({ cfg, accountId, value }) => {
        const rooms = parseListInput(value)
          .map((entry) => normalizeGroupEntry(entry))
          .filter((entry): entry is string => Boolean(entry && entry !== "*"));
        return updateXmppAccountConfig(cfg as CoreConfig, accountId, {
          enabled: true,
          mucRooms: rooms.length > 0 ? rooms : undefined,
        });
      },
    },
  ],
  groupAccess: {
    label: "XMPP rooms",
    placeholder: "room1@conference.example.org, *",
    currentPolicy: ({ cfg, accountId }) =>
      resolveXmppAccount({ cfg: cfg as CoreConfig, accountId }).config.groupPolicy ?? "allowlist",
    currentEntries: ({ cfg, accountId }) =>
      Object.keys(resolveXmppAccount({ cfg: cfg as CoreConfig, accountId }).config.groups ?? {}),
    updatePrompt: ({ cfg, accountId }) =>
      Boolean(resolveXmppAccount({ cfg: cfg as CoreConfig, accountId }).config.groups),
    setPolicy: ({ cfg, accountId, policy }) =>
      setXmppGroupAccess(cfg as CoreConfig, accountId, policy, [], normalizeGroupEntry),
    resolveAllowlist: async ({ entries }) =>
      uniqueStrings(entries.map((entry) => normalizeGroupEntry(entry)).filter((entry): entry is string => Boolean(entry))),
    applyAllowlist: ({ cfg, accountId, resolved }) =>
      setXmppGroupAccess(cfg as CoreConfig, accountId, "allowlist", resolved as string[], normalizeGroupEntry),
  },
  allowFrom: createAllowFromSection({
    helpTitle: t("wizard.xmpp.allowlistTitle"),
    helpLines: [
      t("wizard.xmpp.allowlistIntro"),
      t("wizard.xmpp.examples"),
      "- alice@example.org",
      t("wizard.xmpp.multipleEntries"),
    ],
    message: t("wizard.xmpp.allowFromPrompt"),
    placeholder: "alice@example.org, bob@example.org",
    invalidWithoutCredentialNote: t("wizard.xmpp.allowFromInvalid"),
    parseId: (raw) => normalizeXmppAllowEntry(raw) || null,
    apply: async ({ cfg, allowFrom }) => setXmppAllowFrom(cfg as CoreConfig, allowFrom),
  }),
  finalize: async ({ cfg, accountId, prompter }) => {
    let next = cfg as CoreConfig;

    const resolvedAfterGroups = resolveXmppAccount({ cfg: next, accountId });
    if (resolvedAfterGroups.config.groupPolicy === "allowlist") {
      const groupKeys = Object.keys(resolvedAfterGroups.config.groups ?? {});
      if (groupKeys.length > 0) {
        const wantsMentions = await prompter.confirm({
          message: t("wizard.xmpp.requireMentionPrompt"),
          initialValue: true,
        });
        if (!wantsMentions) {
          const groups = resolvedAfterGroups.config.groups ?? {};
          const patched = Object.fromEntries(
            Object.entries(groups).map(([key, value]) => [key, { ...value, requireMention: false }]),
          );
          next = updateXmppAccountConfig(next, accountId, { groups: patched });
        }
      }
    }

    return { cfg: next };
  },
  completionNote: {
    title: t("wizard.xmpp.nextStepsTitle"),
    lines: [
      t("wizard.xmpp.nextRestartGateway"),
      t("wizard.xmpp.nextStatusCommand"),
      `Docs: ${formatDocsLink("/channels/xmpp", "channels/xmpp")}`,
    ],
  },
  dmPolicy: xmppDmPolicy,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};

export { xmppSetupAdapter };
