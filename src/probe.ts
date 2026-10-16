// Xmpp plugin module implements probe behavior.
import { resolveXmppAccount } from "./accounts.js";
import { randomBytes } from "node:crypto";
import type { ResolvedXmppAccount } from "./accounts.js";
import { connectXmppClient } from "./client.js";
import type { CoreConfig, XmppProbe } from "./types.js";

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

export function isolateProbeAccount(account: ResolvedXmppAccount): ResolvedXmppAccount {
  // A probe must never bind the monitor's resource or join its rooms: Prosody
  // closes the older stream when two clients bind the same full JID.
  const resource = `${account.resource}-probe-${randomBytes(4).toString("hex")}`;
  return {
    ...account,
    resource,
    mucRooms: [],
    config: { ...account.config, resource, mucRooms: [] },
  };
}

export async function probeXmpp(
  cfg: CoreConfig,
  opts?: { accountId?: string; timeoutMs?: number },
): Promise<XmppProbe> {
  const account = resolveXmppAccount({ cfg, accountId: opts?.accountId });
  const base: XmppProbe = {
    ok: false,
    jid: account.jid,
    service: account.service,
  };

  if (!account.configured) {
    return {
      ...base,
      error: "missing jid or password",
    };
  }

  const started = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 8000);
    try {
      const connection = await connectXmppClient({ account: isolateProbeAccount(account), abortSignal: controller.signal });
      const elapsed = Date.now() - started;
      await connection.stop();
      return {
        ...base,
        ok: true,
        latencyMs: elapsed,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return {
      ...base,
      error: formatError(err),
    };
  }
}
