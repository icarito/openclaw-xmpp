// Xmpp plugin module implements the native exec/plugin approval runtime.
//
// This lets the gateway wait in-line for an XMPP-originated exec approval
// decision (see NATIVE_APPROVAL_CHANNELS in the core) instead of the
// fire-and-forget followup path, which lost track of pending approvals and
// caused the agent to retry the same command in a loop. Reuses the payload
// builders and quick-response/XEP-0308 delivery already used by the
// forwarder-based approval flow (see channel.ts's approvalCapability.render)
// — this module only adds the presentation/transport plumbing the core
// needs to resolve the decision synchronously.
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import type {
  ChannelApprovalCapabilityHandlerContext,
  PendingApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  buildApprovalResolvedReplyPayload,
  buildExecApprovalPendingReplyPayload,
  buildPluginApprovalPendingReplyPayload,
  resolveExecApprovalCommandDisplay,
  resolveExecApprovalRequestAllowedDecisions,
} from "openclaw/plugin-sdk/approval-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalLowercaseString, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveXmppAccount } from "./accounts.js";
import { normalizeXmppAllowEntry } from "./normalize.js";
import { resolveInlineButtonsScope } from "./outbound-render.js";
import type { CoreConfig } from "./types.js";

const log = createSubsystemLogger("xmpp/approvals");

const repromptTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelRepromptByApprovalId(approvalId: string): void {
  const timer = repromptTimers.get(approvalId);
  if (timer) {
    clearTimeout(timer);
    repromptTimers.delete(approvalId);
  }
}

/** Datos mínimos para cancelar una card ya entregada desde fuera del ciclo
 *  del core (ver cancelApprovalsForSession). */
export type XmppInFlightApproval = {
  approvalId: string;
  jid: string;
  stanzaId: string;
  accountId?: string;
  commandText?: string;
};

/** Una sola aprobación pendiente por sesión. Ver incidente 2026-07-19:
 *  2 exec calls paralelos del mismo turno → 2 approvals → el manager
 *  upstream pierde la segunda → Promise huérfana → turno bloqueado.
 *  Prevenimos en origen: la segunda approval se rechaza a nivel plugin
 *  y el core devuelve un error al agente.
 *
 *  Es un Map y no un Set porque además de ocupar la ranura guarda con qué
 *  card se ocupó: sin eso no se puede cancelar al morir la sesión. El valor
 *  se completa en deliverPending (la ranura se toma antes de tener stanzaId,
 *  así que arranca en undefined). */
const activeSessionApprovals = new Map<string, XmppInFlightApproval | undefined>();

function trackApproval(sessionKey: string): boolean {
  if (activeSessionApprovals.has(sessionKey)) return false;
  activeSessionApprovals.set(sessionKey, undefined);
  return true;
}

function rememberInFlightApproval(sessionKey: string, entry: XmppInFlightApproval): void {
  if (!activeSessionApprovals.has(sessionKey)) return;
  activeSessionApprovals.set(sessionKey, entry);
}

function untrackApproval(sessionKey: string): void {
  activeSessionApprovals.delete(sessionKey);
}

/** Rechazo por guard de concurrencia, NO un fallo de entrega.
 *  Se distingue por tipo porque onDeliveryError debe liberar el guard cuando
 *  la entrega falló de verdad, pero NUNCA cuando fue el propio guard quien
 *  rechazó: ese sessionKey pertenece a la aprobación que sigue en vuelo, y
 *  liberarlo reabriría el bug de las promesas huérfanas por otra puerta. */
class XmppApprovalGuardRejection extends Error {
  readonly isGuardRejection = true;
}

function isGuardRejection(error: unknown): boolean {
  return error instanceof XmppApprovalGuardRejection;
}

/** Terminal en el gateway: la decisión ya no está pendiente. Tratarlo como
 *  éxito hace la cancelación idempotente (mismo criterio que
 *  tryResolveXmppApprovalCommand en native-commands.ts). */
function isAlreadyTerminal(error: unknown): boolean {
  return /already resolved|no longer pending|not found|expired/i.test(String(error));
}

