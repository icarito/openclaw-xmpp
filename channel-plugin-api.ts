// Keep bundled channel entry imports narrow so bootstrap/discovery paths do
// not drag XMPP runtime/send/monitor surfaces into lightweight plugin loads.
export { xmppPlugin } from "./src/channel.js";
