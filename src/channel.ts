// Xmpp plugin module implements channel behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { XMPP_SET_AVATAR_METHOD } from "./avatar-gateway.js";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import {
  buildApprovalResolvedReplyPayload,
  buildExecApprovalPendingReplyPayload,
  buildPluginApprovalPendingReplyPayload,
  resolveExecApprovalCommandDisplay,
  resolveExecApprovalRequestAllowedDecisions,
} from "openclaw/plugin-sdk/approval-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  composeAccountWarningCollectors,
  createAllowlistProviderOpenWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import {
  createChannelDirectoryAdapter,
  createResolvedDirectoryEntriesLister,
} from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  listXmppAccountIds,
  resolveDefaultXmppAccountId,
  resolveXmppAccount,
  type ResolvedXmppAccount,
} from "./accounts.js";
import {
  buildBaseChannelStatusSummary,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  type ChannelPlugin,
} from "./channel-api.js";
import { XmppChannelConfigSchema } from "./config-schema.js";
import { startXmppGatewayAccount } from "./gateway.js";
import { xmppMessageAdapter } from "./message-adapter.js";
import { bareJid, looksLikeXmppTargetId, normalizeXmppAllowEntry, normalizeXmppMessagingTarget, resolveXmppOutboundSessionRoute } from "./normalize.js";
import { xmppOutboundBaseAdapter } from "./outbound-base.js";
import { resolveInlineButtonsScope } from "./outbound-render.js";
import { resolveXmppGroupRequireMention, resolveXmppGroupToolPolicy } from "./policy.js";
import { probeXmpp } from "./probe.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { xmppSetupAdapter } from "./setup-core.js";
import { xmppSetupWizard } from "./setup-surface.js";
import type { CoreConfig, XmppProbe } from "./types.js";

const meta = {
  id: "xmpp",
  label: "XMPP",
  selectionLabel: "XMPP (Jabber JID + password)",
  docsPath: "/channels/xmpp",
  docsLabel: "xmpp",
  blurb: "XMPP/Jabber accounts with 1:1 chat, MUC rooms, and ad-hoc commands.",
  order: 85,
  detailLabel: "XMPP",
  systemImage: "message",
  markdownCapable: false,
};

const loadXmppChannelRuntime = createLazyRuntimeModule(() => import("./channel-runtime.js"));

function normalizePairingTarget(raw: string): string {
  const normalized = normalizeXmppAllowEntry(raw);
  return normalized ? bareJid(normalized) : "";
}

const listXmppDirectoryPeersFromConfig = createResolvedDirectoryEntriesLister<ResolvedXmppAccount>({
  kind: "user",
  resolveAccount: adaptScopedAccountAccessor(resolveXmppAccount),
  resolveSources: (account) => [
    account.config.allowFrom ?? [],
    account.config.groupAllowFrom ?? [],
    ...Object.values(account.config.groups ?? {}).map((group) => group.allowFrom ?? []),
  ],
  normalizeId: (entry) => normalizePairingTarget(entry) || null,
});

const listXmppDirectoryGroupsFromConfig = createResolvedDirectoryEntriesLister<ResolvedXmppAccount>({
  kind: "group",
  resolveAccount: adaptScopedAccountAccessor(resolveXmppAccount),
  resolveSources: (account) => [account.config.mucRooms ?? [], Object.keys(account.config.groups ?? {})],
  normalizeId: (entry) => {
    const normalized = normalizeXmppMessagingTarget(entry);
    return normalized ? bareJid(normalized) : null;
  },
});

const xmppConfigAdapter = createScopedChannelConfigAdapter<ResolvedXmppAccount, ResolvedXmppAccount>({
  sectionKey: "xmpp",
  listAccountIds: listXmppAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveXmppAccount),
  defaultAccountId: resolveDefaultXmppAccountId,
  clearBaseFields: ["name", "jid", "password", "passwordFile", "service", "resource", "mucDomain", "mucRooms"],
  resolveAllowFrom: (account: ResolvedXmppAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: normalizeXmppAllowEntry,
    }),
  resolveDefaultTo: (account: ResolvedXmppAccount) => account.config.defaultTo,
});

const resolveXmppDmPolicy = createScopedDmSecurityResolver<ResolvedXmppAccount>({
  channelKey: "xmpp",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => normalizeXmppAllowEntry(raw),
});

