// Xmpp plugin module implements inbound behavior.
//
// This follows the SAME core.channel.inbound.dispatchReply pattern IRC's
// src/inbound.ts uses (channel ingress resolver -> pairing -> route/envelope
// -> dispatchReply). Only the identity model differs: XMPP has one stable
// identity per message (the bare JID from a sealed s2s/c2s `from`), so there
// is no nick/user/host tri-state to reconcile the way IRC's ircIngressIdentity
// aliases do.
import fs from "node:fs/promises";
import path from "node:path";
import { buildChannelInboundMediaPayload, logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
import {
  channelIngressRoutes,
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-outbound";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import {
  deliverFormattedTextWithAttachments,
  type OutboundReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedXmppAccount } from "./accounts.js";
import { bareJid, buildXmppAllowlistCandidates, normalizeXmppAllowEntry } from "./normalize.js";
import { resolveXmppGroupMatch, resolveXmppGroupRequireMention } from "./policy.js";
import { getXmppRuntime } from "./runtime.js";
import { createXmppProgressController } from "./progress.js";
import { sendMessageXmpp, sendPayloadXmpp, sendPendingStatusXmpp } from "./send.js";
import { getXmppAccountActivity } from "./activity-registry.js";
import type { CoreConfig, XmppInboundMessage } from "./types.js";

const CHANNEL_ID = "xmpp" as const;
type XmppGroupPolicy = "open" | "allowlist" | "disabled";
type XmppReplyOptions = {
  streamingBehavior: "steer";
  skillFilter?: string[];
  disableBlockStreaming?: boolean;
  suppressDefaultToolProgressMessages?: boolean;
  preserveProgressCallbackStartOrder?: boolean;
  onPartialReply?: (payload: never) => Promise<void> | void;
  onToolStart?: (payload: never) => Promise<void> | void;
  onItemEvent?: (payload: never) => Promise<void> | void;
  onApprovalEvent?: (payload: never) => Promise<void> | void;
  onCommandOutput?: (payload: never) => Promise<void> | void;
  onPatchSummary?: (payload: never) => Promise<void> | void;
};

const xmppIngressIdentity = defineStableChannelIngressIdentity({
  key: "xmpp-jid",
  normalizeEntry: normalizeXmppAllowEntry,
  normalizeSubject: normalizeLowercaseStringOrEmpty,
  sensitivity: "pii",
  aliases: [],
  isWildcardEntry: (entry) => normalizeXmppAllowEntry(entry) === "*",
  resolveEntryId: ({ entryIndex }) => `xmpp-entry-${entryIndex + 1}:jid`,
});

function createXmppIngressSubject(message: XmppInboundMessage) {
  const candidates = buildXmppAllowlistCandidates(message.senderJid);
  return {
    stableId: candidates[0] ?? "",
    aliases: {},
  };
}

function routeDescriptorsForXmppGroup(params: {
  isGroup: boolean;
  groupPolicy: XmppGroupPolicy;
  groupAllowed: boolean;
  hasConfiguredGroups: boolean;
  groupEnabled: boolean;
  routeGroupAllowFrom: string[];
}) {
  if (!params.isGroup) {
    return [];
  }
  return channelIngressRoutes(
    params.groupPolicy === "allowlist" && {
      id: "xmpp:room",
      allowed: params.hasConfiguredGroups && params.groupAllowed,
      precedence: 0,
      matchId: "xmpp-room",
      blockReason: "channel_not_allowlisted",
    },
    !params.groupEnabled && {
      id: "xmpp:room-enabled",
      enabled: false,
      precedence: 10,
      blockReason: "channel_disabled",
    },
    params.routeGroupAllowFrom.length > 0 && {
      id: "xmpp:room-sender",
      precedence: 20,
      senderPolicy: "replace",
      senderAllowFrom: params.routeGroupAllowFrom,
    },
  );
}

async function deliverXmppReply(params: {
  payload: OutboundReplyPayload;
  cfg: CoreConfig;
  target: string;
  accountId: string;
  sendReply?: (target: string, text: string, replyToId?: string) => Promise<void>;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}) {
  const payload = params.payload as OutboundReplyPayload & {
    presentation?: unknown;
    text?: string | null;
    mediaUrl?: string | null;
    channelData?: Record<string, unknown>;
  };
  if (payload.presentation) {
    await sendPayloadXmpp(
      params.target,
      payload.text ?? "",
      {
        presentation: payload.presentation as MessagePresentation,
        text: payload.text ?? null,
        mediaUrl: payload.mediaUrl ?? null,
        channelData: payload.channelData,
      },
      {
        cfg: params.cfg,
        accountId: params.accountId,
      },
    );
    params.statusSink?.({ lastOutboundAt: Date.now() });
    return;
  }

  await deliverFormattedTextWithAttachments({
    payload: params.payload,
    send: async ({ text, replyToId }) => {
      if (params.sendReply) {
        await params.sendReply(params.target, text, replyToId);
      } else {
        await sendMessageXmpp(params.target, text, {
          cfg: params.cfg,
          accountId: params.accountId,
          replyTo: replyToId,
        });
      }
      params.statusSink?.({ lastOutboundAt: Date.now() });
    },
  });
}

/**
 * Baja un adjunto entrante a disco y devuelve sus datos para el agente.
 *
 * Por qué descargarlo aquí en vez de pasarle sólo la URL: si el agente sólo
 * recibe un link, para verlo tiene que ejecutar un `curl`, y CUALQUIER exec
 * dispara una tarjeta de aprobación (exec-approvals `ask: "always"`). Pedirle
 * permiso al usuario para bajar el archivo que él mismo acaba de mandar no
 * tiene sentido. Entregándolo ya descargado (MediaPath), el agente no ejecuta
 * nada y no hay aprobación que pedir.
 *
 * Si la descarga falla se devuelve null y el flujo sigue con la URL suelta
 * (comportamiento anterior), nunca se pierde el mensaje.
 */
async function downloadInboundAttachment(params: {
  url: string;
  stateDir: string;
  runtime: RuntimeEnv;
}): Promise<{ path: string; contentType?: string } | null> {
  const { url, stateDir, runtime } = params;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      runtime.error?.(`[xmpp] no se pudo bajar el adjunto (HTTP ${response.status}): ${url}`);
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const dir = path.join(stateDir, "media", "inbound");
    await fs.mkdir(dir, { recursive: true });
    // Nombre del archivo del propio link (XEP-0363 lo conserva), saneado y
    // con un prefijo único para no pisar dos adjuntos con el mismo nombre.
    const rawName = decodeURIComponent(new URL(url).pathname.split("/").pop() || "file");
    const safeName = rawName.replace(/[^\w.\-]+/g, "_").slice(-80) || "file";
    const target = path.join(dir, `${Date.now().toString(36)}-${safeName}`);
    await fs.writeFile(target, buffer);
    const contentType = response.headers.get("content-type") ?? undefined;
    return { path: target, ...(contentType ? { contentType } : {}) };
  } catch (error) {
    runtime.error?.(`[xmpp] fallo al bajar el adjunto ${url}: ${String(error)}`);
    return null;
  }
}

