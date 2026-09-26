// Xmpp plugin module implements the persistent outbound spool (change
// xmpp-first-class-channel, tarea 2.1). Every non-ephemeral outgoing message
// is keyed by its XEP-0359 origin-id and kept until the server acknowledges
// it (XEP-0198 `a`/`h`) or the recipient sends a XEP-0184 receipt; resends
// reuse the same origin-id so receiver-side dedupe stays idempotent.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseXml } from "ltx";
import type { Element } from "@xmpp/xml";
import { classifyDeliveryError, computeBackoffMs, type DeliveryFailureClass } from "./delivery-failure.js";

export type OutboundSpoolState = "pending" | "dead";

export type OutboundSpoolEntry = {
  /** XEP-0359 origin-id; also the stanza `id`, stable across resends. */
  originId: string;
  to: string;
  type: "chat" | "groupchat";
  /** Serialized stanza (hints XEP-0334 and carbons payload preserved verbatim). */
  stanza: string;
  enqueuedAt: number;
  attempts: number;
  nextAttemptAt: number;
  /** Per-stream sequence assigned when the stanza is actually sent. */
  seq?: number;
  state: OutboundSpoolState;
  lastError?: string;
  errorClass?: DeliveryFailureClass;
};

export type OutboundSpoolEnqueue = {
  originId: string;
  to: string;
  type: "chat" | "groupchat";
  stanza: Element | string;
};

export type OutboundSpoolOptions = {
  path: string | null;
  maxAgeMs: number;
  maxAttempts: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxEntries?: number;
};

type SpoolFile = { version: 1; entries: OutboundSpoolEntry[] };

const DEFAULT_BACKOFF_BASE_MS = 5_000;
const DEFAULT_BACKOFF_MAX_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

export function resolveOutboundSpoolPath(accountId: string): string | null {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) return null;
  return join(stateDir, "channel-cache", "xmpp", `${accountId}-outbound-spool.json`);
}

export class OutboundSpool {
  private readonly path: string | null;
  private readonly maxAgeMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxEntries: number;
  private entries = new Map<string, OutboundSpoolEntry>();
  private loaded = false;
  /** Count of stanzas sent on the current stream (XEP-0198 h is relative to it). */
  private sentCount = 0;

