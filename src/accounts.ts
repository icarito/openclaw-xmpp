// Xmpp plugin module implements accounts behavior.
import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/channel-core";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CoreConfig, XmppAccountConfig } from "./types.js";

export type ResolvedXmppAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  jid: string;
  service: string;
  resource: string;
  mucDomain?: string;
  mucRooms: string[];
  password: string;
  passwordSource: "env" | "passwordFile" | "config" | "none";
  config: XmppAccountConfig;
};

const { listAccountIds: listXmppAccountIds, resolveDefaultAccountId: resolveDefaultXmppAccountId } =
  createAccountListHelpers("xmpp", {
    normalizeAccountId,
    hasImplicitDefaultAccount: (cfg) =>
      Boolean(
        (cfg.channels?.xmpp?.jid?.trim() || process.env.XMPP_JID?.trim()) &&
        (cfg.channels?.xmpp?.password?.trim() || process.env.XMPP_PASSWORD?.trim()),
      ),
  });
export { listXmppAccountIds, resolveDefaultXmppAccountId };

function mergeXmppAccountConfig(cfg: CoreConfig, accountId: string): XmppAccountConfig {
  return resolveMergedAccountConfig<XmppAccountConfig>({
    channelConfig: cfg.channels?.xmpp as XmppAccountConfig | undefined,
    accounts: cfg.channels?.xmpp?.accounts as Record<string, Partial<XmppAccountConfig>> | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
    nestedObjectKeys: [],
  });
}

function resolvePassword(accountId: string, merged: XmppAccountConfig) {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envPassword = process.env.XMPP_PASSWORD?.trim();
    if (envPassword) {
      return { password: envPassword, source: "env" as const };
    }
  }

  if (merged.passwordFile?.trim()) {
    const filePassword = tryReadSecretFileSync(merged.passwordFile, "XMPP password file", {
      rejectSymlink: true,
    });
    if (filePassword) {
      return { password: filePassword, source: "passwordFile" as const };
    }
  }

  const configPassword = normalizeResolvedSecretInputString({
    value: merged.password,
    path: `channels.xmpp.accounts.${accountId}.password`,
  });
  if (configPassword) {
    return { password: configPassword, source: "config" as const };
  }

  return { password: "", source: "none" as const };
}

export function resolveXmppAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedXmppAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const baseEnabled = params.cfg.channels?.xmpp?.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeXmppAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;

    const jid = (
      merged.jid?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.XMPP_JID?.trim() : "") ||
      ""
    ).trim();
    const service = (
      merged.service?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.XMPP_SERVICE?.trim() : "") ||
      "xmpp://127.0.0.1:5222"
    ).trim();
    const resource = (merged.resource?.trim() || `openclaw-${accountId}`).trim();
    const mucDomain = (
      merged.mucDomain?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.XMPP_MUC_DOMAIN?.trim() : "") ||
      undefined
    )?.trim();
    const mucRooms = merged.mucRooms ?? [];

    const passwordResolution = resolvePassword(accountId, merged);

    const config: XmppAccountConfig = {
      ...merged,
      jid,
      service,
      resource,
      mucDomain,
      mucRooms,
    };

    return {
      accountId,
      enabled,
      name: normalizeOptionalString(merged.name),
      configured: Boolean(jid && passwordResolution.password),
      jid,
      service,
      resource,
      mucDomain,
      mucRooms,
      password: passwordResolution.password,
      passwordSource: passwordResolution.source,
      config,
    } satisfies ResolvedXmppAccount;
  };

  const normalized = normalizeAccountId(params.accountId);
  const primary = resolve(normalized);
  if (hasExplicitAccountId) {
    return primary;
  }
  if (primary.configured) {
    return primary;
  }

  const fallbackId = resolveDefaultXmppAccountId(params.cfg);
  if (fallbackId === primary.accountId) {
    return primary;
  }
  const fallback = resolve(fallbackId);
  if (!fallback.configured) {
    return primary;
  }
  return fallback;
}

export function listEnabledXmppAccounts(cfg: CoreConfig): ResolvedXmppAccount[] {
  return listXmppAccountIds(cfg)
    .map((accountId) => resolveXmppAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
