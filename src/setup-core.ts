// Xmpp plugin module implements setup core behavior.
import type { ChannelSetupAdapter, ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import type { DmPolicy } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  applyAccountNameToChannelSection,
  createSetupInputPresenceValidator,
  createTopLevelChannelAllowFromSetter,
  createTopLevelChannelDmPolicySetter,
  patchScopedAccountConfig,
} from "openclaw/plugin-sdk/setup";
import { looksLikeXmppTargetId } from "./normalize.js";
import type { CoreConfig, XmppAccountConfig } from "./types.js";

const channel = "xmpp" as const;
const setXmppTopLevelDmPolicy = createTopLevelChannelDmPolicySetter({ channel });
const setXmppTopLevelAllowFrom = createTopLevelChannelAllowFromSetter({ channel });
const validateXmppRequiredSetupInput = createSetupInputPresenceValidator({
  whenNotUseEnv: [
    { someOf: ["jid"], message: "XMPP requires a JID." },
    { someOf: ["password"], message: "XMPP requires a password." },
  ],
});

type XmppSetupInput = ChannelSetupInput & {
  jid?: string;
  password?: string;
  service?: string;
  resource?: string;
  mucDomain?: string;
  mucRooms?: string[];
};

function validateXmppJidInput(input: ChannelSetupInput): string | null {
  const raw = (input as XmppSetupInput).jid;
  if (!raw) return null;
  return looksLikeXmppTargetId(raw) ? null : "XMPP JID must look like user@domain.";
}

export function updateXmppAccountConfig(
  cfg: CoreConfig,
  accountId: string,
  patch: Partial<XmppAccountConfig>,
): CoreConfig {
  return patchScopedAccountConfig({
    cfg,
    channelKey: channel,
    accountId,
    patch,
    ensureChannelEnabled: false,
    ensureAccountEnabled: false,
  }) as CoreConfig;
}

export function setXmppDmPolicy(cfg: CoreConfig, dmPolicy: DmPolicy): CoreConfig {
  return setXmppTopLevelDmPolicy(cfg, dmPolicy) as CoreConfig;
}

export function setXmppAllowFrom(cfg: CoreConfig, allowFrom: string[]): CoreConfig {
  return setXmppTopLevelAllowFrom(cfg, allowFrom) as CoreConfig;
}

export function setXmppGroupAccess(
  cfg: CoreConfig,
  accountId: string,
  policy: "open" | "allowlist" | "disabled",
  entries: string[],
  normalizeGroupEntry: (raw: string) => string | null,
): CoreConfig {
  if (policy !== "allowlist") {
    return updateXmppAccountConfig(cfg, accountId, { enabled: true, groupPolicy: policy });
  }
  const normalizedEntries = [...new Set(entries.flatMap((entry) => normalizeGroupEntry(entry) ?? []))];
  const groups = Object.fromEntries(normalizedEntries.map((entry) => [entry, {}]));
  return updateXmppAccountConfig(cfg, accountId, {
    enabled: true,
    groupPolicy: "allowlist",
    groups,
  });
}

export const xmppSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({ cfg, channelKey: channel, accountId, name }),
  validateInput: (params) =>
    validateXmppRequiredSetupInput(params) ?? validateXmppJidInput(params.input),
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const setupInput = input as XmppSetupInput;
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: channel,
      accountId,
      name: setupInput.name,
    });
    const patch: Partial<XmppAccountConfig> = {
      enabled: true,
      jid: setupInput.jid?.trim(),
      password: setupInput.password?.trim(),
      service: setupInput.service?.trim(),
      resource: setupInput.resource?.trim(),
      mucDomain: setupInput.mucDomain?.trim(),
      mucRooms: setupInput.mucRooms,
    };
    return patchScopedAccountConfig({
      cfg: namedConfig,
      channelKey: channel,
      accountId,
      patch,
    }) as CoreConfig;
  },
};
