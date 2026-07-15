// Xmpp plugin module implements secret contract behavior.
import {
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import type {
  ResolverContext,
  SecretDefaults,
  SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

// NOTE(xmpp-migration): `createChannelSecretTargetRegistryEntries` exists in
// the OpenClaw git source (see extensions/irc/src/secret-contract.ts
// upstream) but is not exported by the installed 2026.7.1 npm package —
// same version skew as config-ui-hints.ts. Stubbed as empty: this only
// affects whether `password`/`account.password` values get flagged for
// redaction in config dumps/logs by the generic secret registry; it does not
// affect connecting, sending, or command handling. Re-add the real call
// (`channelKey: "xmpp", account: ["password"], channel: ["password"]`) once
// the installed OpenClaw version ships that export.
export const secretTargetRegistryEntries: SecretTargetRegistryEntry[] = [];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, "xmpp");
  if (!resolved) {
    return;
  }
  const { channel: xmpp, surface } = resolved;
  collectSimpleChannelFieldAssignments({
    channelKey: "xmpp",
    field: "password",
    channel: xmpp,
    surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled account inherits this top-level XMPP password.",
    accountInactiveReason: "XMPP account is disabled.",
  });
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