/**
 * Cancela las aprobaciones en vuelo de una sesión que terminó.
 *
 * Sin esto, una aprobación cuya sesión murió se queda en pantalla hasta que
 * vence su timeout: el core no tiene ninguna salida por sesión (resolve /
 * expire / consumeAllowOnce, ninguna acepta sessionKey), y `onStopped` del
 * runtime nativo tampoco edita las cards.
 *
 * ALCANCE REAL: hoy solo la invoca el hook `session_end` (ver index.ts), que
 * cubre reciclado de sesión y apagado ordenado del gateway. Un turno abortado
 * o caído con la aprobación pendiente NO llega aquí — ver la nota en index.ts
 * sobre por qué agent_end no sirve. Esas cards siguen expirando por timeout.
 *
 * Orden deliberado — primero el gateway, después la card:
 * `resolveApprovalOverGateway` con `deny` saca la entrada de pendientes, así
 * que una respuesta tardía desde otro cliente recibe "already resolved" en vez
 * de despertar una sesión nueva con el resultado de un exec sin contexto (el
 * guard `session_rebound` NO cubre este caso: su predicado exige que el
 * sessionId resuelto exista y difiera, y con la sesión muerta es undefined).
 * Si esa resolución falla no editamos nada: es preferible una card viva que
 * decir "cancelada" sobre algo que el usuario todavía puede aprobar.
 *
 * `deny` y no otra decisión porque además activa `shouldSuppressExecDeniedFollowup`
 * en el core, la única supresión de followup que existe.
 */
export async function cancelApprovalsForSession(params: {
  cfg: CoreConfig;
  sessionKey: string;
  reason: string;
}): Promise<void> {
  const inFlight = activeSessionApprovals.get(params.sessionKey);
  if (!inFlight) return;

  try {
    await resolveApprovalOverGateway({
      cfg: params.cfg,
      approvalId: inFlight.approvalId,
      decision: "deny",
      senderId: "xmpp-session-cancel",
      clientDisplayName: "XMPP session cancel",
      allowPluginFallback: true,
    });
  } catch (error) {
    if (!isAlreadyTerminal(error)) {
      log.warn(
        `xmpp approvals: no se pudo cancelar ${inFlight.approvalId} en el gateway (${params.reason}): ${String(error)} — la card queda viva a propósito`,
      );
      return;
    }
  }

  untrackApproval(params.sessionKey);
  cancelRepromptByApprovalId(inFlight.stanzaId);

  try {
    const { sendEditXmpp } = await loadXmppSendRuntime();
    const suffix = inFlight.commandText ? ` — ${inFlight.commandText}` : "";
    await sendEditXmpp(
      inFlight.jid,
      `🛑 Aprobación cancelada: la sesión terminó${suffix}`,
      inFlight.stanzaId,
      { cfg: params.cfg, accountId: inFlight.accountId },
    );
    log.info(
      `xmpp approvals: cancelada ${inFlight.approvalId} por fin de sesión (${params.reason})`,
    );
  } catch (error) {
    // El gateway ya la denegó, así que el estado es consistente aunque la
    // edición no llegue; los clientes la retirarán por expiry.
    log.warn(`xmpp approvals: cancelación entregada a medias: ${String(error)}`);
  }
}

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;

type XmppPendingDelivery = {
  text: string;
  presentation?: Record<string, unknown>;
  channelData?: Record<string, unknown>;
  accountId?: string;
};

type XmppFinalDelivery = {
  text: string;
};

type XmppPreparedTarget = {
  to: string;
  accountId?: string;
};

type XmppPendingEntry = {
  jid: string;
  stanzaId: string;
  accountId?: string;
  sessionKey?: string;
};

type XmppApprovalHandlerContext = {
  accountId?: string;
};

function resolveHandlerContext(params: ChannelApprovalCapabilityHandlerContext): {
  cfg: CoreConfig;
  accountId?: string;
} {
  return {
    cfg: params.cfg as CoreConfig,
    accountId: normalizeOptionalString(params.accountId ?? undefined),
  };
}

function isXmppAccountConfiguredForApprovals(params: { cfg: CoreConfig; accountId?: string }): boolean {
  const account = resolveXmppAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) return false;
  if ((account.config.allowFrom ?? []).length === 0) return false;
  return resolveInlineButtonsScope(account.config.capabilities) !== "off";
}

/** An approval belongs to this XMPP account only if the originating turn was XMPP on the same account.
 *
 *  Esta función es PURA: decide, no marca. El guard de sesión
 *  (activeSessionApprovals) se toma en deliverPending, la única fase donde
 *  existen rutas de liberación (updateEntry / onDeliveryError).
 *
 *  Incidente 2026-07-19: marcar aquí filtraba el sessionKey para siempre.
 *  shouldHandle aceptaba por el fallback de sessionKey sin exigir
 *  turnSourceTo, pero resolveOriginTarget devuelve null sin turnSourceTo →
 *  deliveryPlan.targets vacío → el bucle de entrega del core nunca corre →
 *  ni deliverPending ni onDeliveryError → sessionKey trabado en un Set sin
 *  TTL. Como trackApproval devuelve false para una clave ya marcada, UN solo
 *  request no entregado bloqueaba TODAS las approvals futuras de esa sesión,
 *  de forma silenciosa (el core solo reporta reportSkipped: sin card, sin
 *  error). Por eso exigimos aquí la misma precondición que
 *  resolveOriginTarget: si no se puede entregar, no se reclama. */
