// Xmpp plugin module classifies outbound delivery failures (change
// xmpp-first-class-channel, tarea 3.4). A failure must never start an
// unbounded automatic retry chain: retryable errors get bounded backoff,
// fatal/duplicate errors are dead-lettered.
export type DeliveryFailureClass = "retryable" | "fatal" | "duplicate";

export type ClassifiedDeliveryFailure = {
  errorClass: DeliveryFailureClass;
  message: string;
  retryable: boolean;
  deadLetter: boolean;
};

const DUPLICATE_PATTERNS = [/duplicate[-_ ]?commit/i, /already (been )?committed/i, /duplicate delivery/i];

const FATAL_PATTERNS = [
  /invalid jid/i,
  /invalid (xmpp )?target/i,
  /not a valid (jid|target)/i,
  /malformed/i,
  /forbidden/i,
  /not[-_ ]authorized/i,
  /policy/i,
  /unsupported/i,
  /encryption required/i,
  /no compatible devices/i,
  /jid.*(does not exist|unknown)/i,
  /service-unavailable/i,
];

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? `; cause=${cause.message}` : "";
    return `${error.name}: ${error.message}${causeText}`;
  }
  return String(error);
}

/**
 * Explicit classification wins when a caller already tagged the error (the
 * spool does this for duplicate-commit). Otherwise classify by shape/message.
 */
export function classifyDeliveryError(error: unknown): ClassifiedDeliveryFailure {
  const explicit = (error as { deliveryClass?: unknown } | undefined)?.deliveryClass;
  const message = messageOf(error);

  let errorClass: DeliveryFailureClass;
  if (explicit === "retryable" || explicit === "fatal" || explicit === "duplicate") {
    errorClass = explicit;
  } else if (DUPLICATE_PATTERNS.some((pattern) => pattern.test(message))) {
    errorClass = "duplicate";
  } else if (FATAL_PATTERNS.some((pattern) => pattern.test(message))) {
    errorClass = "fatal";
  } else {
    errorClass = "retryable";
  }

  return {
    errorClass,
    message,
    retryable: errorClass === "retryable",
    deadLetter: errorClass !== "retryable",
  };
}

/** Bounded exponential backoff for retryable failures. */
export function computeBackoffMs(
  attempts: number,
  baseMs: number,
  maxMs: number,
): number {
  const safeAttempts = Math.max(1, Math.floor(attempts));
  const raw = baseMs * 2 ** Math.min(safeAttempts - 1, 10);
  return Math.min(raw, maxMs);
}
