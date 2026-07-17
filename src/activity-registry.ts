type XmppActivity = {
  activity: "available" | "busy" | "paused";
  target?: string | null;
  since: number;
};

const REGISTRY_KEY = "__openclawXmppActivity";
const TIMERS_KEY = "__openclawXmppActivityTimers";
const BUSY_TTL_MS = 90_000;

type Registry = Map<string, XmppActivity>;
type Timers = Map<string, ReturnType<typeof setTimeout>>;

/**
 * Se invoca cuando un "busy" caduca sin que nadie lo haya limpiado.
 *
 * La presencia XMPP es estado RETENIDO por el servidor: olvidar el busy aquí no
 * basta, hay que emitir una presencia nueva o el contacto se queda en dnd para
 * siempre (así es como Rolando quedó "busy" durante horas: el turno murió entre
 * setTyping y clearTyping, y nadie volvió a hablarle al servidor). El emisor lo
 * registra el plugin al conectar.
 */
type ExpiryHandler = (accountId: string, target: string | null | undefined) => void;

const HANDLER_KEY = "__openclawXmppActivityExpiryHandler";

export function registerActivityExpiryHandler(handler: ExpiryHandler | null): void {
  const g = globalThis as typeof globalThis & { [HANDLER_KEY]?: ExpiryHandler | null };
  g[HANDLER_KEY] = handler;
}

function expiryHandler(): ExpiryHandler | null {
  const g = globalThis as typeof globalThis & { [HANDLER_KEY]?: ExpiryHandler | null };
  return g[HANDLER_KEY] ?? null;
}

function registry(): Registry {
  const g = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY]!;
}

function timers(): Timers {
  const g = globalThis as typeof globalThis & { [TIMERS_KEY]?: Timers };
  if (!g[TIMERS_KEY]) g[TIMERS_KEY] = new Map();
  return g[TIMERS_KEY]!;
}

function clearTimer(accountId: string): void {
  const timer = timers().get(accountId);
  if (!timer) return;
  clearTimeout(timer);
  timers().delete(accountId);
}

export function setXmppAccountActivity(
  accountId: string,
  activity: XmppActivity["activity"],
  target?: string | null,
): void {
  registry().set(accountId, { activity, target, since: Date.now() });
  clearTimer(accountId);

  // Sólo el busy caduca: available/paused son estados estables. El timer es la
  // red de seguridad para el turno que muere sin pasar por clearTypingXmpp().
  if (activity !== "busy") return;
  const timer = setTimeout(() => {
    timers().delete(accountId);
    const current = registry().get(accountId);
    if (current?.activity !== "busy") return;
    registry().delete(accountId);
    expiryHandler()?.(accountId, current.target);
  }, BUSY_TTL_MS);
  timer.unref?.();
  timers().set(accountId, timer);
}

export function getXmppAccountActivity(accountId: string): XmppActivity | null {
  const current = registry().get(accountId) ?? null;
  if (!current) return null;
  if (current.activity === "busy" && Date.now() - current.since > BUSY_TTL_MS) {
    registry().delete(accountId);
    clearTimer(accountId);
    return null;
  }
  return current;
}
