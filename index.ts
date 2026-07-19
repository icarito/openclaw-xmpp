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

    // Cancelación activa: una aprobación cuya sesión murió se queda en
    // pantalla hasta expirar (el core no tiene salida por sesión, y el
    // runtime nativo no edita cards en onStopped). Al terminar el turno o la
    // sesión, denegamos en el gateway y editamos la card.
    //
    // Import dinámico a propósito: el runtime de approvals se carga lazy
    // (createLazyChannelApprovalNativeRuntimeAdapter) y un import estático lo
    // traería al arranque, cambiando cuándo se inicializa. El módulo cachea,
    // así que esto no repite trabajo.
    //
    // Nunca dejamos que un fallo aquí escape: son hooks del ciclo de vida del
    // agente, y una excepción no capturada afectaría al turno, no solo a la
    // card. Cancelar es best-effort.
    const cancelForSession = async (sessionKey: string | undefined, reason: string) => {
      if (!sessionKey) return;
      try {
        const { cancelApprovalsForSession } = await import("./src/approval-handler.runtime.js");
        await cancelApprovalsForSession({ cfg: api.config, sessionKey, reason });
      } catch (err) {
        api.logger?.warn?.(`xmpp: fallo cancelando approvals de ${sessionKey}: ${String(err)}`);
      }
    };

    // session_end cubre reciclado de sesión (idle/daily/compaction/reset) y el
    // apagado ordenado del gateway (shutdown/restart). No requiere permisos:
    // no es un hook de conversación.
    //
    // NO usamos agent_end, aunque parezca el candidato natural para "el turno
    // murió con una aprobación pendiente". Verificado empíricamente el
    // 2026-07-19: un turno bloqueado esperando decisión NO emite agent_end al
    // abortarse — el waitDecision vive en una IIFE detached del gateway, fuera
    // del ciclo del harness que lo emite. El hook disparó para otras sesiones
    // (crons) pero nunca para la que tenía la aprobación en vuelo. Además
    // exige plugins.entries.xmpp.hooks.allowConversationAccess=true, que abre
    // también llm_input/llm_output — un permiso amplio a cambio de nada.
    //
    // Queda sin cubrir, por tanto: turno abortado o caído con aprobación
    // pendiente. Esas cards siguen dependiendo de su expiración (5 min).
    api.on("session_end", async (event) => {
      await cancelForSession(event.sessionKey, `session_end:${event.reason ?? "unknown"}`);
    });
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
