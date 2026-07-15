// Xmpp plugin module implements runtime behavior.
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "./runtime-api.js";

const { setRuntime: setXmppRuntime, getRuntime: getXmppRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "xmpp",
    errorMessage: "XMPP runtime not initialized",
  });
export { getXmppRuntime, setXmppRuntime };
