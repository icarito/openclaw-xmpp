type CommandNodeEntry = {
  commandText: string;
  expiresAt: number;
};

const REGISTRY_KEY = Symbol.for("openclaw.xmpp.commandNodes");
const RESPONSE_REGISTRY_KEY = Symbol.for("openclaw.xmpp.commandResponses");
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function getRegistry(): Map<string, CommandNodeEntry> {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = new Map<string, CommandNodeEntry>();
  }
  return g[REGISTRY_KEY] as Map<string, CommandNodeEntry>;
}

function getResponseRegistry(): Map<string, CommandNodeEntry> {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[RESPONSE_REGISTRY_KEY]) {
    g[RESPONSE_REGISTRY_KEY] = new Map<string, CommandNodeEntry>();
  }
  return g[RESPONSE_REGISTRY_KEY] as Map<string, CommandNodeEntry>;
}

function key(accountId: string, node: string): string {
  return `${accountId}\0${node}`;
}

function responseKey(accountId: string, jid: string, responseText: string): string {
  return `${accountId}\0${jid}\0${responseText.trim().toLowerCase()}`;
}

function accountPrefix(accountId: string): string {
  return `${accountId}\0`;
}

export function registerXmppCommandNode(params: {
  accountId: string;
  node: string;
  commandText: string;
  ttlMs?: number;
}): void {
  getRegistry().set(key(params.accountId, params.node), {
    commandText: params.commandText,
    expiresAt: Date.now() + (params.ttlMs ?? DEFAULT_TTL_MS),
  });
}

export function consumeXmppCommandNode(accountId: string, node: string): CommandNodeEntry | undefined {
  const registry = getRegistry();
  const registryKey = key(accountId, node);
  const entry = registry.get(registryKey);
  if (!entry) return undefined;
  registry.delete(registryKey);
  if (entry.expiresAt <= Date.now()) return undefined;
  return entry;
}

/** Restore an atomically-consumed node when downstream command dispatch fails. */
export function restoreXmppCommandNode(
  accountId: string,
  node: string,
  entry: CommandNodeEntry,
): void {
  if (entry.expiresAt <= Date.now()) return;
  getRegistry().set(key(accountId, node), entry);
}

export function registerXmppCommandResponse(params: {
  accountId: string;
  jid: string;
  responseText: string;
  commandText: string;
  ttlMs?: number;
}): void {
  const responseText = params.responseText.trim();
  if (!responseText) return;
  getResponseRegistry().set(responseKey(params.accountId, params.jid, responseText), {
    commandText: params.commandText,
    expiresAt: Date.now() + (params.ttlMs ?? DEFAULT_TTL_MS),
  });
}

export function consumeXmppCommandResponse(
  accountId: string,
  jid: string,
  responseText: string,
): CommandNodeEntry | undefined {
  const registry = getResponseRegistry();
  const registryKey = responseKey(accountId, jid, responseText);
  const entry = registry.get(registryKey);
  if (!entry) return undefined;
  registry.delete(registryKey);
  if (entry.expiresAt <= Date.now()) return undefined;
  return entry;
}

export function clearXmppCommandNodes(accountId: string): void {
  const prefix = accountPrefix(accountId);
  for (const registry of [getRegistry(), getResponseRegistry()]) {
    for (const registryKey of registry.keys()) {
      if (registryKey.startsWith(prefix)) registry.delete(registryKey);
    }
  }
}
