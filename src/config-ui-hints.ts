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
} satisfies Record<string, ChannelConfigUiHint>;