const collectXmppGroupPolicyWarnings =
  createAllowlistProviderOpenWarningCollector<ResolvedXmppAccount>({
    providerConfigPresent: (cfg) => cfg.channels?.xmpp !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    buildOpenWarning: {
      surface: "XMPP rooms",
      openBehavior: "allows all rooms and senders (mention-gated)",
      remediation: 'Prefer channels.xmpp.groupPolicy="allowlist" with channels.xmpp.groups',
    },
  });

const collectXmppSecurityWarnings = composeAccountWarningCollectors<
  ResolvedXmppAccount,
  {
    account: ResolvedXmppAccount;
    cfg: CoreConfig;
  }
>(
  collectXmppGroupPolicyWarnings,
  (account) =>
    !account.config.mucDomain &&
    (account.config.mucRooms?.length ?? 0) > 0 &&
    "- channels.xmpp.mucRooms is set but channels.xmpp.mucDomain is empty; rooms will not be recognized as groups (outbound replies will use type=chat instead of type=groupchat).",
);

function isXmppApprovalAuthorizedSender(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  senderId?: string | null;
}): boolean {
  const sender = normalizeXmppAllowEntry(params.senderId ?? "");
  if (!sender) return false;
  const account = resolveXmppAccount({ cfg: params.cfg, accountId: params.accountId ?? undefined });
  return (account.config.allowFrom ?? []).some((entry) => {
    const normalized = normalizeXmppAllowEntry(String(entry));
    return normalized === "*" || normalized === sender;
  });
}

function isXmppInlineButtonsEnabled(params: { cfg: CoreConfig; accountId?: string | null }): boolean {
  const account = resolveXmppAccount({ cfg: params.cfg, accountId: params.accountId ?? undefined });
  return resolveInlineButtonsScope(account.config.capabilities) !== "off";
}

const APPROVAL_CARD_TITLE_MAX = 80;
const APPROVAL_CARD_COMMAND_MAX = 220;

/** Título de una sola línea para la card de aprobación: el comando en sí, no
 * un genérico "OpenClaw" ni el bloque de texto verbose del fallback. */
function buildApprovalCardTitle(commandText: string): string {
  const oneLine = commandText.replace(/\s+/g, " ").trim();
  if (!oneLine) return "Approval required";
  if (oneLine.length <= APPROVAL_CARD_TITLE_MAX) return oneLine;
  return `${oneLine.slice(0, APPROVAL_CARD_TITLE_MAX - 1)}…`;
}

function truncateOneLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function formatApprovalExpiry(expiresAtMs: number | undefined, nowMs: number): string | null {
  if (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs)) return null;
  const totalSeconds = Math.max(0, Math.round((expiresAtMs - nowMs) / 1000));
  if (totalSeconds < 90) return `${totalSeconds}s`;
  return `${Math.round(totalSeconds / 60)}m`;
}

/**
 * Cuerpo COMPACTO de la solicitud de aprobación. Reemplaza el texto verbose
 * del core (Run:/Other options:/Full id:/policy...) que en un cliente XMPP de
 * texto ocupaba una pantalla entera. Reglas:
 * - el comando va primero y truncado a una línea razonable;
 * - una sola línea de instrucción de respuesta con el slug corto (el core
 *   acepta el slug de 8 chars en /approve);
 * - los botones (cuando el cliente los soporta) salen de presentation, no de
 *   este texto, así que esto es sólo el fallback legible.
 */
function buildCompactExecApprovalText(params: {
  command: string;
  cwd?: string | null;
  warningText?: string | null;
  approvalSlug: string;
  allowedDecisions: readonly string[];
  expiresAtMs?: number;
  nowMs: number;
}): string {
  const lines: string[] = [];
  const warning = params.warningText?.trim();
  if (warning) {
    lines.push(`⚠️ ${truncateOneLine(warning, 200)}`);
  }
  lines.push(`🔒 ${truncateOneLine(params.command, APPROVAL_CARD_COMMAND_MAX)}`);
  const info: string[] = [];
  if (params.cwd?.trim()) {
    info.push(`cwd ${truncateOneLine(params.cwd, 60)}`);
  }
  const expiry = formatApprovalExpiry(params.expiresAtMs, params.nowMs);
  if (expiry) {
    info.push(`caduca en ${expiry}`);
  }
  if (info.length > 0) {
    lines.push(info.join(" · "));
  }
  const decisions = params.allowedDecisions.length > 0
    ? params.allowedDecisions.join(" | ")
    : "allow-once | deny";
  lines.push(`Responde: /approve ${params.approvalSlug} ${decisions}`);
  return lines.join("\n");
}

