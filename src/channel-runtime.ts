// Xmpp plugin module: lazy-loaded runtime barrel. Kept separate from
// channel.ts (the config/wiring surface) so bootstrap/discovery code paths
// that only need plugin metadata never pull in @xmpp/client, the monitor
// loop, or the command layer. Mirrors IRC's channel-runtime.js contract
// (loaded via createLazyRuntimeModule in gateway.ts / channel.ts).
export { clearTypingXmpp, sendEditXmpp, sendFileXmpp, sendMessageXmpp, sendPayloadXmpp, sendTypingXmpp } from "./send.js";
export { monitorXmppProvider } from "./monitor.js";