function shouldHandleXmppApprovalRequest(params: {
  cfg: CoreConfig;
  accountId?: string;
  request: ApprovalRequest;
}): boolean {
  const turnSourceChannel = normalizeOptionalLowercaseString(params.request.request.turnSourceChannel);
  const turnSourceAccountId = normalizeOptionalString(params.request.request.turnSourceAccountId);
  // El ancla SIEMPRE es la cuenta PROPIA del handler (params.accountId).
  // Con un handler por cuenta (flota completa), comparar contra una cuenta
  // derivada del propio request hace que TODOS los handlers reclamen TODOS
  // los approvals: un approval → 8 cards duplicadas (incidente 2026-07-19
  // 04:26 UTC, "delivering pending card" ×8 para el mismo request).
  const handlerAccount = resolveXmppAccount({ cfg: params.cfg, accountId: params.accountId });
  if (
    !isXmppAccountConfiguredForApprovals({ cfg: params.cfg, accountId: handlerAccount.accountId })
  ) {
    return false;
  }
  if (turnSourceChannel && turnSourceChannel !== "xmpp") return false;
  // Sin turnSourceTo no hay destino entregable (ver resolveOriginTarget).
  // Reclamar un approval que no podemos entregar lo deja huérfano: el core
  // lo saca de pending y ningún otro handler lo recoge.
  if (!normalizeOptionalString(params.request.request.turnSourceTo)) return false;
  if (turnSourceAccountId) return turnSourceAccountId === handlerAccount.accountId;
  const sessionKey = normalizeOptionalString(params.request.request.sessionKey);
  return Boolean(sessionKey?.startsWith(`agent:${handlerAccount.accountId}:`));
}

function buildXmppPendingPayload(params: {
  request: ApprovalRequest;
  approvalKind: "exec" | "plugin";
  nowMs: number;
  view: PendingApprovalView;
}): XmppPendingDelivery {
  const accountId = normalizeOptionalString(params.request.request.turnSourceAccountId);
  if (params.approvalKind === "plugin") {
    const payload = buildPluginApprovalPendingReplyPayload({
      request: params.request as PluginApprovalRequest,
      nowMs: params.nowMs,
    });
    return {
      text: payload.text ?? "",
      presentation: payload.presentation as Record<string, unknown> | undefined,
      channelData: payload.channelData,
      ...(accountId ? { accountId } : {}),
    };
  }
  const request = params.request as ExecApprovalRequest;
  const commandText = resolveExecApprovalCommandDisplay(request.request).commandText;
  const allowedDecisions = resolveExecApprovalRequestAllowedDecisions(request.request);
  const payload = buildExecApprovalPendingReplyPayload({
    approvalId: request.id,
    approvalSlug: request.id.slice(0, 8),
    approvalCommandId: request.id,
    warningText: request.request.warningText ?? undefined,
    command: commandText,
    cwd: request.request.cwd ?? undefined,
    host: request.request.host === "node" ? "node" : "gateway",
    nodeId: request.request.nodeId ?? undefined,
    allowedDecisions,
    expiresAtMs: request.expiresAtMs,
    nowMs: params.nowMs,
  });
  return {
    text: payload.text ?? "",
    presentation: payload.presentation as Record<string, unknown> | undefined,
    channelData: payload.channelData,
    ...(accountId ? { accountId } : {}),
  };
}

function buildXmppResolvedText(params: {
  decision: string;
  resolvedBy?: string | null;
  commandText?: string;
}): string {
  const icon = params.decision === "deny" ? "🚫" : "✅";
  const label =
    params.decision === "deny"
      ? "denegado"
      : params.decision === "allow-always"
        ? "aprobado (siempre)"
        : "aprobado";
  const command = params.commandText ? ` — ${params.commandText}` : "";
  return `${icon} ${label}${command}`;
}

async function loadXmppSendRuntime() {
  // Lazy import mirrors channel.ts's createLazyRuntimeModule(channel-runtime.js)
  // pattern -- keeps the connection/protocol modules out of the cold-start path.
  return await import("./channel-runtime.js");
}

