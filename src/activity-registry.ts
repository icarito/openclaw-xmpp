type XmppActivity = {
  activity: "available" | "busy" | "paused";
  target?: string | null;
  since: number;
};

const REGISTRY_KEY = "__openclawXmppActivity";
const BUSY_TTL_MS = 90_000;

type Registry = Map<string, XmppActivity>;

function registry(): Registry {
  const g = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY]!;
}

export function setXmppAccountActivity(accountId: string, activity: XmppActivity["activity"], target?: string | null): void {
  registry().set(accountId, { activity, target, since: Date.now() });
}

export function getXmppAccountActivity(accountId: string): XmppActivity | null {
  const current = registry().get(accountId) ?? null;
  if (!current) return null;
  if (current.activity === "busy" && Date.now() - current.since > BUSY_TTL_MS) {
    registry().delete(accountId);
    return null;
  }
  return current;
}
