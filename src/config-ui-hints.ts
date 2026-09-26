// Xmpp helper module supports config ui hints behavior.
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

// NOTE(xmpp-migration): `createChannelConfigUiHints` exists in the OpenClaw
// git source (see extensions/irc/src/config-ui-hints.ts upstream) but is not
// exported by the installed 2026.7.1 npm package (`openclaw/plugin-sdk/channel-core`
// only exports the `ChannelConfigUiHint` type, no factory function) — version
// skew between git HEAD and the published release. Standard dmPolicy/configWrites
// hint entries that helper would have added are omitted here; this only affects
// cosmetic help text in the config setup UI, not runtime behavior. Re-add the
// spread once the installed OpenClaw version ships that export.

export const xmppChannelConfigUiHints = {
  "": {
    label: "XMPP",
    help: "XMPP/Jabber channel provider configuration: JID, password, MUC domain, and auto-join rooms.",
  },
  jid: {
    label: "XMPP JID",
    help: "Full Jabber ID for this account, e.g. agent@example.org.",
  },
  password: {
    label: "XMPP Password",
    help: "Password for the JID above (sensitive).",
  },
  passwordFile: {
    label: "XMPP Password File",
    help: "Optional file path containing the XMPP password.",
  },
  service: {
    label: "XMPP Service URI",
    help: "Connection URI, e.g. xmpp://127.0.0.1:5222. Defaults to SRV/BOSH discovery via the JID domain when omitted.",
  },
  resource: {
    label: "XMPP Resource",
    help: "Connection resource (defaults to \"openclaw\").",
  },
  mucDomain: {
    label: "XMPP MUC Domain",
    help: "Conference domain hosting group chat rooms, e.g. conference.example.org. Required for room support.",
  },
  mucRooms: {
    label: "XMPP Auto-join Rooms",
    help: "Bare JIDs of rooms to join automatically on connect.",
  },
  contextWindowTokens: {
    label: "XMPP Context Window Tokens",
    help: "Context window size used to compute the /context percentage shown in ad-hoc commands.",
  },
  reliability: {
    label: "Fiabilidad de entrega",
    help: "Spool de salientes, debounce de entrada, burst breaker y dedupe durable de despacho.",
  },
  "reliability.debounce.enabled": {
    label: "Debounce de entrada",
    help: "Fusiona ráfagas del mismo remitente en un único turno.",
  },
  "reliability.debounce.windowMs": {
    label: "Ventana de debounce (ms)",
    help: "Inactividad necesaria antes de despachar la ráfaga fusionada. Default 1500.",
    advanced: true,
  },
  "reliability.burstBreaker.enabled": {
    label: "Burst breaker de salida",
    help: "Limita turnos/mensajes por destino y pausa cadenas de reintento auto-sostenidas.",
  },
  "reliability.burstBreaker.maxMessages": {
    label: "Máximo de mensajes por ventana",
    help: "Mensajes de salida permitidos por destino dentro de la ventana.",
    advanced: true,
  },
  "reliability.spool.enabled": {
    label: "Spool de salientes",
    help: "Persiste salientes no reconocidos (XEP-0198/XEP-0184) para reenviarlos al reconectar.",
  },
  "reliability.spool.resendOnReconnect": {
    label: "Reenviar al reconectar",
    help: "Reenvía pendientes del spool al abrir sesión nueva o tras un resume fallido.",
  },
  "reliability.dispatchDedupe.ttlMs": {
    label: "TTL del dedupe de despacho (ms)",
    help: "Retención de claims de despacho; default 7 días.",
    advanced: true,
  },
  history: {
    label: "Historial XEP-0313",
    help: "Catch-up de historial vía MAM (fase B); por defecto observacional.",
  },
  "history.catchup": {
    label: "Catch-up de historial",
    help: "Recupera mensajes desde el último archive-id visto al reconectar.",
  },
  hooks: {
    label: "Hooks para clientes ad-hoc",
    help: "Eventos PEP, reacciones XEP-0444 y receipts XEP-0184.",
  },
  "hooks.receipts": {
    label: "Receipts XEP-0184",
    help: "Solicita acuse de recibo en finales durables y responde a los recibidos.",
  },
  "hooks.reactions": {
    label: "Reacciones XEP-0444",
    help: "Reacciones salientes opt-in (fase C).",
    advanced: true,
  },
  "hooks.pepEvents": {
    label: "Eventos PEP",
    help: "Publica nodos PEP versionados con actividad/aprobación/progreso (fase C).",
    advanced: true,
  },
} satisfies Record<string, ChannelConfigUiHint>;
