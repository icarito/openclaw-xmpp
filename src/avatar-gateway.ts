// Xmpp plugin module: expone el avatar como método del gateway.
//
// Por qué un gateway method y no una skill de shell: el agente NO tiene acceso
// directo a su propia conexión XMPP. Sin esto, pedirle "ponte un avatar" lo
// empuja a improvisar con `exec`, que dispara una aprobación por comando (así
// se llenó el chat de approval requests en la primera prueba). Un método del
// gateway le da la capacidad como una llamada de una sola línea, sin shell y
// sin aprobaciones.
import { getActiveXmppConnection, listActiveXmppConnections } from "./connection-registry.js";
import { publishAvatar } from "./avatar.js";

export const XMPP_SET_AVATAR_METHOD = "xmpp.avatar.set";

type RegisterGatewayMethod = (
  method: string,
  handler: (opts: {
    params: Record<string, unknown>;
    respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => void;
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

function gatewayError(code: "INVALID_REQUEST" | "UNAVAILABLE", message: string): { code: string; message: string } {
  return { code, message };
}

function inferAccountIdFromSource(source: string): string | null {
  const normalized = source.replace(/\\/g, "/");
  const match = normalized.match(/\/(?:workspaces|agents)\/([^/]+)(?:\/|$)/);
  if (!match) return null;
  const workspace = match[1];
  return workspace === "main" ? "clawdio" : workspace;
}

function resolveAvatarConnection(requestedAccountId: string | null) {
  if (requestedAccountId) {
    const connection = getActiveXmppConnection(requestedAccountId);
    return connection ? { accountId: requestedAccountId, connection } : null;
  }

  const defaultConnection = getActiveXmppConnection("default");
  if (defaultConnection) return { accountId: "default", connection: defaultConnection };

  const active = listActiveXmppConnections().filter((entry) => entry.connection.isConnected());
  const clawdio = active.find((entry) => entry.accountId === "clawdio");
  if (clawdio) return clawdio;
  return active.length === 1 ? active[0] : null;
}

export function registerXmppAvatarGatewayMethods(api: {
  registerGatewayMethod: RegisterGatewayMethod;
}): void {
  api.registerGatewayMethod(XMPP_SET_AVATAR_METHOD, async ({ params, respond }) => {
    try {
      const source = readString(params, "source", "path", "url", "image");
      if (!source) {
        respond(
          false,
          undefined,
          gatewayError("INVALID_REQUEST", "Falta 'source': la ruta local o la URL de la imagen del avatar"),
        );
        return;
      }
      const requestedAccountId = readString(params, "accountId", "account") ?? inferAccountIdFromSource(source);
      const resolved = resolveAvatarConnection(requestedAccountId);
      if (!resolved) {
        const active = listActiveXmppConnections().map((entry) => entry.accountId).join(", ") || "ninguna";
        const hint = requestedAccountId
          ? `La cuenta XMPP "${requestedAccountId}" no tiene una conexión activa`
          : `No se pudo elegir una cuenta XMPP activa para publicar el avatar (activas: ${active}); pasa accountId`;
        respond(false, undefined, gatewayError("UNAVAILABLE", hint));
        return;
      }

      const result = await publishAvatar({ accountId: resolved.accountId, connection: resolved.connection, source });
      respond(true, {
        ok: true,
        accountId: resolved.accountId,
        hash: result.hash,
        bytes: result.bytes,
        mimeType: result.mimeType,
        // La presencia con el hash nuevo (XEP-0153) sale en el siguiente tick
        // del loop de telemetría, que corre cada 10s.
        note: "Avatar publicado (XEP-0084 + XEP-0153). Los clientes lo verán en unos segundos.",
      });
    } catch (error) {
      respond(false, undefined, gatewayError("UNAVAILABLE", error instanceof Error ? error.message : String(error)));
    }
  });
}