export const xmppApprovalNativeAdapter = {
  describeDeliveryCapabilities: ({ cfg, accountId }: { cfg: CoreConfig; accountId?: string | null }) => {
    const enabled = isXmppAccountConfiguredForApprovals({
      cfg,
      accountId: accountId ?? undefined,
    });
    return {
      enabled,
      preferredSurface: "origin" as const,
      supportsOriginSurface: enabled,
      supportsApproverDmSurface: false,
    };
  },
  resolveOriginTarget: ({ request }: { request: ApprovalRequest }) => {
    const raw = normalizeOptionalString(request.request.turnSourceTo);
    if (!raw) return null;
    const to = raw.replace(/^xmpp:/i, "").trim();
    const accountId = normalizeOptionalString(request.request.turnSourceAccountId);
    return to ? { to, ...(accountId ? { accountId } : {}) } : null;
  },
};

export const xmppApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  XmppPendingDelivery,
  XmppPreparedTarget,
  XmppPendingEntry,
  never,
  XmppFinalDelivery
>({
  eventKinds: ["exec", "plugin"],
  availability: {
    isConfigured: (params) => {
      const resolved = resolveHandlerContext(params);
      return isXmppAccountConfiguredForApprovals(resolved);
    },
    shouldHandle: (params) => {
      const resolved = resolveHandlerContext(params);
      return shouldHandleXmppApprovalRequest({ ...resolved, request: params.request });
    },
  },
  presentation: {
    buildPendingPayload: ({ request, approvalKind, nowMs, view }) =>
      buildXmppPendingPayload({ request, approvalKind, nowMs, view }),
    buildResolvedResult: ({ view }) => ({
      kind: "update",
      payload: {
        text: buildXmppResolvedText({
          decision: view.decision,
          resolvedBy: view.resolvedBy,
          commandText: view.approvalKind === "exec" ? view.commandText : undefined,
        }),
      },
    }),
    buildExpiredResult: ({ view }) => ({
      kind: "update",
      payload: {
        text: `⌛ Aprobación expirada${view.approvalKind === "exec" ? ` — ${view.commandText}` : ""}`,
      },
    }),
  },
  transport: {
    prepareTarget: ({ plannedTarget }) => ({
      dedupeKey: buildChannelApprovalNativeTargetKey(plannedTarget.target),
      // accountId viaja en el planned target en runtime aunque el tipo del SDK
      // (ChannelApprovalNativeTarget) no lo declare todavía.
      target: {
        to: plannedTarget.target.to,
        accountId: (plannedTarget.target as { to: string; accountId?: string }).accountId,
      },
    }),
    deliverPending: async ({ cfg, accountId, preparedTarget, pendingPayload, request, view }) => {
      // Guard anti-paralelo: se toma AQUÍ, no en shouldHandle. Esta es la
      // primera fase con rutas de liberación garantizadas (updateEntry al
      // resolver/expirar, onDeliveryError al fallar). Ver nota en
      // shouldHandleXmppApprovalRequest.
      const guardSessionKey = normalizeOptionalString(request.request.sessionKey);
      if (guardSessionKey && !trackApproval(guardSessionKey)) {
        log.warn(
          `xmpp approvals: sesión ${guardSessionKey} ya tiene una aprobación en vuelo; se omite la segunda`,
        );
        // Antes este rechazo era silencioso para el usuario: onDeliveryError
        // ve isGuardRejection y no hace nada (a propósito, para no liberar la
        // ranura que sigue ocupada por la aprobación en vuelo), así que ni
        // card ni texto llegaban al chat — solo un log. La única esperanza de
        // que el usuario se enterara era que el agente narrara el toolResult
        // de la llamada exec rechazada, algo que no está garantizado y que
        // verificamos que upstream (2026.7.1) también delega al agente en su
        // propio guard equivalente (ver sessionApprovalMergeKey en
        // exec-approval). Se manda un aviso directo, igual que el reprompt de
        // abajo, para no depender de esa narración.
        const blocking = activeSessionApprovals.get(guardSessionKey);
        try {
          const { sendPayloadXmpp: sendGuardNotice } = await loadXmppSendRuntime();
          const suffix = blocking?.approvalId
            ? ` (${blocking.approvalId.slice(0, 8)})`
            : "";
          await sendGuardNotice(
            preparedTarget.to,
            `⏳ Ya hay una aprobación pendiente para esta sesión${suffix}. `
              + `Resuelve esa antes de que se pueda pedir la siguiente.`,
            { text: "" },
            { cfg: cfg as CoreConfig, accountId: preparedTarget.accountId || accountId },
          );
        } catch (err) {
          // No perder el rechazo original por un fallo al avisar: se loguea
          // aparte y se sigue con el throw de abajo, que es lo que de verdad
          // libera al agente para reintentar más tarde.
          log.warn(`xmpp approvals: no se pudo avisar el rechazo por guard: ${String(err)}`);
        }
        throw new XmppApprovalGuardRejection(
          `xmpp approvals: aprobación concurrente rechazada para ${guardSessionKey}`,
        );
      }
      const deliveryAccountId = pendingPayload.accountId || preparedTarget.accountId || accountId;
      log.info(`xmpp approvals: delivering pending card to=${preparedTarget.to} account=${deliveryAccountId ?? "default"}`);
      const { sendPayloadXmpp } = await loadXmppSendRuntime();
      const result = await sendPayloadXmpp(
        preparedTarget.to,
        pendingPayload.text,
        {
          text: pendingPayload.text,
          ...(pendingPayload.presentation
            ? { presentation: pendingPayload.presentation as never }
            : {}),
          ...(pendingPayload.channelData ? { channelData: pendingPayload.channelData } : {}),
        },
        {
          cfg: cfg as CoreConfig,
          accountId: deliveryAccountId,
        },
      );

      // Re-prompt a los 2/3 del tiempo de expiración: si el usuario no ha
      // respondido, se manda un recordatorio para que no expire sin verlo.
      const expiresAtMs = request.expiresAtMs;
      if (expiresAtMs && expiresAtMs > Date.now()) {
        const remaining = expiresAtMs - Date.now();
        const repromptDelay = Math.max(30_000, Math.floor(remaining / 3));
        const stanzaKey = result.messageId;
        const timer = setTimeout(async () => {
          repromptTimers.delete(stanzaKey);
          try {
            const mins = Math.ceil(remaining / 60_000);
            const { sendPayloadXmpp: sendRepromptPayload } = await loadXmppSendRuntime();
            await sendRepromptPayload(
              preparedTarget.to,
              `⏳ Recordatorio: tienes una aprobación pendiente desde hace ${mins} min. Responde con /approve ${request.id.slice(0, 8)} <allow-once|allow-always|deny> o /abort para cancelarla. Expira pronto.`,
              { text: "" },
              { cfg: cfg as CoreConfig, accountId: deliveryAccountId },
            );
          } catch (err) {
            log.warn(`xmpp approvals: reprompt delivery failed: ${String(err)}`);
          }
        }, repromptDelay);
        repromptTimers.set(stanzaKey, timer);
      }

      // Guardamos con qué card se ocupó la ranura del guard: es lo único que
      // permite cancelarla si la sesión muere antes de que el usuario decida.
      if (guardSessionKey) {
        rememberInFlightApproval(guardSessionKey, {
          approvalId: request.id,
          jid: result.target,
          stanzaId: result.messageId,
          accountId: deliveryAccountId,
          commandText: view.approvalKind === "exec" ? view.commandText : undefined,
        });
      }

      return {
        jid: result.target,
        stanzaId: result.messageId,
        accountId: deliveryAccountId,
        sessionKey: normalizeOptionalString(request.request.sessionKey),
      };
    },
    updateEntry: async ({ cfg, accountId, entry, payload }) => {
      log.info(`xmpp approvals: updating card stanza=${entry.stanzaId}`);
      cancelRepromptByApprovalId(entry.stanzaId);
      if (entry.sessionKey) untrackApproval(entry.sessionKey);
      const { sendEditXmpp } = await loadXmppSendRuntime();
      await sendEditXmpp(entry.jid, payload.text, entry.stanzaId, {
        cfg: cfg as CoreConfig,
        accountId: entry.accountId || accountId,
      });
    },
  },
  observe: {
    onDeliveryError: ({ error, request }) => {
      log.error(`xmpp approvals: failed to deliver request ${request.id}: ${String(error)}`);
      // El guard rechazando no es un fallo de entrega: ese sessionKey lo
      // sostiene la aprobación que sigue en vuelo. Liberarlo aquí la dejaría
      // desprotegida. Ver XmppApprovalGuardRejection.
      if (isGuardRejection(error)) return;
      const sessionKey = normalizeOptionalString(request.request.sessionKey);
      if (sessionKey) untrackApproval(sessionKey);
    },
  },
});
