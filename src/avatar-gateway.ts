// Xmpp plugin module: expone el avatar como método del gateway.
//
// Por qué un gateway method y no una skill de shell: el agente NO tiene acceso
// directo a su propia conexión XMPP. Sin esto, pedirle "ponte un avatar" lo
// empuja a improvisar con `exec`, que dispara una aprobación por comando (así
// se llenó el chat de approval requests en la primera prueba). Un método del
// gateway le da la capacidad como una llamada de una sola línea, sin shell y
// sin aprobaciones.
import { getActiveXmppConnection } from "./connection-registry.js";
import { publishAvatar } from "./avatar.js";

export const XMPP_SET_AVATAR_METHOD = "xmpp.avatar.set";

type RegisterGatewayMethod = (
  method: string,
  handler: (opts: {
    params: Record<string, unknown>;
    respond: (ok: boolean, payload?: unknown) => void;
  }) => Promise<void> | void,
  opts?: { scope?: never },
) => void;

function readString(params: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function registerXmppAvatarGatewayMethods(api: {
  registerGatewayMethod: RegisterGatewayMethod;
}): void {
  api.registerGatewayMethod(XMPP_SET_AVATAR_METHOD, async ({ params, respond }) => {
    try {
      const source = readString(params, "source", "path", "url", "image");
      if (!source) {
        respond(false, {
          error: "Falta 'source': la ruta local o la URL de la imagen del avatar",
        });
        return;
      }
      // Sin accountId asumimos la cuenta por defecto, que es el caso normal:
      // un agente tiene una sola cuenta XMPP.
      const accountId = readString(params, "accountId", "account") ?? "default";
      const connection = getActiveXmppConnection(accountId);
      if (!connection) {
        respond(false, {
          error: `La cuenta XMPP "${accountId}" no tiene una conexión activa`,
        });
        return;
      }

      const result = await publishAvatar({ accountId, connection, source });
      respond(true, {
        ok: true,
        hash: result.hash,
        bytes: result.bytes,
        mimeType: result.mimeType,
        // La presencia con el hash nuevo (XEP-0153) sale en el siguiente tick
        // del loop de telemetría, que corre cada 10s.
        note: "Avatar publicado (XEP-0084 + XEP-0153). Los clientes lo verán en unos segundos.",
      });
    } catch (error) {
      respond(false, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