function readFirstString(params: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function readObjectParam(params: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = params[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mediaLoaderOptions(params: Record<string, unknown>) {
  return {
    ...(typeof params.maxBytes === "number" ? { maxBytes: params.maxBytes } : {}),
    ...(params.mediaAccess !== undefined ? { mediaAccess: params.mediaAccess } : {}),
    ...(params.mediaLocalRoots !== undefined ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    ...(params.mediaReadFile !== undefined ? { mediaReadFile: params.mediaReadFile } : {}),
  };
}

export const xmppPlugin: ChannelPlugin<ResolvedXmppAccount, XmppProbe> = createChatChannelPlugin({
  base: {
    id: "xmpp",
    meta: {
      ...meta,
      quickstartAllowFrom: true,
    },
    setup: xmppSetupAdapter,
    setupWizard: xmppSetupWizard,
    capabilities: {
      chatTypes: ["direct", "group"],
      media: true,
      blockStreaming: true,
      nativeCommands: true,
    },
    // Declarados para que el gateway los enrute; los implementa
    // registerXmppAvatarGatewayMethods() desde el registerFull del entry.
    gatewayMethods: [XMPP_SET_AVATAR_METHOD],
    gatewayMethodDescriptors: [
      {
        name: XMPP_SET_AVATAR_METHOD,
        description:
          "Publica el avatar de una cuenta XMPP (XEP-0084 + XEP-0153). params: { source: ruta local o URL de una imagen PNG/JPEG/GIF/WebP, accountId?: clawdio|bob|odiseo|... }. Si source esta bajo /agents/<id> o /workspaces/<id>, accountId se infiere.",
      },
    ],
    reload: { configPrefixes: ["channels.xmpp"] },
    configSchema: XmppChannelConfigSchema,
    agentPrompt: {
      messageToolCapabilities: ({ cfg, accountId }) =>
        isXmppInlineButtonsEnabled({
          cfg: cfg as CoreConfig,
          accountId,
        })
          ? ["inlineButtons"]
          : [],
    },
    config: {
      ...xmppConfigAdapter,
      hasConfiguredState: ({ env }) =>
        typeof env?.XMPP_JID === "string" &&
        env.XMPP_JID.trim().length > 0 &&
        typeof env?.XMPP_PASSWORD === "string" &&
        env.XMPP_PASSWORD.trim().length > 0,
      isConfigured: (account) => account.configured,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            jid: account.jid,
            service: account.service,
            mucDomain: account.mucDomain,
            passwordSource: account.passwordSource,
          },
        }),
    },
    approvalCapability: {
      authorizeActorAction: ({ cfg, accountId, senderId }) => ({
        authorized: isXmppApprovalAuthorizedSender({
          cfg: cfg as CoreConfig,
          accountId,
          senderId,
        }),
      }),
      // Sin esto, isKnownNativeApprovalPromptChannel()/hasNativeApprovalPromptRuntimeCapability()
      // dan false para xmpp (no está en el set fijo del core) y el agente recibe el prompt
      // fallback genérico en vez de "STOP the turn immediately" — sigue reintentando el mismo
      // exec mientras la aprobación está pendiente, chocando en bucle contra el guard
      // single-pending-approval-per-session del servidor. Las cards con botones ya se entregan
      // bien vía el forwarder; esto solo declara la capability para el prompt del modelo.
      native: {
        describeDeliveryCapabilities: ({ cfg, accountId }) => {
          const enabled = isXmppInlineButtonsEnabled({
            cfg: cfg as CoreConfig,
            accountId,
          });
          return {
            enabled,
            preferredSurface: "origin",
            supportsOriginSurface: enabled,
            supportsApproverDmSurface: false,
          };
        },
      },
      // Fase 1 de xmpp-native-approval-runtime: el adapter queda cableado y
      // verificable de forma aislada. El turno del agente NO espera in-línea
      // todavía -- eso depende de que xmpp entre a NATIVE_APPROVAL_CHANNELS
      // en el core (fase 2, requiere confirmación explícita porque afecta las
      // 8 cuentas a la vez). Hasta entonces este runtime queda inerte salvo
      // que algo del core lo invoque explícitamente para otros fines.
      nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
        eventKinds: ["exec", "plugin"],
        isConfigured: ({ cfg, accountId }) =>
          isXmppInlineButtonsEnabled({ cfg: cfg as CoreConfig, accountId }),
        shouldHandle: ({ cfg, accountId, request }) => {
          const account = resolveXmppAccount({ cfg: cfg as CoreConfig, accountId: accountId ?? undefined });
          if (!account.configured || (account.config.allowFrom ?? []).length === 0) return false;
          if (!isXmppInlineButtonsEnabled({ cfg: cfg as CoreConfig, accountId })) return false;
          const turnSourceChannel = String(request.request.turnSourceChannel ?? "").trim().toLowerCase();
          if (turnSourceChannel !== "xmpp") return false;
          const turnSourceAccountId = String(request.request.turnSourceAccountId ?? "").trim();
          return !turnSourceAccountId || turnSourceAccountId === account.accountId;
        },
        load: async () =>
          (await import("./approval-handler.runtime.js"))
            .xmppApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
      }),
      render: {
        exec: {
          buildPendingPayload: ({ request, nowMs }) => {
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
              nowMs,
            });
            const result = {
              ...payload,
              // El texto verbose del core (Run:/Other options:/Full id:/...)
              // ocupaba una pantalla entera en clientes de texto. Este cuerpo
              // compacto dice lo mismo en <=5 líneas; los botones siguen
              // saliendo de presentation, y channelData.execApproval queda
              // intacto para el parsing de respuestas.
              text: buildCompactExecApprovalText({
                command: commandText,
                cwd: request.request.cwd ?? undefined,
                warningText: request.request.warningText ?? undefined,
                approvalSlug: request.id.slice(0, 8),
                allowedDecisions,
                expiresAtMs: request.expiresAtMs,
                nowMs,
              }),
              // buildExecApprovalPendingReplyPayload no pone presentation.title,
              // así que send.ts caía al fallback fijo "OpenClaw" como primera
              // línea de la card -- el comando quedaba enterrado en el fallback
              // de texto verbose. Un título con el comando (una sola línea) es
              // lo único que un cliente de sólo-texto llega a ver de un vistazo.
              ...(payload.presentation
                ? {
                    presentation: {
                      ...payload.presentation,
                      title: buildApprovalCardTitle(commandText),
                    },
                  }
                : {}),
              channelData: {
                ...(payload.channelData ?? {}),
                xmpp: {
                  ...((payload.channelData?.xmpp as Record<string, unknown> | undefined) ?? {}),
                  approval: {
                    expiresAtMs: request.expiresAtMs,
                  },
                },
              },
            };
            return result;
          },
          // Aviso de resolución COMPACTO (una línea). El fallback del core es
          // "✅ Exec approval allow-once. Resolved by ... ID: <uuid-entero>".
          buildResolvedPayload: ({ resolved }: {
            resolved: {
              id: string;
              decision: string;
              resolvedBy?: string | null;
              request?: { command?: string };
            };
          }) => {
            const decision = resolved.decision;
            const icon = decision === "deny" ? "🚫" : "✅";
            const label = decision === "deny"
              ? "denegado"
              : decision === "allow-always"
                ? "aprobado (siempre)"
                : "aprobado";
            const command = resolved.request?.command
              ? ` — ${truncateOneLine(resolved.request.command, 120)}`
              : "";
            return buildApprovalResolvedReplyPayload({
              approvalId: resolved.id,
              approvalSlug: resolved.id.slice(0, 8),
              text: `${icon} ${label}${command}`,
            });
          },
        },
        plugin: {
          buildPendingPayload: ({ request, nowMs }) =>
            buildPluginApprovalPendingReplyPayload({
              request,
              nowMs,
            }),
        },
      },
    },
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
    doctor: {
      groupAllowFromFallbackToAllowFrom: false,
      collectMutableAllowlistWarnings: () => [],
    },
    groups: {
      resolveRequireMention: ({ cfg, accountId, groupId }) => {
        const account = resolveXmppAccount({ cfg: cfg as CoreConfig, accountId });
        if (!groupId) {
          return true;
        }
        return resolveXmppGroupRequireMention({ groups: account.config.groups, target: groupId });
      },
      resolveToolPolicy: ({ cfg, accountId, groupId }) => {
        const account = resolveXmppAccount({ cfg: cfg as CoreConfig, accountId });
        if (!groupId) {
          return undefined;
        }
        return resolveXmppGroupToolPolicy({ groups: account.config.groups, target: groupId });
      },
    },
    messaging: {
      targetPrefixes: ["xmpp"],
      normalizeTarget: normalizeXmppMessagingTarget,
      resolveOutboundSessionRoute: (params) =>
        resolveXmppOutboundSessionRoute({
          ...params,
          mucDomain: resolveXmppAccount({ cfg: params.cfg as CoreConfig, accountId: params.accountId }).mucDomain,
        }),
      targetResolver: {
        looksLikeId: looksLikeXmppTargetId,
        hint: "<user@domain|room@conference.domain>",
      },
    },
    actions: {
      describeMessageTool: () => ({
        actions: ["send", "read"],
        capabilities: ["presentation"],
      }),
      supportsAction: ({ action }) => action === "send" || action === "read",
      resolveExecutionMode: ({ action }) => (action === "send" ? "gateway" : "local"),
      isToolDeliveryAction: ({ args }) =>
        Boolean(readFirstString(args, ["target", "to", "channelId", "chatId"])),
      handleAction: async ({ action, params, cfg, accountId, mediaAccess, mediaLocalRoots, mediaReadFile }) => {
        if (action === "read") {
          return {
            content: [
              {
                type: "text",
                text:
                  "XMPP message read is not available from the gateway. Use the current conversation context and ask the user for any missing message text.",
              },
            ],
            details: {},
          };
        }
        if (action !== "send") {
          throw new Error(`XMPP action ${action} not supported`);
        }
        const target = readFirstString(params, ["target", "to", "channelId", "chatId"]);
        if (!target) {
          throw new Error("XMPP send requires target or to.");
        }
        const message = readFirstString(params, ["message", "text", "content", "caption"]);
        const mediaUrl = readFirstString(params, ["media", "mediaUrl", "path", "filePath", "fileUrl"]);
        const presentation = readObjectParam(params, "presentation");
        const interactive = readObjectParam(params, "interactive");
        const channelData = readObjectParam(params, "channelData");
        const runtime = await loadXmppChannelRuntime();
        const result =
          presentation || interactive || channelData
            ? await runtime.sendPayloadXmpp(
                target,
                message,
                {
                  text: message,
                  ...(presentation ? { presentation: presentation as never } : {}),
                  ...(interactive ? { interactive: interactive as never } : {}),
                  ...(channelData ? { channelData } : {}),
                },
                {
                  cfg: cfg as CoreConfig,
                  accountId: accountId ?? undefined,
                },
              )
            : mediaUrl
              ? await runtime.sendFileXmpp(target, message, mediaUrl, {
                  cfg: cfg as CoreConfig,
                  accountId: accountId ?? undefined,
                  ...(mediaAccess !== undefined ? { mediaAccess } : {}),
                  ...(mediaLocalRoots !== undefined ? { mediaLocalRoots } : {}),
                  ...(mediaReadFile !== undefined ? { mediaReadFile } : {}),
                })
              : await runtime.sendMessageXmpp(target, message, {
                  cfg: cfg as CoreConfig,
                  accountId: accountId ?? undefined,
                });
        return {
          content: [
            {
              type: "text",
              text: `Sent XMPP message ${result.messageId}`,
            },
          ],
          details: result,
        };
      },
    },
    message: xmppMessageAdapter,
    resolver: {
      resolveTargets: async ({ inputs, kind }) => {
        return inputs.map((input) => {
          const normalized = normalizeXmppMessagingTarget(input);
          if (!normalized) {
            return {
              input,
              resolved: false,
              note: "invalid XMPP target",
            };
          }
          const bare = bareJid(normalized);
          if (kind === "group") {
            return {
              input,
              resolved: true,
              id: bare,
              name: bare,
            };
          }
          return {
            input,
            resolved: true,
            id: bare,
            name: bare,
          };
        });
      },
    },
    directory: createChannelDirectoryAdapter({
      listPeers: async (params) => listXmppDirectoryPeersFromConfig(params),
      listGroups: async (params) => {
        const entries = await listXmppDirectoryGroupsFromConfig(params);
        return entries.map((entry) => Object.assign({}, entry, { name: entry.id }));
      },
    }),
    status: createComputedAccountStatusAdapter<ResolvedXmppAccount, XmppProbe>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      buildChannelSummary: ({ account, snapshot }) => ({
        ...buildBaseChannelStatusSummary(snapshot),
        jid: account.jid,
        service: account.service,
        mucDomain: account.mucDomain,
        probe: snapshot.probe,
        lastProbeAt: snapshot.lastProbeAt ?? null,
      }),
      probeAccount: async ({ cfg, account, timeoutMs }) =>
        probeXmpp(cfg as CoreConfig, { accountId: account.accountId, timeoutMs }),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        extra: {
          jid: account.jid,
          service: account.service,
          mucDomain: account.mucDomain,
          passwordSource: account.passwordSource,
        },
      }),
    }),
    gateway: {
      startAccount: async (ctx) =>
        await startXmppGatewayAccount({
          ...ctx,
          cfg: ctx.cfg as CoreConfig,
        }),
    },
    // XEP-0085 chat state notifications. Same plugin-SDK heartbeat hook
    // Matrix wires to its own sendTypingMatrix (see extensions/matrix/src/
    // channel.ts's `heartbeat` block) -- ported from xmpp.ts's setTyping(),
    // which sent <composing/> while the agent was working and relied on
    // deliver() to send <active/> once the reply landed (sendMessageXmpp
    // already does that <active/> clear; clearTyping below is for the case
    // where a turn ends with no outbound message, e.g. a silent/errored turn).
    heartbeat: {
      sendTyping: async ({ cfg, to, accountId }) => {
        const { sendTypingXmpp } = await loadXmppChannelRuntime();
        await sendTypingXmpp(to, { cfg: cfg as CoreConfig, accountId: accountId ?? undefined });
      },
      clearTyping: async ({ cfg, to, accountId }) => {
        const { clearTypingXmpp } = await loadXmppChannelRuntime();
        await clearTypingXmpp(to, { cfg: cfg as CoreConfig, accountId: accountId ?? undefined });
      },
    },
  },
  pairing: {
    text: {
      idLabel: "xmppUser",
      message: PAIRING_APPROVED_MESSAGE,
      normalizeAllowEntry: (entry) => normalizeXmppAllowEntry(entry),
      notify: async ({ cfg, id, message }) => {
        const target = normalizePairingTarget(id);
        if (!target) {
          throw new Error(`invalid XMPP pairing id: ${id}`);
        }
        const { sendMessageXmpp } = await loadXmppChannelRuntime();
        await sendMessageXmpp(target, message, {
          cfg: cfg as CoreConfig,
        });
      },
    },
  },
  security: {
    resolveDmPolicy: resolveXmppDmPolicy,
    collectWarnings: collectXmppSecurityWarnings,
  },
  outbound: {
    base: xmppOutboundBaseAdapter,
    attachedResults: {
      channel: "xmpp",
      sendText: async ({ cfg, to, text, accountId, replyToId }) => {
        const { sendMessageXmpp } = await loadXmppChannelRuntime();
        return await sendMessageXmpp(to, text, {
          cfg: cfg as CoreConfig,
          accountId: accountId ?? undefined,
          replyTo: replyToId ?? undefined,
        });
      },
      sendMedia: async (params) => {
        const { cfg, to, text, mediaUrl, accountId, replyToId } = params;
        if (!mediaUrl) {
          const { sendMessageXmpp } = await loadXmppChannelRuntime();
          return await sendMessageXmpp(to, text, {
            cfg: cfg as CoreConfig,
            accountId: accountId ?? undefined,
            replyTo: replyToId ?? undefined,
          });
        }
        const { sendFileXmpp } = await loadXmppChannelRuntime();
        return await sendFileXmpp(to, text, mediaUrl, {
          cfg: cfg as CoreConfig,
          accountId: accountId ?? undefined,
          replyTo: replyToId ?? undefined,
          ...mediaLoaderOptions(params as Record<string, unknown>),
        });
      },
    },
  },
});
