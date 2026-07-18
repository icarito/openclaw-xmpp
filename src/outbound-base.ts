// Xmpp plugin module implements outbound base behavior.
import {
  getExecApprovalReplyMetadata,
  matchesApprovalRequestFilters,
} from "openclaw/plugin-sdk/approval-runtime";
import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { chunkTextForOutbound } from "./channel-api.js";

type ApprovalForwardingConfig = {
  enabled?: boolean;
  mode?: string;
  agentFilter?: string[];
  sessionFilter?: string[];
};

/**
 * UN solo mecanismo de approvals en XMPP: cuando el forwarder del gateway va a
 * entregar la card nativa (approvals.exec/plugin mode "session"), el prompt
 * LOCAL del turno —el payload con channelData.execApproval que el dispatch
 * entregaría además a la misma conversación— se suprime. Sin esto el usuario
 * recibía la solicitud DOS veces: la card compacta con botones (forwarder) y
 * el bloque de texto del turno. Mismo patrón que Telegram
 * (shouldSuppressLocalTelegramExecApprovalPrompt).
 */
function shouldSuppressLocalXmppApprovalPrompt(params: {
  cfg?: {
    approvals?: {
      exec?: ApprovalForwardingConfig;
      plugin?: ApprovalForwardingConfig;
    };
  };
  payload: unknown;
}): boolean {
  const meta = getExecApprovalReplyMetadata(params.payload as never);
  if (!meta) {
    return false;
  }
  const forwarding =
    meta.approvalKind === "plugin"
      ? params.cfg?.approvals?.plugin
      : params.cfg?.approvals?.exec;
  if (forwarding?.enabled !== true) {
    return false;
  }
  // Sólo cuando el forwarder entrega a la conversación de la sesión (modo
  // "session"/"both", el default). En modo "targets" la card va a otro lado y
  // el prompt local sigue siendo la única señal en esta conversación.
  const mode = forwarding.mode ?? "session";
  if (mode !== "session" && mode !== "both") {
    return false;
  }
  // Si hay filtros configurados y este request no los pasa, el forwarder no
  // va a mandar card: no suprimir.
  return matchesApprovalRequestFilters({
    request: { agentId: meta.agentId ?? null, sessionKey: meta.sessionKey ?? null },
    agentFilter: forwarding.agentFilter,
    sessionFilter: forwarding.sessionFilter,
    fallbackAgentIdFromSessionKey: true,
  });
}

export const xmppOutboundBaseAdapter = {
  deliveryMode: "direct" as const,
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown" as const,
  textChunkLimit: 4000,
  presentationCapabilities: {
    buttons: true,
    selects: true,
    context: true,
    divider: true,
  },
  shouldSuppressLocalPayloadPrompt: (params: { cfg?: unknown; payload: unknown }) =>
    shouldSuppressLocalXmppApprovalPrompt({
      cfg: params.cfg as Parameters<typeof shouldSuppressLocalXmppApprovalPrompt>[0]["cfg"],
      payload: params.payload,
    }),
  renderPresentation: async ({
    payload,
    presentation,
  }: {
    payload: { channelData?: Record<string, unknown> };
    presentation: unknown;
  }) => ({
    ...payload,
    channelData: {
      ...(payload.channelData ?? {}),
      xmpp: {
        ...((payload.channelData?.xmpp as Record<string, unknown> | undefined) ?? {}),
        presentation,
      },
    },
  }),
  // XMPP <body> is plain text; markdownToPlain() in protocol.ts handles the
  // syntax stripping at send time. Still run the canonical delivery
  // sanitizer first so internal tool traces are dropped before formatting.
  sanitizeText: ({ text }: { text: string }) =>
    sanitizeForPlainText(sanitizeAssistantVisibleText(text)),
};
