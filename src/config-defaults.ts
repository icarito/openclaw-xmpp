// Xmpp helper module centralizes the defaults for the reliability/history/
// hooks config sections (change xmpp-first-class-channel, tarea 1.2) so the
// zod schema in config-schema.ts and the runtime resolvers in send/monitor
// share one source of truth.
import type {
  XmppAccountConfig,
  XmppHistoryConfig,
  XmppHooksConfig,
  XmppReliabilityConfig,
} from "./types.js";

export const DEFAULT_DEBOUNCE_WINDOW_MS = 1_500;
export const DEFAULT_DISPATCH_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_SPOOL_MAX_ATTEMPTS = 5;
export const DEFAULT_SPOOL_BACKOFF_BASE_MS = 5_000;
export const DEFAULT_SPOOL_BACKOFF_MAX_MS = 5 * 60 * 1000;
export const DEFAULT_BURST_MAX_TURNS = 6;
export const DEFAULT_BURST_MAX_MESSAGES = 12;
export const DEFAULT_BURST_WINDOW_MS = 10_000;
export const DEFAULT_BURST_PAUSED_MS = 60_000;
export const DEFAULT_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_HISTORY_MAX_PAGES = 4;
export const DEFAULT_HISTORY_MUC_MAX_STANZAS = 0;

export type ResolvedDebounceConfig = {
  enabled: boolean;
  windowMs: number;
};

export type ResolvedBurstBreakerConfig = {
  enabled: boolean;
  maxTurns: number;
  maxMessages: number;
  windowMs: number;
  pausedMs: number;
};

export type ResolvedSpoolConfig = {
  enabled: boolean;
  resendOnReconnect: boolean;
  maxAgeMs: number;
  maxAttempts: number;
};

export type ResolvedDispatchDedupeConfig = {
  enabled: boolean;
  ttlMs: number;
};

export type ResolvedReliabilityConfig = {
  debounce: ResolvedDebounceConfig;
  burstBreaker: ResolvedBurstBreakerConfig;
  spool: ResolvedSpoolConfig;
  dispatchDedupe: ResolvedDispatchDedupeConfig;
};

export type ResolvedHistoryConfig = {
  catchup: boolean;
  spawnTurns: boolean;
  windowMs: number;
  maxPages: number;
  mucMaxStanzas: number;
};

export type ResolvedHooksConfig = {
  pepEvents: boolean;
  reactions: boolean;
  receipts: boolean;
};

export function resolveReliabilityConfig(
  config: Pick<XmppAccountConfig, "reliability"> | undefined,
): ResolvedReliabilityConfig {
  const raw: XmppReliabilityConfig = config?.reliability ?? {};
  return {
    debounce: {
      enabled: raw.debounce?.enabled !== false,
      windowMs: positiveOr(raw.debounce?.windowMs, DEFAULT_DEBOUNCE_WINDOW_MS),
    },
    burstBreaker: {
      enabled: raw.burstBreaker?.enabled !== false,
      maxTurns: positiveOr(raw.burstBreaker?.maxTurns, DEFAULT_BURST_MAX_TURNS),
      maxMessages: positiveOr(raw.burstBreaker?.maxMessages, DEFAULT_BURST_MAX_MESSAGES),
      windowMs: positiveOr(raw.burstBreaker?.windowMs, DEFAULT_BURST_WINDOW_MS),
      pausedMs: positiveOr(raw.burstBreaker?.pausedMs, DEFAULT_BURST_PAUSED_MS),
    },
    spool: {
      enabled: raw.spool?.enabled !== false,
      resendOnReconnect: raw.spool?.resendOnReconnect !== false,
      maxAgeMs: positiveOr(raw.spool?.maxAgeMs, DEFAULT_SPOOL_MAX_AGE_MS),
      maxAttempts: positiveOr(raw.spool?.maxAttempts, DEFAULT_SPOOL_MAX_ATTEMPTS),
    },
    dispatchDedupe: {
      enabled: raw.dispatchDedupe?.enabled !== false,
      ttlMs: positiveOr(raw.dispatchDedupe?.ttlMs, DEFAULT_DISPATCH_DEDUPE_TTL_MS),
    },
  };
}

export function resolveHistoryConfig(
  config: Pick<XmppAccountConfig, "history"> | undefined,
): ResolvedHistoryConfig {
  const raw: XmppHistoryConfig = config?.history ?? {};
  return {
    catchup: raw.catchup === true,
    spawnTurns: raw.spawnTurns === true,
    windowMs: positiveOr(raw.windowMs, DEFAULT_HISTORY_WINDOW_MS),
    maxPages: positiveOr(raw.maxPages, DEFAULT_HISTORY_MAX_PAGES),
    mucMaxStanzas: nonNegativeOr(raw.mucMaxStanzas, DEFAULT_HISTORY_MUC_MAX_STANZAS),
  };
}

export function resolveHooksConfig(
  config: Pick<XmppAccountConfig, "hooks"> | undefined,
): ResolvedHooksConfig {
  const raw: XmppHooksConfig = config?.hooks ?? {};
  return {
    pepEvents: raw.pepEvents === true,
    reactions: raw.reactions === true,
    receipts: raw.receipts !== false,
  };
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
