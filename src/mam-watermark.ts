// Xmpp plugin module implements the persistent MAM watermark (change
// xmpp-first-class-channel, tarea 5.2). One entry per account and peer (DM
// bare JID or room), keyed by the XEP-0359 composite archive id (by, id)
// because ids are scoped to the JID that assigned them. It stores the last
// archive id advanced to (the RSM anchor for the next catch-up) plus a bounded
// set of recently seen ids so live and replayed stanzas can be deduped.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { MamArchiveId } from "./mam.js";

export type MamWatermarkEntry = {
  last?: MamArchiveId;
  /** Timestamp of the last advance (used to detect stale anchors). */
  at: number;
  seen: Array<{ key: string; at: number }>;
};

export type MamWatermarkOptions = {
  path: string | null;
  /** Cap of remembered archive ids per peer. */
  maxSeen?: number;
  /** TTL for remembered archive ids. */
  seenTtlMs?: number;
};

type WatermarkFile = { version: 1; peers: Record<string, MamWatermarkEntry> };

const DEFAULT_MAX_SEEN = 500;
const DEFAULT_SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function resolveMamWatermarkPath(accountId: string): string | null {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) return null;
  return join(stateDir, "channel-cache", "xmpp", `${accountId}-mam-watermark.json`);
}

export function archiveIdKey(id: MamArchiveId | null | undefined): string | null {
  if (!id || !id.id) return null;
  return `${id.by}\u0000${id.id}`;
}

export function dmPeerKey(jid: string): string {
  return `dm:${jid}`;
}

export function roomPeerKey(room: string): string {
  return `room:${room}`;
}

export function parsePeerKey(peerKey: string): { kind: "dm" | "room"; jid: string } | null {
  if (peerKey.startsWith("dm:")) return { kind: "dm", jid: peerKey.slice(3) };
  if (peerKey.startsWith("room:")) return { kind: "room", jid: peerKey.slice(5) };
  return null;
}

export class MamWatermark {
  private readonly path: string | null;
  private readonly maxSeen: number;
  private readonly seenTtlMs: number;
  private peers = new Map<string, MamWatermarkEntry>();
  private loaded = false;

  constructor(options: MamWatermarkOptions) {
    this.path = options.path;
    this.maxSeen = options.maxSeen ?? DEFAULT_MAX_SEEN;
    this.seenTtlMs = options.seenTtlMs ?? DEFAULT_SEEN_TTL_MS;
  }

  last(peerKey: string): MamArchiveId | undefined {
    return this.entry(peerKey)?.last;
  }

  anchor(peerKey: string): { anchor?: string; at?: number } {
    const entry = this.entry(peerKey);
    if (!entry?.last) return {};
    return { anchor: entry.last.id, at: entry.at };
  }

  peersList(): string[] {
    this.ensureLoaded();
    return [...this.peers.keys()];
  }

  isSeen(peerKey: string, id: MamArchiveId | null | undefined, now = Date.now()): boolean {
    const key = archiveIdKey(id);
    if (!key) return false;
    const entry = this.entry(peerKey);
    if (!entry) return false;
    return entry.seen.some((seen) => seen.key === key && now - seen.at <= this.seenTtlMs);
  }

  /** Mark an archive id as processed without moving the anchor. */
  markSeen(peerKey: string, id: MamArchiveId | null | undefined, now = Date.now()): void {
    const key = archiveIdKey(id);
    if (!key) return;
    const entry = this.mutableEntry(peerKey);
    this.pushSeen(entry, key, now);
    this.persist();
  }

  /** Advance the watermark to `id` (the next catch-up anchor) and mark it seen. */
  setLast(peerKey: string, id: MamArchiveId | null | undefined, now = Date.now()): void {
    const key = archiveIdKey(id);
    if (!key) return;
    const entry = this.mutableEntry(peerKey);
    entry.last = { by: id!.by, id: id!.id };
    entry.at = now;
    this.pushSeen(entry, key, now);
    this.persist();
  }

  prune(now = Date.now()): number {
    this.ensureLoaded();
    let removed = 0;
    for (const entry of this.peers.values()) {
      const before = entry.seen.length;
      entry.seen = entry.seen.filter((seen) => now - seen.at <= this.seenTtlMs);
      removed += before - entry.seen.length;
    }
    if (removed > 0) this.persist();
    return removed;
  }

  stats(): { peers: number } {
    this.ensureLoaded();
    return { peers: this.peers.size };
  }

  private pushSeen(entry: MamWatermarkEntry, key: string, now: number): void {
    const existing = entry.seen.find((seen) => seen.key === key);
    if (existing) {
      existing.at = now;
      return;
    }
    entry.seen.push({ key, at: now });
    if (entry.seen.length > this.maxSeen) {
      entry.seen.splice(0, entry.seen.length - this.maxSeen);
    }
  }

  private entry(peerKey: string): MamWatermarkEntry | undefined {
    this.ensureLoaded();
    return this.peers.get(peerKey);
  }

  private mutableEntry(peerKey: string): MamWatermarkEntry {
    this.ensureLoaded();
    let entry = this.peers.get(peerKey);
    if (!entry) {
      entry = { at: Date.now(), seen: [] };
      this.peers.set(peerKey, entry);
    }
    return entry;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as WatermarkFile;
      for (const [peerKey, value] of Object.entries(raw.peers ?? {})) {
        if (!value) continue;
        const seen = Array.isArray(value.seen)
          ? value.seen.filter((item) => typeof item?.key === "string" && typeof item.at === "number")
          : [];
        const last = value.last && typeof value.last.id === "string"
          ? { by: typeof value.last.by === "string" ? value.last.by : "", id: value.last.id }
          : undefined;
        this.peers.set(peerKey, {
          ...(last ? { last } : {}),
          at: typeof value.at === "number" ? value.at : Date.now(),
          seen,
        });
      }
    } catch {
      // A corrupt watermark must not block the history layer; it is rewritten
      // on the next advance.
    }
  }

  private persist(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const payload: WatermarkFile = {
        version: 1,
        peers: Object.fromEntries(
          [...this.peers.entries()].map(([peerKey, entry]) => [
            peerKey,
            {
              ...(entry.last ? { last: entry.last } : {}),
              at: entry.at,
              seen: entry.seen,
            },
          ]),
        ),
      };
      writeFileSync(`${this.path}.tmp`, JSON.stringify(payload, null, 2) + "\n");
      renameSync(`${this.path}.tmp`, this.path);
    } catch {
      // Best-effort: the live dedupe path still works in memory.
    }
  }
}

const REGISTRY_KEY = Symbol.for("openclaw.xmpp.mamWatermarks");

function registry(): Map<string, MamWatermark> {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY] as Map<string, MamWatermark>;
}

export function getMamWatermark(accountId: string, options: MamWatermarkOptions): MamWatermark {
  const existing = registry().get(accountId);
  if (existing) return existing;
  const created = new MamWatermark({
    ...options,
    path: options.path ?? resolveMamWatermarkPath(accountId),
  });
  registry().set(accountId, created);
  return created;
}

export function clearMamWatermark(accountId: string): void {
  registry().delete(accountId);
}
