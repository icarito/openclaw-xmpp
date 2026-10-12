// Xmpp plugin module implements message adapter behavior.
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import { isXmppAccountConfiguredForApprovals } from "./approval-handler.runtime.js";
import { sendEditXmpp, sendFileXmpp, sendMessageXmpp, sendPayloadXmpp } from "./send.js";
import type { CoreConfig } from "./types.js";

function mediaLoaderOptions(params: Record<string, unknown>) {
  return {
    ...(typeof params.maxBytes === "number" ? { maxBytes: params.maxBytes } : {}),
    ...(params.mediaAccess !== undefined ? { mediaAccess: params.mediaAccess } : {}),
    ...(params.mediaLocalRoots !== undefined ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    ...(params.mediaReadFile !== undefined ? { mediaReadFile: params.mediaReadFile } : {}),
  };
}

/** Log de diagnóstico de ruteo outbound: una línea por send del adapter, con
 * la ruta tomada (text/media/edit/payload) y qué contenido estructurado traía.
 * Existe porque "la card llegó como texto plano" es indistinguible de "la card
 * nunca se envió" sin esto — ver la caza del fallback verbose de approvals.
 * OJO: va por console.error (→ openclaw.error.log) a propósito: el log del
 * runtime del plugin se filtra del archivo principal y estas líneas jamás
 * aparecían, lo que ya produjo un diagnóstico falso una vez. */
function logAdapterSend(kind: string, to: string, extra: string): void {
  console.error(`[xmpp][adapter-send] kind=${kind} to=${to} ${extra}`);
}

/** El core entrega el prompt local de una aprobación de exec como payload de
 * herramienta (`channelData.execApproval`). En DM lo absorbe la burbuja de
 * progreso; en una sala MUC llega hasta aquí y se sumaba a la card que ya
 * entrega el handler nativo (approval-handler.runtime.ts): dos cards por
 * aprobación. Si el handler nativo está activo para la cuenta, la card es
 * suya y este prompt se descarta. */
export function isNativelyHandledApprovalPrompt(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  payload?: { channelData?: Record<string, unknown> } | null;
}): boolean {
  const execApproval = params.payload?.channelData?.execApproval as { approvalId?: unknown } | undefined;
  if (!execApproval || typeof execApproval.approvalId !== "string" || !execApproval.approvalId) return false;
  return isXmppAccountConfiguredForApprovals({ cfg: params.cfg, accountId: params.accountId ?? undefined });
}

export const xmppMessageAdapter = defineChannelMessageAdapter({
  id: "xmpp",
  presentationCapabilities: {
    buttons: true,
    selects: true,
    context: true,
    divider: true,
  },
  renderPresentation: async ({ payload, presentation }) => ({
    ...payload,
    channelData: {
      ...(payload.channelData ?? {}),
      xmpp: {
        ...((payload.channelData?.xmpp as Record<string, unknown> | undefined) ?? {}),
        presentation,
      },
    },
  }),
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      payload: true,
      replyTo: true,
      edit: true,
    },
  },
  // Declaración de capacidades "live" (progreso en vivo). La conducta real la
  // implementa el controlador de progreso del inbound (progress.ts): burbuja
  // editada con XEP-0308 que transmite tools + texto parcial (draftPreview) y
  // se convierte en la respuesta final (previewFinalization/finalEdit) con
  // fallback a mensaje normal. Espejo de la declaración de Telegram.
  live: {
    capabilities: {
      draftPreview: true,
      previewFinalization: true,
      progressUpdates: true,
    },
    finalizer: {
      capabilities: {
        finalEdit: true,
        normalFallback: true,
      },
    },
  },
  send: {
    text: async ({ cfg, to, text, accountId, replyToId }) => {
      logAdapterSend("text", to, `len=${text?.length ?? 0}`);
      return await sendMessageXmpp(to, text, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      });
    },
    // Real XEP-0363 upload (fetch + PUT to an upload slot), falling back to
    // a plain link if no upload component is discoverable. See send.ts's
    // sendFileXmpp doc comment for why this differs from IRC's "just paste
    // the URL as text" media handler.
    media: async (params) => {
      const { cfg, to, text, mediaUrl, accountId, replyToId } = params;
      logAdapterSend("media", to, `mediaUrl=${mediaUrl ? "yes" : "no"}`);
      if (!mediaUrl) {
        return await sendMessageXmpp(to, text, {
          cfg: cfg as CoreConfig,
          accountId: accountId ?? undefined,
          replyTo: replyToId ?? undefined,
        });
      }
      return await sendFileXmpp(to, text, mediaUrl, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
        ...mediaLoaderOptions(params as Record<string, unknown>),
      });
    },
    edit: async ({ cfg, to, text, accountId, editTargetId }) =>
      await sendEditXmpp(to, text, editTargetId, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
      }),
    payload: async (params) => {
      const { cfg, to, text, payload, mediaUrl, accountId, replyToId } = params;
      logAdapterSend(
        "payload",
        to,
        `presentation=${payload?.presentation ? "yes" : "no"} channelData=${payload?.channelData ? "yes" : "no"} mediaUrl=${mediaUrl ? "yes" : "no"}`,
      );
      if (!mediaUrl && isNativelyHandledApprovalPrompt({ cfg: cfg as CoreConfig, accountId, payload })) {
        logAdapterSend("payload", to, "skipped=native-approval-card");
        return {
          messageId: "",
          target: to,
          receipt: createMessageReceiptFromOutboundResults({ results: [], kind: "text" }),
        };
      }
      if (mediaUrl) {
        return await sendFileXmpp(to, text, mediaUrl, {
          cfg: cfg as CoreConfig,
          accountId: accountId ?? undefined,
          replyTo: replyToId ?? undefined,
          ...mediaLoaderOptions(params as Record<string, unknown>),
        });
      }
      return await sendPayloadXmpp(to, text, payload, {
        cfg: cfg as CoreConfig,
        accountId: accountId ?? undefined,
        replyTo: replyToId ?? undefined,
      });
    },
  },
});
