// Xmpp plugin module implements gateway behavior.
import { runStoppablePassiveMonitor } from "openclaw/plugin-sdk/extension-shared";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import type { ResolvedXmppAccount } from "./accounts.js";
import { createAccountStatusSink } from "./channel-api.js";
import type { RuntimeEnv } from "./runtime-api.js";
import type { CoreConfig } from "./types.js";

const loadXmppChannelRuntime = createLazyRuntimeModule(() => import("./channel-runtime.js"));

export async function startXmppGatewayAccount(ctx: {
  cfg: CoreConfig;
  accountId: string;
  account: ResolvedXmppAccount;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  setStatus: (next: ChannelAccountSnapshot) => void;
  channelRuntime?: ChannelRuntimeSurface;
  log?: {
    info?: (message: string) => void;
  };
}): Promise<void> {
  const account = ctx.account;
  const statusSink = createAccountStatusSink({
    accountId: ctx.accountId,
    setStatus: ctx.setStatus,
  });
  if (!account.configured) {
    throw new Error(
      `XMPP is not configured for account "${account.accountId}" (need jid and password in channels.xmpp).`,
    );
  }
  ctx.log?.info?.(`[${account.accountId}] starting XMPP provider (${account.jid})`);
  const { monitorXmppProvider } = await loadXmppChannelRuntime();
  await runStoppablePassiveMonitor({
    abortSignal: ctx.abortSignal,
    start: async () =>
      await monitorXmppProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink,
        channelRuntime: ctx.channelRuntime,
      }),
  });
}
