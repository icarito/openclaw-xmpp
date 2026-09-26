// Xmpp type declarations define plugin contracts.
import type { ChannelDeliveryStreamingConfig } from "openclaw/plugin-sdk/channel-outbound";
import type {
  DmConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
  MarkdownConfig,
  OpenClawConfig,
  BaseProbeResult,
} from "./runtime-api.js";

export type XmppInlineButtonsScope = "off" | "dm" | "group" | "all" | "allowlist";
export type XmppCapabilitiesConfig =
  | string[]
  | {
      inlineButtons?: XmppInlineButtonsScope;
    };

export type XmppReliabilityConfig = {
  /** Fusión de ráfagas entrantes del mismo remitente (estilo Telegram). */
  debounce?: {
    enabled?: boolean;
    /** Ventana de inactividad antes de despachar la ráfaga fusionada. */
    windowMs?: number;
  };
  /** Freno de cadenas de reintento de salida hacia un mismo destino. */
  burstBreaker?: {
    enabled?: boolean;
    maxTurns?: number;
    maxMessages?: number;
    windowMs?: number;
    pausedMs?: number;
  };
  /** Spool persistente de salientes no reconocidos (XEP-0198/XEP-0184). */
  spool?: {
    enabled?: boolean;
    resendOnReconnect?: boolean;
    maxAgeMs?: number;
    maxAttempts?: number;
  };
  /** Dedupe durable de despacho (claims con TTL). */
  dispatchDedupe?: {
    enabled?: boolean;
    ttlMs?: number;
  };
};

export type XmppHistoryConfig = {
  /** Catch-up de historial vía XEP-0313 (fase B; default observacional/off). */
  catchup?: boolean;
  /**
   * Opt-in: convierte cada mensaje recuperado del archivo en un turno del
   * modelo. Default false = modo observacional (solo contexto de sesión).
   */
  spawnTurns?: boolean;
  windowMs?: number;
  maxPages?: number;
  mucMaxStanzas?: number;
};

export type XmppHooksConfig = {
  /** Eventos PEP estructurados (fase C). */
  pepEvents?: boolean;
  /** Reacciones XEP-0444 (fase C). */
  reactions?: boolean;
  /** Receipts XEP-0184 en finales durables. */
  receipts?: boolean;
};

export type XmppChannelConfig = {
  requireMention?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  skills?: string[];
  enabled?: boolean;
  allowFrom?: Array<string | number>;
  systemPrompt?: string;
};

export type XmppAccountConfig = {
  name?: string;
  enabled?: boolean;
  /**
   * Break-glass override: allow bare-nick allowlist matching in MUC rooms
   * (no verified JID). Default behavior requires a real JID.
   */
  dangerouslyAllowNameMatching?: boolean;
  /** Full JID, e.g. "agent@example.org". */
  jid?: string;
  password?: string;
  passwordFile?: string;
  /** Connection URI, e.g. "xmpp://127.0.0.1:5222". Defaults to derived from jid domain + srv/BOSH discovery via @xmpp/client. */
  service?: string;
  /** Resource used on connect (defaults to "openclaw-<accountId>"). */
  resource?: string;
  /** Domain hosting MUC rooms this account should treat as group chats, e.g. "conference.example.org". */
  mucDomain?: string;
  /** Bare JIDs of MUC rooms to auto-join on connect. */
  mucRooms?: string[];
  /**
   * Bare JID to redirect exec/plugin approval cards to instead of the room
   * they were triggered from. Approval prompts (and their allow/deny
   * decisions) are meant for the human operator, not for every occupant of
   * a shared MUC room — without this, a group's exec approvals are visible
   * to everyone in it. Only affects delivery target; approval logic and
   * session scoping are unchanged.
   */
  approvalDmJid?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  defaultTo?: string;
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: Array<string | number>;
  groups?: Record<string, XmppChannelConfig>;
  mentionPatterns?: string[];
  markdown?: MarkdownConfig;
  historyLimit?: number;
  dmHistoryLimit?: number;
  dms?: Record<string, DmConfig>;
  textChunkLimit?: number;
  streaming?: ChannelDeliveryStreamingConfig;
  responsePrefix?: string;
  mediaMaxMb?: number;
  capabilities?: XmppCapabilitiesConfig;
  /** Context-window size used to compute the /context percentage. */
  contextWindowTokens?: number;
  /** OMEMO encryption configuration. */
  omemo?: {
    enabled?: boolean;
    deviceLabel?: string;
    /** Protocol namespace used for publication/envelopes (defaults to legacy). */
    /** Use `dual` to publish the same device and bundle in both OMEMO namespaces. */
    protocol?: "legacy" | "v2" | "dual";
    /** Refuse plaintext when OMEMO cannot encrypt a message. */
    requireEncryption?: boolean;
  };
  streamManagement?: {
    enabled?: boolean;
    resumptionMaxSeconds?: number;
  };
  /** Fiabilidad de entrega (spool, debounce, burst breaker, dedupe de despacho). */
  reliability?: XmppReliabilityConfig;
  /** Historial XEP-0313 (fase B). */
  history?: XmppHistoryConfig;
  /** Superficie de hooks estándar para clientes ad-hoc (fase C). */
  hooks?: XmppHooksConfig;
};

type XmppConfig = XmppAccountConfig & {
  accounts?: Record<string, XmppAccountConfig>;
  defaultAccount?: string;
};

export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    xmpp?: XmppConfig;
  };
};

export type XmppInboundMessage = {
  messageId: string;
  /** Conversation peer id: room bare JID for groups, sender bare JID for DMs. */
  target: string;
  /** Raw XMPP `from` attribute (full JID, with resource for MUC). */
  rawFrom?: string;
  senderJid: string;
  senderNick?: string;
  text: string;
  timestamp: number;
  isGroup: boolean;
  /** True when the bot's nick/JID was actually mentioned in a group message. */
  wasMentioned: boolean;
  /** XEP-0461 reply context, if present. */
  replyTo?: { text: string; sender: string };
  /** XEP-0363/XEP-0066 out-of-band attachment URL, if present. */
  oobUrl?: string;
  /** True when this message arrived through XEP-0280 from another resource. */
  isCarbonCopy?: boolean;
  wasEncrypted?: boolean;
};

export type XmppProbe = BaseProbeResult<string> & {
  jid: string;
  service: string;
  latencyMs?: number;
};
