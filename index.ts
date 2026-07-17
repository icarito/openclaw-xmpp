// Xmpp plugin entrypoint registers its OpenClaw integration.
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerXmppAvatarGatewayMethods, XMPP_SET_AVATAR_METHOD } from "./src/avatar-gateway.js";

export default defineBundledChannelEntry({
  id: "xmpp",
  name: "XMPP",
  description: "XMPP/Jabber channel plugin",
  importMetaUrl: import.meta.url,
  // El agente no puede tocar su propia conexión XMPP: sin un método del
  // gateway, "ponte este avatar" acaba en `exec` y en una cascada de
  // aprobaciones.
  registerFull: (api) => {
    registerXmppAvatarGatewayMethods(api);
  },
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "xmppPlugin",
  },
  outbound: {
    specifier: "./src/message-adapter.js",
    exportName: "xmppMessageAdapter",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setXmppRuntime",
  },
});
