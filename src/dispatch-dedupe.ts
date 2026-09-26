// Xmpp plugin module implements durable dispatch deduplication (change
// xmpp-first-class-channel, tarea 3.2). Claims survive a process restart so a
// replayed stanza inside the TTL does not run a second agent turn; a
// duplicate commit is treated as fatal instead of re-running the turn.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type DispatchClaimState = "pending" | "committed";

export type DispatchClaim = {
  key: string;
  at: number;
  state: DispatchClaimState;
};

export type DispatchClaimResult = "new" | "duplicate";

export type DispatchCommitResult = {
  ok: boolean;
  /** A commit for an already-committed or unknown key: a duplicate turn. */
  duplicateCommit: boolean;
};

export type DispatchDedupeOptions = {
  path: string | null;
  ttlMs: number;
};

type DedupeFile = { version: 1; claims: DispatchClaim[] };

export function resolveDispatchDedupePath(accountId: string): string | null {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) return null;
  return join(stateDir, "channel-cache", "xmpp", `${accountId}-dispatch-dedupe.json`);
}

export class DispatchDedupeStore {
  private readonly path: string | null;
  private readonly ttlMs: number;
  private claims = new Map<string, DispatchClaim>();
  private loaded = false;

  constructor(options: DispatchDedupeOptions) {
    this.path = options.path;
    this.ttlMs = options.ttlMs;
  }

  /** Returns "duplicate" when a live claim already covers this key. */
  claim(key: string, now = Date.now()): DispatchClaimResult {
    this.ensureLoaded();
    const existing = this.claims.get(key);
    if (existing && now - existing.at <= this.ttlMs) return "duplicate";
    if (existing) this.claims.delete(key);
    this.claims.set(key, { key, at: now, state: "pending" });
    this.prune(now);
    this.persist();
    return "new";
  }

  has(key: string, now = Date.now()): boolean {
    this.ensureLoaded();
    const existing = this.claims.get(key);
    return Boolean(existing && now - existing.at <= this.ttlMs);
  }

  /** Finalize a held claim; a duplicate commit is fatal, never a retry. */
  commit(key: string, now = Date.now()): DispatchCommitResult {
    this.ensureLoaded();
    const existing = this.claims.get(key);
    if (!existing || now - existing.at > this.ttlMs || existing.state === "committed") {
      return { ok: false, duplicateCommit: true };
    }
    existing.state = "committed";
    existing.at = now;
    this.persist();
    return { ok: true, duplicateCommit: false };
  }

  /** Release a claim after a turn failure so a legitimate retry can run. */
  rollback(key: string): boolean {
    this.ensureLoaded();
    const existing = this.claims.get(key);
    if (!existing || existing.state === "committed") return false;
    this.claims.delete(key);
    this.persist();
    return true;
  }

  stats(now = Date.now()): { pending: number; committed: number } {
    this.ensureLoaded();
    let pending = 0;
    let committed = 0;
    for (const claim of this.claims.values()) {
      if (now - claim.at > this.ttlMs) continue;
      if (claim.state === "pending") pending += 1;
      else committed += 1;
    }
    return { pending, committed };
  }

  prune(now = Date.now()): number {
    let removed = 0;
    for (const [key, claim] of this.claims) {
      if (now - claim.at > this.ttlMs) {
        this.claims.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as DedupeFile;
      for (const claim of raw.claims ?? []) {
        if (typeof claim?.key !== "string") continue;
        this.claims.set(claim.key, {
          key: claim.key,
          at: typeof claim.at === "number" ? claim.at : Date.now(),
          state: claim.state === "committed" ? "committed" : "pending",
        });
      }
    } catch {
      // Corrupt dedupe state must not block inbound chat.
    }
  }

  private persist(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const payload: DedupeFile = { version: 1, claims: [...this.claims.values()] };
      writeFileSync(`${this.path}.tmp`, JSON.stringify(payload, null, 2) + "\n");
      renameSync(`${this.path}.tmp`, this.path);
    } catch {
      // Best-effort only.
    }
  }
}

const REGISTRY_KEY = Symbol.for("openclaw.xmpp.dispatchDedupe");

function registry(): Map<string, DispatchDedupeStore> {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY] as Map<string, DispatchDedupeStore>;
}

export function getDispatchDedupe(accountId: string, options: DispatchDedupeOptions): DispatchDedupeStore {
  const existing = registry().get(accountId);
  if (existing) return existing;
  const created = new DispatchDedupeStore({
    ...options,
    path: options.path ?? resolveDispatchDedupePath(accountId),
  });
  registry().set(accountId, created);
  return created;
}

export function clearDispatchDedupe(accountId: string): void {
  registry().delete(accountId);
}
