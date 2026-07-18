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
};

type XmppFinalDelivery = {
  text: string;
};

type XmppPreparedTarget = {
  to: string;
};

type XmppPendingEntry = {
  jid: string;
  stanzaId: string;
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
  if (!isXmppAccountConfiguredForApprovals(params)) return false;
  const turnSourceChannel = normalizeOptionalLowercaseString(params.request.request.turnSourceChannel);
  if (turnSourceChannel !== "xmpp") return false;
  const turnSourceAccountId = normalizeOptionalString(params.request.request.turnSourceAccountId);
  const resolvedAccount = resolveXmppAccount({ cfg: params.cfg, accountId: params.accountId });
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
  if (params.approvalKind === "plugin") {
    const payload = buildPluginApprovalPendingReplyPayload({
      request: params.request as PluginApprovalRequest,
      nowMs: params.nowMs,
    });
    return {
      text: payload.text ?? "",
      presentation: payload.presentation as Record<string, unknown> | undefined,
      channelData: payload.channelData,
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
      target: { to: plannedTarget.target.to },
    }),
    deliverPending: async ({ cfg, accountId, preparedTarget, pendingPayload }) => {
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
          accountId,
        },
      );
      return {
        jid: result.target,
        stanzaId: result.messageId,
      };
    },
    updateEntry: async ({ cfg, accountId, entry, payload }) => {
      const { sendEditXmpp } = await loadXmppSendRuntime();
      await sendEditXmpp(entry.jid, payload.text, entry.stanzaId, {
        cfg: cfg as CoreConfig,
        accountId,
      });
    },
  },
  observe: {
    onDeliveryError: ({ error, request }) => {
      log.error(`xmpp approvals: failed to deliver request ${request.id}: ${String(error)}`);
    },
  },
});
