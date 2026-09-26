// Xmpp plugin module implements inbound debounce (change
// xmpp-first-class-channel, tarea 3.1). Bursts from the same sender inside a
// configurable window are merged into a single synthetic turn, combining text
// and attachments, without breaking MUC mention detection or `steer`.
import type { XmppInboundMessage } from "./types.js";

export type InboundDebounceEntry = {
  key: string;
  message: XmppInboundMessage;
};

export type InboundDebouncerOptions = {
  windowMs: number;
  now?: () => number;
  flush: (message: XmppInboundMessage) => void | Promise<void>;
  /** Hard cap so a long burst cannot grow the merged turn without bound. */
  maxBatch?: number;
};

const DEFAULT_MAX_BATCH = 20;

/**
 * Merge a burst of messages from one sender into one synthetic turn.
 * Preserves original order, concatenates text, folds extra attachments into
 * the body (XmppInboundMessage carries a single oobUrl), and ORs the mention
 * and encryption flags.
 */
export function mergeXmppInboundMessages(messages: XmppInboundMessage[]): XmppInboundMessage {
  const first = messages[0]!;
  if (messages.length === 1) return first;
  const texts: string[] = [];
  let oobUrl: string | undefined;
  for (const message of messages) {
    const text = message.text?.trim();
    if (text) texts.push(text);
    if (message.oobUrl) {
      if (!oobUrl) oobUrl = message.oobUrl;
      else if (message.oobUrl !== oobUrl) texts.push(message.oobUrl);
    }
  }
  const replyTo = messages.find((message) => message.replyTo)?.replyTo;
  return {
    ...first,
    text: texts.join("\n"),
    ...(oobUrl ? { oobUrl } : {}),
    ...(replyTo ? { replyTo } : {}),
    wasMentioned: messages.some((message) => message.wasMentioned),
    isCarbonCopy: messages.some((message) => message.isCarbonCopy),
    wasEncrypted: messages.some((message) => message.wasEncrypted),
  };
}

export class InboundDebouncer {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly flush: (message: XmppInboundMessage) => void | Promise<void>;
  private readonly maxBatch: number;
  private readonly batches = new Map<string, { messages: XmppInboundMessage[]; timer: ReturnType<typeof setTimeout> }>();

  constructor(options: InboundDebouncerOptions) {
    this.windowMs = options.windowMs;
    this.now = options.now ?? (() => Date.now());
    this.flush = options.flush;
    this.maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH;
  }

  /** Push a message into the batch for `key`, resetting the window timer. */
  push(key: string, message: XmppInboundMessage): void {
    const existing = this.batches.get(key);
    if (existing) {
      existing.messages.push(message);
      if (existing.messages.length >= this.maxBatch) {
        this.dispatch(key);
        return;
      }
      clearTimeout(existing.timer);
      existing.timer = this.arm(key);
      return;
    }
    this.batches.set(key, { messages: [message], timer: this.arm(key) });
  }

  hasPending(key?: string): boolean {
    if (key) return this.batches.has(key);
    return this.batches.size > 0;
  }

  /** Flush one batch now (used on shutdown or when a command arrives). */
  flushKey(key: string): void {
    this.dispatch(key);
  }

  flushAll(): void {
    for (const key of [...this.batches.keys()]) this.dispatch(key);
  }

  /** Drop all pending batches without dispatching them. */
  clear(): void {
    for (const batch of this.batches.values()) clearTimeout(batch.timer);
    this.batches.clear();
  }

  private arm(key: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.dispatch(key), this.windowMs);
    timer.unref?.();
    return timer;
  }

  private dispatch(key: string): void {
    const batch = this.batches.get(key);
    if (!batch) return;
    clearTimeout(batch.timer);
    this.batches.delete(key);
    void this.flush(mergeXmppInboundMessages(batch.messages));
  }
}

/**
 * Whether a message should participate in debounce. Control commands and
 * MUC messages explicitly directed at a single mention during an active turn
 * (`steer`) stay immediate; everything else from an authorized sender is
 * batched.
 */
export function shouldDebounceInbound(params: {
  message: XmppInboundMessage;
  isControlCommand: boolean;
  hasPendingInteraction: boolean;
  turnBusy: boolean;
}): boolean {
  if (params.isControlCommand || params.hasPendingInteraction) return false;
  // Steering an in-flight turn must not be delayed behind the debounce window.
  if (params.turnBusy) return false;
  return true;
}
