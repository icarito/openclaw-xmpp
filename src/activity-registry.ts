type XmppActivity = {
  activity: "available" | "busy" | "paused" | "pending";
  target?: string | null;
  since: number;
  /** Sólo para "pending": cuántos mensajes de este remitente están en cola sin procesar. */
  pendingCount?: number;
};

const REGISTRY_KEY = "__openclawXmppActivity";
const TIMERS_KEY = "__openclawXmppActivityTimers";
const BUSY_TTL_MS = 90_000;
// El turno normalmente arranca en segundos; si "pending" dura más que esto es
// que el turno nunca llegó a empezar (crash, cola atascada), así que caduca
// igual que busy -- mismo motivo, mismo mecanismo.
const PENDING_TTL_MS = 90_000;

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

  // Sólo busy/pending caducan: available/paused son estados estables. El timer
  // es la red de seguridad para un turno que muere sin limpiar tras de sí.
  if (activity !== "busy" && activity !== "pending") return;
  const ttl = activity === "busy" ? BUSY_TTL_MS : PENDING_TTL_MS;
  const timer = setTimeout(() => {
    timers().delete(accountId);
    const current = registry().get(accountId);
    if (current?.activity !== activity) return;
    registry().delete(accountId);
    expiryHandler()?.(accountId, current.target);
  }, ttl);
  timer.unref?.();
  timers().set(accountId, timer);
}

export function clearXmppAccountActivity(accountId: string): XmppActivity | null {
  const current = registry().get(accountId) ?? null;
  registry().delete(accountId);
  clearTimer(accountId);
  if (current?.activity === "busy" || current?.activity === "pending") {
    expiryHandler()?.(accountId, current.target);
  }
  return current;
}

/**
 * Un mensaje nuevo entra a la cola del agente.
 *
 * Si el agente ya está "busy" (procesando un turno anterior) NO baja a
 * "pending": ese estado ya cuenta más -- el remitente ya sabe que hay
 * actividad -- y pisarlo perdería la señal de "está trabajando" a cambio de
 * una menos informativa. Sólo se usa "pending" mientras el agente está
 * disponible/ausente y aún no arrancó ningún turno para este mensaje.
 */
export function markXmppMessagePending(accountId: string, target?: string | null): void {
  const current = registry().get(accountId);
  if (current?.activity === "busy") return;
  const pendingCount = (current?.activity === "pending" ? current.pendingCount ?? 0 : 0) + 1;
  registry().set(accountId, { activity: "pending", target, since: Date.now(), pendingCount });
  clearTimer(accountId);
  const timer = setTimeout(() => {
    timers().delete(accountId);
    const latest = registry().get(accountId);
    if (latest?.activity !== "pending") return;
    registry().delete(accountId);
    expiryHandler()?.(accountId, latest.target);
  }, PENDING_TTL_MS);
  timer.unref?.();
  timers().set(accountId, timer);
}

export function getXmppAccountActivity(accountId: string): XmppActivity | null {
  const current = registry().get(accountId) ?? null;
  if (!current) return null;
  const ttl = current.activity === "busy" ? BUSY_TTL_MS
    : current.activity === "pending" ? PENDING_TTL_MS
    : null;
  if (ttl !== null && Date.now() - current.since > ttl) {
    registry().delete(accountId);
    clearTimer(accountId);
    return null;
  }
  return current;
}
