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
  const effective = { ...params, accountId: turnSourceAccountId || params.accountId };
  if (!isXmppAccountConfiguredForApprovals(effective)) return false;
  const resolvedAccount = resolveXmppAccount({ cfg: params.cfg, accountId: effective.accountId });
  if (turnSourceChannel && turnSourceChannel !== "xmpp") return false;
  if (!turnSourceChannel) {
    const sessionKey = normalizeOptionalString(params.request.request.sessionKey);
    if (!sessionKey?.startsWith(`agent:${resolvedAccount.accountId}:`)) return false;
  }
  // No explicit turnSourceAccountId on the request: fall back to matching the
  // default/resolved account, same as a request with no account scoping.
  if (!turnSourceAccountId) return true;
  return turnSourceAccountId === resolvedAccount.accountId;
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
    deliverPending: async ({ cfg, accountId, preparedTarget, pendingPayload }) => {
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
      return {
        jid: result.target,
        stanzaId: result.messageId,
        accountId: deliveryAccountId,
      };
    },
    updateEntry: async ({ cfg, accountId, entry, payload }) => {
      log.info(`xmpp approvals: updating card stanza=${entry.stanzaId}`);
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
    },
  },
});