export async function handleXmppInbound(params: {
  message: XmppInboundMessage;
  account: ResolvedXmppAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  sendReply?: (target: string, text: string, replyToId?: string) => Promise<void>;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getXmppRuntime();
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text?.trim() ?? "";
  // An inbound attachment (XEP-0363 upload link carried as an XEP-0066 OOB
  // <x><url/></x>) may arrive with an empty body. Don't drop it: monitor.ts
  // already surfaces the link as message.oobUrl, and it's fed to the agent as
  // MediaUrl below. Only a message with neither text nor attachment is a no-op.
  const inboundMediaUrl = message.oobUrl?.trim() || "";
  if (!rawBody && !inboundMediaUrl) {
    return;
  }

  statusSink?.({ lastInboundAt: message.timestamp });

  const senderDisplay = message.senderNick
    ? `${message.senderNick} <${message.senderJid}>`
    : message.senderJid;
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: config.channels?.xmpp !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "xmpp",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.channel,
    log: (messageLocal) => runtime.log?.(messageLocal),
  });

  const groupMatch = resolveXmppGroupMatch({
    groups: account.config.groups,
    target: message.target,
  });

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const requireMention = message.isGroup
    ? resolveXmppGroupRequireMention({ groups: account.config.groups, target: message.target })
    : false;
  const wasMentioned =
    core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes) || message.wasMentioned;
  const routeGroupAllowFrom = normalizeStringEntries(
    groupMatch.groupConfig?.allowFrom?.length
      ? groupMatch.groupConfig.allowFrom
      : groupMatch.wildcardConfig?.allowFrom,
  );
  const accessGroupPolicy: XmppGroupPolicy =
    groupPolicy === "open" &&
    (routeGroupAllowFrom.length > 0 || (account.config.groupAllowFrom?.length ?? 0) > 0)
      ? "allowlist"
      : groupPolicy;
  const access = await createChannelIngressResolver({
    channelId: CHANNEL_ID,
    accountId: account.accountId,
    identity: xmppIngressIdentity,
    cfg: config as OpenClawConfig,
    readStoreAllowFrom: async () => await pairing.readAllowFromStore(),
  }).message({
    subject: createXmppIngressSubject(message),
    conversation: {
      kind: message.isGroup ? "group" : "direct",
      id: message.target,
    },
    route: routeDescriptorsForXmppGroup({
      isGroup: message.isGroup,
      groupPolicy,
      groupAllowed: groupMatch.allowed,
      hasConfiguredGroups: groupMatch.hasConfiguredGroups,
      groupEnabled:
        groupMatch.groupConfig?.enabled !== false && groupMatch.wildcardConfig?.enabled !== false,
      routeGroupAllowFrom,
    }),
    mentionFacts: message.isGroup
      ? {
          canDetectMention: true,
          wasMentioned,
          hasAnyMention: wasMentioned,
        }
      : undefined,
    dmPolicy,
    groupPolicy: accessGroupPolicy,
    policy: {
      groupAllowFromFallbackToAllowFrom: false,
      mutableIdentifierMatching: allowNameMatching ? "enabled" : "disabled",
      activation: {
        requireMention: message.isGroup && requireMention,
        allowTextCommands,
      },
    },
    allowFrom: account.config.allowFrom,
    groupAllowFrom: account.config.groupAllowFrom,
    command: {
      allowTextCommands,
      hasControlCommand,
    },
  });
  const commandAuthorized = access.commandAccess.authorized;

  if (access.ingress.admission === "pairing-required") {
    await pairing.issueChallenge({
      senderId: normalizeLowercaseStringOrEmpty(bareJid(message.senderJid)),
      senderIdLine: `Your XMPP JID: ${senderDisplay}`,
      meta: { name: message.senderNick || undefined },
      sendPairingReply: async (text) => {
        await deliverXmppReply({
          payload: { text },
          cfg: config,
          target: bareJid(message.senderJid),
          accountId: account.accountId,
          sendReply: params.sendReply,
          statusSink,
        });
      },
      onReplyError: (err) => {
        runtime.error?.(`xmpp: pairing reply failed for ${senderDisplay}: ${String(err)}`);
      },
    });
    runtime.log?.(`xmpp: drop DM sender ${senderDisplay} (dmPolicy=${dmPolicy})`);
    return;
  }
  if (access.ingress.admission === "skip") {
    runtime.log?.(`xmpp: drop room ${message.target} (missing-mention)`);
    return;
  }
  if (access.ingress.admission !== "dispatch") {
    if (
      message.isGroup &&
      access.ingress.decisiveGateId === "command" &&
      access.commandAccess.shouldBlockControlCommand
    ) {
      logInboundDrop({
        log: (line) => runtime.log?.(line),
        channel: CHANNEL_ID,
        reason: "control command (unauthorized)",
        target: senderDisplay,
      });
      return;
    }
    if (message.isGroup) {
      if (access.routeAccess.reason === "channel_not_allowlisted") {
        runtime.log?.(`xmpp: drop room ${message.target} (not allowlisted)`);
      } else if (access.routeAccess.reason === "channel_disabled") {
        runtime.log?.(`xmpp: drop room ${message.target} (disabled)`);
      } else {
        runtime.log?.(`xmpp: drop group sender ${senderDisplay} (policy=${groupPolicy})`);
      }
    } else {
      runtime.log?.(`xmpp: drop DM sender ${senderDisplay} (dmPolicy=${dmPolicy})`);
    }
    return;
  }

  const peerId = message.target;
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: message.isGroup ? "group" : "direct",
      id: peerId,
    },
    runtime: core.channel,
    sessionStore: config.session?.store,
  });

  console.error();
  const fromLabel = message.isGroup ? message.target : senderDisplay;
  // An attachment-only message has no text; give the envelope a readable stand-in
  // so the agent sees "there is a file" rather than an empty turn. The real link
  // travels as MediaUrl in the context below.
  const envelopeBody = rawBody || (inboundMediaUrl ? `[attachment] ${inboundMediaUrl}` : rawBody);
  const { storePath, body } = buildEnvelope({
    channel: "XMPP",
    from: fromLabel,
    timestamp: message.timestamp,
    body: envelopeBody,
  });

  const groupSystemPrompt = normalizeOptionalString(groupMatch.groupConfig?.systemPrompt);
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(account.config);

  // Adjunto entrante: bajarlo y entregárselo al agente como archivo LOCAL
  // (MediaPath), no como un link que tendría que ir a buscar con un exec
  // (cada exec dispara una tarjeta de aprobación). Si la descarga falla se
  // cae al link suelto, que es mejor que nada.
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const downloaded = inboundMediaUrl && stateDir
    ? await downloadInboundAttachment({ url: inboundMediaUrl, stateDir, runtime })
    : null;
  const mediaPayload = inboundMediaUrl
    ? buildChannelInboundMediaPayload([
        {
          url: inboundMediaUrl,
          ...(downloaded?.path ? { path: downloaded.path } : {}),
          ...(downloaded?.contentType ? { contentType: downloaded.contentType } : {}),
        },
      ])
    : undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    ...(mediaPayload ?? {}),
    From: message.isGroup ? `channel:${message.target}` : `xmpp:${senderDisplay}`,
    To: message.isGroup ? `channel:${message.target}` : `xmpp:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: message.isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: message.senderNick || undefined,
    SenderId: senderDisplay,
    GroupSubject: message.isGroup ? message.target : undefined,
    GroupSystemPrompt: message.isGroup ? groupSystemPrompt : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: message.isGroup ? wasMentioned : undefined,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: message.isGroup ? `channel:${message.target}` : `xmpp:${peerId}`,
    CommandAuthorized: commandAuthorized,
  });

  // El mensaje ya pasó todas las validaciones y va a entrar al agente: si no
  // hay un turno en curso (busy real), anunciamos "away" con el contador antes
  // de que dispatchReply arranque el turno de verdad. sendTypingXmpp (vía el
  // heartbeat del core) lo sube a dnd apenas el turno empieza; esto sólo cubre
  // el hueco entre "llegó" y "arrancó", que hasta ahora era invisible para
  // cualquier cliente XMPP -- Android lo aproximaba contando mensajes propios
  // sin respuesta, pero eso no es una presencia real ni lo ven otros clientes.
  const pendingCount = getXmppAccountActivity(account.accountId)?.pendingCount ?? 0;
  await sendPendingStatusXmpp(peerId, pendingCount + 1, {
    cfg: config,
    accountId: account.accountId,
  }).catch(() => {});

  // Progreso en vivo tipo Telegram: una burbuja editada con XEP-0308 mientras
  // corren herramientas/comandos. Sólo se engancha si la cuenta tiene
  // streaming.mode="progress"; si no, el objeto queda inerte y no agrega nada.
  const progress = createXmppProgressController({
    cfg: config,
    account,
    target: peerId,
    log: (line) => runtime.log?.(line),
  });

  await core.channel.inbound.dispatchReply({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    agentId: route.agentId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: core.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher: core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    delivery: {
      deliver: async (payload) => {
        const p = payload as OutboundReplyPayload & {
          presentation?: unknown;
          mediaUrl?: string | null;
          channelData?: Record<string, unknown>;
          text?: string | null;
        };
        // Finalización de preview estilo Telegram: una respuesta de texto puro
        // convierte la burbuja de progreso en la respuesta final (una última
        // corrección XEP-0308) en vez de llegar como mensaje aparte.
        if (p.text && !p.presentation && !p.mediaUrl && !p.channelData) {
          const handled = await progress.finalizeWithFinalText(p.text);
          if (handled) {
            statusSink?.({ lastOutboundAt: Date.now() });
            return;
          }
        } else {
          // Payload no finalizable (media/card): drenar la edición pendiente
          // para que la burbuja esté al día antes de la respuesta.
          await progress.closeWindow();
        }
        await deliverXmppReply({
          payload,
          cfg: config,
          target: peerId,
          accountId: account.accountId,
          sendReply: params.sendReply,
          statusSink,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`xmpp ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyPipeline: {},
    replyOptions: {
      // XMPP is conversational: when a human talks while the agent is already
      // working, treat the new message as steering for the active turn instead
      // of silently stacking a follow-up behind it.
      streamingBehavior: "steer",
      skillFilter: groupMatch.groupConfig?.skills,
      disableBlockStreaming:
        typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : undefined,
      ...(progress.active
        ? {
            suppressDefaultToolProgressMessages: progress.suppressDefaultToolProgressMessages,
            preserveProgressCallbackStartOrder: true,
            onPartialReply: progress.handlePartialReply,
            onToolStart: progress.handleToolStart,
            onItemEvent: progress.handleItemEvent,
            onApprovalEvent: progress.handleApprovalEvent,
            onCommandOutput: progress.handleCommandOutput,
            onPatchSummary: progress.handlePatchSummary,
          }
        : {}),
    } as XmppReplyOptions,
    record: {
      onRecordError: (err) => {
        runtime.error?.(`xmpp: failed updating session meta: ${String(err)}`);
      },
    },
  });
}
