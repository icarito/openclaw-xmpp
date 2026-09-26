// Xmpp plugin module implements a per-destination outbound burst breaker
// (change xmpp-first-class-channel, tarea 3.3). It stops a self-sustaining
// retry chain (the token-burn failure mode documented in
// AUDITORIA-TOKENS-2026-07-18.md) without ever dropping the human-facing
// final turn or an approval/control message.
export type BurstLane = "control" | "normal" | "final";

export type BurstBreakerStatus = {
  destination: string;
  messages: number;
  turns: number;
  tripped: boolean;
  trippedUntil: number;
};

export type ResolvedBurstBreakerLimits = {
  enabled: boolean;
  maxTurns: number;
  maxMessages: number;
  windowMs: number;
  pausedMs: number;
};

type DestinationState = {
  windowStartedAt: number;
  messages: number;
  turns: number;
  trippedUntil: number;
};

export class OutboundBurstBreaker {
  private readonly limits: ResolvedBurstBreakerLimits;
  private readonly now: () => number;
  private readonly destinations = new Map<string, DestinationState>();
  private readonly onTrip?: (destination: string, status: BurstBreakerStatus) => void;

  constructor(options: {
    limits: ResolvedBurstBreakerLimits;
    now?: () => number;
    onTrip?: (destination: string, status: BurstBreakerStatus) => void;
  }) {
    this.limits = options.limits;
    this.now = options.now ?? (() => Date.now());
    this.onTrip = options.onTrip;
  }

  /**
   * Decide whether a send on `destination` may proceed. Control/approval
   * lane is always exempt; the final turn is never dropped. Returns false
   * only for a non-control, non-final send while the breaker is tripped.
   */
  allow(destination: string, lane: BurstLane = "normal"): boolean {
    if (!this.limits.enabled || lane === "control" || lane === "final") return true;
    const state = this.stateFor(destination);
    const now = this.now();
    if (state.trippedUntil > now) return false;
    if (state.trippedUntil !== 0 && state.trippedUntil <= now) {
      state.trippedUntil = 0;
      state.windowStartedAt = now;
      state.messages = 0;
      state.turns = 0;
    }
    return true;
  }

  /** Record a sent message; trips the breaker when the window limit is hit. */
  record(destination: string, lane: BurstLane = "normal", opts?: { turn?: boolean }): void {
    if (!this.limits.enabled || lane === "control") return;
    const state = this.stateFor(destination);
    const now = this.now();
    if (now - state.windowStartedAt > this.limits.windowMs) {
      state.windowStartedAt = now;
      state.messages = 0;
      state.turns = 0;
    }
    state.messages += 1;
    if (opts?.turn) state.turns += 1;
    const overMessages = state.messages >= this.limits.maxMessages;
    const overTurns = state.turns >= this.limits.maxTurns;
    // The final turn is delivered but still counts toward the window; it must
    // not itself trip the breaker, otherwise the reply to the user would be
    // the reason the next legitimate turn is paused.
    if ((overMessages || overTurns) && lane !== "final") {
      state.trippedUntil = now + this.limits.pausedMs;
      this.onTrip?.(destination, this.status(destination));
    } else if ((overMessages || overTurns) && lane === "final" && state.trippedUntil <= now) {
      // One message over an already-exhausted window still pauses the retry
      // lane, but without altering the final delivery semantics.
      state.trippedUntil = now + this.limits.pausedMs;
    }
  }

  isTripped(destination: string): boolean {
    const state = this.destinations.get(destination);
    if (!state) return false;
    return state.trippedUntil > this.now();
  }

  status(destination: string): BurstBreakerStatus {
    const state = this.destinations.get(destination);
    if (!state) {
      return { destination, messages: 0, turns: 0, tripped: false, trippedUntil: 0 };
    }
    return {
      destination,
      messages: state.messages,
      turns: state.turns,
      tripped: state.trippedUntil > this.now(),
      trippedUntil: state.trippedUntil,
    };
  }

  /** Clear the pause (used when an operator-visible turn resumes the lane). */
  reset(destination: string): void {
    this.destinations.delete(destination);
  }

  clear(): void {
    this.destinations.clear();
  }

  private stateFor(destination: string): DestinationState {
    const existing = this.destinations.get(destination);
    if (existing) return existing;
    const created: DestinationState = {
      windowStartedAt: this.now(),
      messages: 0,
      turns: 0,
      trippedUntil: 0,
    };
    this.destinations.set(destination, created);
    return created;
  }
}

const REGISTRY_KEY = Symbol.for("openclaw.xmpp.burstBreakers");

function registry(): Map<string, OutboundBurstBreaker> {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY] as Map<string, OutboundBurstBreaker>;
}

export function getOutboundBurstBreaker(
  accountId: string,
  limits: ResolvedBurstBreakerLimits,
  onTrip?: (destination: string, status: BurstBreakerStatus) => void,
): OutboundBurstBreaker {
  const existing = registry().get(accountId);
  if (existing) return existing;
  const created = new OutboundBurstBreaker({ limits, onTrip });
  registry().set(accountId, created);
  return created;
}

export function clearOutboundBurstBreaker(accountId: string): void {
  registry().delete(accountId);
}