  constructor(options: OutboundSpoolOptions) {
    this.path = options.path;
    this.maxAgeMs = options.maxAgeMs;
    this.maxAttempts = options.maxAttempts;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** A new stream (or a resumed stream) restarts the XEP-0198 sequence. */
  beginStream(): void {
    this.sentCount = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === "pending") entry.seq = undefined;
    }
  }

  /** Number of stanzas counted on the current stream. */
  streamSentCount(): number {
    return this.sentCount;
  }

  /**
   * Count an outbound stanza on the current stream. Spooled stanzas pass
   * their origin-id so a later XEP-0198 `<a h=.../>` can mark them handled.
   */
  noteSent(originId?: string): number {
    this.sentCount += 1;
    if (originId) {
      const entry = this.entries.get(originId);
      if (entry && entry.state === "pending") entry.seq = this.sentCount;
    }
    return this.sentCount;
  }

  enqueue(input: OutboundSpoolEnqueue, now = Date.now()): OutboundSpoolEntry | null {
    this.ensureLoaded();
    if (this.entries.has(input.originId)) return null;
    const entry: OutboundSpoolEntry = {
      originId: input.originId,
      to: input.to,
      type: input.type,
      stanza: typeof input.stanza === "string" ? input.stanza : input.stanza.toString(),
      enqueuedAt: now,
      attempts: 0,
      nextAttemptAt: now,
      state: "pending",
    };
    this.entries.set(entry.originId, entry);
    this.prune(now);
    this.persist();
    return entry;
  }

  get(originId: string): OutboundSpoolEntry | undefined {
    this.ensureLoaded();
    return this.entries.get(originId);
  }

  /** Mark one message delivered (XEP-0198 ack or XEP-0184 receipt). */
  ack(originId: string): boolean {
    this.ensureLoaded();
    const entry = this.entries.get(originId);
    if (!entry) return false;
    this.entries.delete(originId);
    this.persist();
    return true;
  }

  /** Mark everything with `seq <= h` handled by the server (XEP-0198 `a`). */
  ackUpTo(h: number): string[] {
    this.ensureLoaded();
    if (!Number.isFinite(h) || h <= 0) return [];
    const acked: string[] = [];
    for (const [originId, entry] of this.entries) {
      if (entry.state === "pending" && entry.seq !== undefined && entry.seq <= h) {
        acked.push(originId);
        this.entries.delete(originId);
      }
    }
    if (acked.length > 0) this.persist();
    return acked;
  }

  /**
   * Reschedule a failed send with bounded exponential backoff. Fatal and
   * duplicate failures are dead-lettered instead of retried.
   */
  requeue(originId: string, error: unknown, now = Date.now()): OutboundSpoolEntry | undefined {
    this.ensureLoaded();
    const entry = this.entries.get(originId);
    if (!entry) return undefined;
    const classified = classifyDeliveryError(error);
    entry.attempts += 1;
    entry.lastError = classified.message;
    entry.errorClass = classified.errorClass;
    if (classified.deadLetter || entry.attempts >= this.maxAttempts) {
      entry.state = "dead";
      entry.nextAttemptAt = Number.POSITIVE_INFINITY;
    } else {
      entry.nextAttemptAt = now + computeBackoffMs(entry.attempts, this.backoffBaseMs, this.backoffMaxMs);
    }
    this.persist();
    return entry;
  }

  markDead(originId: string, reason: string, errorClass: DeliveryFailureClass = "fatal"): boolean {
    this.ensureLoaded();
    const entry = this.entries.get(originId);
    if (!entry) return false;
    entry.state = "dead";
    entry.errorClass = errorClass;
    entry.lastError = reason;
    entry.nextAttemptAt = Number.POSITIVE_INFINITY;
    this.persist();
    return true;
  }

  /** Pending entries due for a (re)send at `now`, oldest first. */
  listDue(now = Date.now()): OutboundSpoolEntry[] {
    this.ensureLoaded();
    return [...this.entries.values()]
      .filter((entry) => entry.state === "pending" && entry.nextAttemptAt <= now)
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }

  listPending(): OutboundSpoolEntry[] {
    this.ensureLoaded();
    return [...this.entries.values()].filter((entry) => entry.state === "pending");
  }

  listDead(): OutboundSpoolEntry[] {
    this.ensureLoaded();
    return [...this.entries.values()].filter((entry) => entry.state === "dead");
  }

  /** Drop entries older than the configured retention (default 7 days). */
  prune(now = Date.now()): number {
    let removed = 0;
    for (const [originId, entry] of this.entries) {
      if (now - entry.enqueuedAt > this.maxAgeMs) {
        this.entries.delete(originId);
        removed += 1;
      }
    }
    // Hard cap so a pathological outage cannot grow the file without bound:
    // keep the newest entries and dead-letter the rest.
    if (this.entries.size > this.maxEntries) {
      const ordered = [...this.entries.values()].sort((a, b) => b.enqueuedAt - a.enqueuedAt);
      for (const entry of ordered.slice(this.maxEntries)) {
        if (entry.state === "pending") {
          entry.state = "dead";
          entry.lastError = "spool capacity exceeded";
          entry.errorClass = "fatal";
        }
      }
    }
    return removed;
  }

  toElement(entry: OutboundSpoolEntry): Element {
    return parseXml(entry.stanza) as Element;
  }

  stats(): { pending: number; dead: number } {
    this.ensureLoaded();
    let pending = 0;
    let dead = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === "pending") pending += 1;
      else dead += 1;
    }
    return { pending, dead };
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as SpoolFile;
      for (const entry of raw.entries ?? []) {
        if (typeof entry?.originId !== "string" || typeof entry.stanza !== "string") continue;
        this.entries.set(entry.originId, {
          originId: entry.originId,
          to: entry.to,
          type: entry.type === "groupchat" ? "groupchat" : "chat",
          stanza: entry.stanza,
          enqueuedAt: typeof entry.enqueuedAt === "number" ? entry.enqueuedAt : Date.now(),
          attempts: typeof entry.attempts === "number" ? entry.attempts : 0,
          nextAttemptAt: typeof entry.nextAttemptAt === "number" ? entry.nextAttemptAt : Date.now(),
          state: entry.state === "dead" ? "dead" : "pending",
          ...(entry.seq !== undefined ? { seq: entry.seq } : {}),
          ...(entry.lastError ? { lastError: entry.lastError } : {}),
          ...(entry.errorClass ? { errorClass: entry.errorClass } : {}),
        });
      }
    } catch {
      // Corrupt spool must never block outbound chat; it is rewritten on the
      // next enqueue.
    }
  }

  private persist(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const payload: SpoolFile = { version: 1, entries: [...this.entries.values()] };
      writeFileSync(`${this.path}.tmp`, JSON.stringify(payload, null, 2) + "\n");
      renameSync(`${this.path}.tmp`, this.path);
    } catch {
      // Best-effort: a spool write failure must not fail the send.
    }
  }
}

const REGISTRY_KEY = Symbol.for("openclaw.xmpp.outboundSpools");

function registry(): Map<string, OutboundSpool> {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY] as Map<string, OutboundSpool>;
}

export function getOutboundSpool(
  accountId: string,
  options: OutboundSpoolOptions,
): OutboundSpool {
  const existing = registry().get(accountId);
  if (existing) return existing;
  const created = new OutboundSpool({ ...options, path: options.path ?? resolveOutboundSpoolPath(accountId) });
  registry().set(accountId, created);
  return created;
}

export function clearOutboundSpool(accountId: string): void {
  registry().delete(accountId);
}
