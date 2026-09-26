// Xmpp plugin module holds the observational catch-up layer (change
// xmpp-first-class-channel, tareas 5.3/5.5). Recovered MAM history is session
// context, never a model turn: it is buffered per peer and folded into the
// next real inbound message, unless `history.spawnTurns` opts into turns.
// It also owns the pure decision that replaces the blind XEP-0203 5-minute
// guard when MAM is available.
import type { MamArchivedMessage, MamArchiveId } from "./mam.js";
import type { MamWatermark } from "./mam-watermark.js";

export type CatchupContextEntry = {
  from: string;
  at: number;
  text: string;
};

export type ArchiveReplayDecision = "fresh" | "replay" | "stale";

/**
 * With MAM available, a stanza whose archive id was already covered is a
 * replay and is dropped by dedupe; the 5-minute age guard stays only as a
 * safety net. Without MAM the legacy age guard is untouched (regression zero).
 */
export function decideArchiveReplay(params: {
  mamEnabled: boolean;
  archiveId: MamArchiveId | null;
  seen: boolean;
  staleByAge: boolean;
}): ArchiveReplayDecision {
  if (params.mamEnabled && params.archiveId && params.seen) return "replay";
  if (params.staleByAge) return "stale";
  return "fresh";
}

function toContextEntry(archived: MamArchivedMessage): CatchupContextEntry {
  return {
    from: archived.from ?? "unknown",
    at: archived.delayMs ?? Date.now(),
    text: archived.body,
  };
}

export class CatchupContextStore {
  private readonly maxEntries: number;
  private readonly buffers = new Map<string, CatchupContextEntry[]>();

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 50;
  }

  record(peerKey: string, entries: CatchupContextEntry[]): void {
    if (entries.length === 0) return;
    const buffer = this.buffers.get(peerKey) ?? [];
    buffer.push(...entries);
    if (buffer.length > this.maxEntries) {
      buffer.splice(0, buffer.length - this.maxEntries);
    }
    this.buffers.set(peerKey, buffer);
  }

  peek(peerKey: string): CatchupContextEntry[] {
    return [...(this.buffers.get(peerKey) ?? [])];
  }

  /** Return and clear the buffer for `peerKey`. */
  drain(peerKey: string): CatchupContextEntry[] {
    const buffer = this.buffers.get(peerKey);
    if (!buffer) return [];
    this.buffers.delete(peerKey);
    return [...buffer];
  }

  clear(): void {
    this.buffers.clear();
  }

  stats(): { peers: number; entries: number } {
    let entries = 0;
    for (const buffer of this.buffers.values()) entries += buffer.length;
    return { peers: this.buffers.size, entries };
  }
}

/**
 * Apply a catch-up page: advance the watermark for every recovered message
 * (no gaps) and either buffer them as context or dispatch them as turns.
 */
export function applyCatchupMessages(params: {
  peerKey: string;
  messages: MamArchivedMessage[];
  watermark: MamWatermark;
  context?: CatchupContextStore;
  spawnTurns: boolean;
  dispatch?: (archived: MamArchivedMessage) => void;
  now?: number;
}): { contextCount: number; turnCount: number } {
  let contextCount = 0;
  let turnCount = 0;
  for (const archived of params.messages) {
    if (archived.archiveId) params.watermark.setLast(params.peerKey, archived.archiveId, params.now);
    if (params.spawnTurns) {
      params.dispatch?.(archived);
      turnCount += 1;
    } else {
      params.context?.record(params.peerKey, [toContextEntry(archived)]);
      contextCount += 1;
    }
  }
  return { contextCount, turnCount };
}

/** Compact transcript used as session context for the next real turn. */
export function formatCatchupContext(entries: CatchupContextEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((entry) => {
    const when = Number.isFinite(entry.at) ? new Date(entry.at).toISOString() : "unknown-time";
    const text = entry.text.replace(/\s+/g, " ").trim().slice(0, 500);
    return `- [${when}] ${entry.from}: ${text}`;
  });
  return `[Historial recuperado mientras estabas desconectado; es contexto, no respondas a cada línea]\n${lines.join("\n")}`;
}

const REGISTRY_KEY = Symbol.for("openclaw.xmpp.catchupContext");

function registry(): Map<string, CatchupContextStore> {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY] as Map<string, CatchupContextStore>;
}

export function getCatchupContextStore(accountId: string): CatchupContextStore {
  const existing = registry().get(accountId);
  if (existing) return existing;
  const created = new CatchupContextStore();
  registry().set(accountId, created);
  return created;
}

export function clearCatchupContextStore(accountId: string): void {
  registry().delete(accountId);
}
