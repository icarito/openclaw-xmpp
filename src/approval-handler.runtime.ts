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

/** Una sola aprobación pendiente por sesión. Ver incidente 2026-07-19:
 *  2 exec calls paralelos del mismo turno → 2 approvals → el manager
 *  upstream pierde la segunda → Promise huérfana → turno bloqueado.
 *  Prevenimos en origen: la segunda approval se rechaza a nivel plugin
 *  y el core devuelve un error al agente. */
const activeSessionApprovals = new Set<string>();

function trackApproval(sessionKey: string): boolean {
  if (activeSessionApprovals.has(sessionKey)) return false;
  activeSessionApprovals.add(sessionKey);
  return true;
}

function untrackApproval(sessionKey: string): void {
  activeSessionApprovals.delete(sessionKey);
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

/** An approval belongs to this XMPP account only if the originating turn was XMPP on the same account. */
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
  if (turnSourceAccountId) return turnSourceAccountId === handlerAccount.accountId;
  const sessionKey = normalizeOptionalString(params.request.request.sessionKey);
  if (!sessionKey?.startsWith(`agent:${handlerAccount.accountId}:`)) return false;
  return trackApproval(sessionKey);
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
      const sessionKey = normalizeOptionalString(request.request.sessionKey);
      if (sessionKey) untrackApproval(sessionKey);
    },
  },
});
