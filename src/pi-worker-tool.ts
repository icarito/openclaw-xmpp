import { createConnection } from "node:net";
import { Type } from "typebox";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";

const SOCKET_PATH = "/run/claudio-w-pi-worker/control.sock";
const OPERATOR_AGENT_ID = "operator";
const OPERATOR_ACCOUNT_ID = "operator";
const OWNER_JID = "sebastian@hablar.fuentelibre.org";
const BARE_JID_PATTERN = "^[^@\\s/]+@[^@\\s/]+$";
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

const PiWorkerParams = Type.Object({
  action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("stop")]),
  room_jid: Type.Optional(Type.String({ minLength: 3, maxLength: 1024, pattern: BARE_JID_PATTERN })),
  spec: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
  authorized_jids: Type.Optional(
    Type.Array(
      Type.String({ minLength: 3, maxLength: 1024, pattern: BARE_JID_PATTERN }),
      { minItems: 1, maxItems: 32 },
    ),
  ),
}, {
  additionalProperties: false,
});

type PiWorkerParams = {
  action: "start" | "status" | "stop";
  room_jid?: string;
  spec?: string;
  authorized_jids?: string[];
};

function isOperatorXmppRun(ctx: OpenClawPluginToolContext): boolean {
  return (
    ctx.agentId === OPERATOR_AGENT_ID &&
    ctx.messageChannel === "xmpp" &&
    ctx.agentAccountId === OPERATOR_ACCOUNT_ID &&
    ctx.deliveryContext?.channel === "xmpp" &&
    ctx.deliveryContext.accountId === OPERATOR_ACCOUNT_ID &&
    typeof ctx.requesterSenderId === "string" &&
    ctx.requesterSenderId.length > 0
  );
}

function requesterJid(senderId: string | undefined, deliveryTarget: string | undefined): string | undefined {
  if (!senderId) return undefined;
  const isGroup = deliveryTarget?.startsWith("channel:") === true;
  const displayJid = senderId.match(/ <([^<>]+)>$/)?.[1];
  // In a MUC, never interpret the occupant nickname as a JID when Prosody
  // withheld the real JID (for example, an anonymous room).
  if (isGroup && !displayJid) return undefined;
  const jid = (isGroup ? displayJid : displayJid ?? senderId)?.split("/")[0]?.trim().toLowerCase();
  return jid?.includes("@") ? jid : undefined;
}

function validateParams(params: PiWorkerParams, ctx: OpenClawPluginToolContext): string | undefined {
  if (!isOperatorXmppRun(ctx)) return "pi_worker solo está disponible para Operator desde XMPP.";
  if ((params.action === "start" || params.action === "stop") &&
      requesterJid(ctx.requesterSenderId, ctx.deliveryContext?.to) !== OWNER_JID) {
    return "Solo el propietario puede iniciar o detener una sesión Pi.";
  }
  if (params.action === "start") {
    if (!params.room_jid || !isBareJid(params.room_jid)) {
      return "start requiere un room_jid válido.";
    }
    if (ctx.deliveryContext?.to !== `channel:${params.room_jid}`) {
      return "start solo puede usar el MUC XMPP de este turno.";
    }
    if (!params.spec?.trim()) return "start requiere una especificación.";
    if (!params.authorized_jids?.length) return "start requiere authorized_jids.";
    if (params.authorized_jids.some((jid) => !isBareJid(jid))) {
      return "authorized_jids debe contener JID bare.";
    }
  }
  if (params.action !== "start" &&
      (params.room_jid !== undefined || params.spec !== undefined || params.authorized_jids !== undefined)) {
    return `${params.action} no acepta parámetros de inicio.`;
  }
  return undefined;
}

function isBareJid(jid: string): boolean {
  return /^[^@\s/]+@[^@\s/]+$/.test(jid);
}

function callPiWorker(request: Record<string, unknown>): Promise<string> {
  const payload = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(payload, "utf8") > MAX_REQUEST_BYTES) {
    return Promise.reject(new Error("La solicitud supera el límite permitido."));
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: SOCKET_PATH });
    let response = "";
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? "");
    };

    socket.setTimeout(10_000, () => finish(new Error("El controlador Pi agotó el tiempo de espera.")));
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES) {
        finish(new Error("La respuesta del controlador Pi supera el límite permitido."));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline >= 0) {
        const line = response.slice(0, newline);
        try {
          const parsed: unknown = JSON.parse(line);
          finish(undefined, JSON.stringify(parsed));
        } catch {
          finish(new Error("El controlador Pi devolvió una respuesta inválida."));
        }
      }
    });
    socket.on("error", (error) => finish(new Error(`No se pudo contactar al controlador Pi: ${error.message}`)));
    socket.on("end", () => {
      if (!settled) finish(new Error("El controlador Pi cerró la conexión sin respuesta."));
    });
  });
}

export function registerPiWorkerTool(api: OpenClawPluginApi): void {
  api.registerTool((ctx) => {
    if (!isOperatorXmppRun(ctx)) return null;
    return {
      name: "pi_worker",
      label: "Pi worker",
      description:
        "Inicia, consulta o detiene la sesión Pi del proyecto claudio-w en el MUC actual.",
      parameters: PiWorkerParams,
      async execute(_toolCallId, rawParams) {
        const params = rawParams as PiWorkerParams;
        const invalid = validateParams(params, ctx);
        if (invalid) return { content: [{ type: "text", text: invalid }], details: {} };

        const request: Record<string, unknown> = {
          action: params.action,
          project: "claudio-w",
        };
        if (params.action === "start") {
          request.room_jid = params.room_jid;
          request.spec = params.spec;
          request.authorized_jids = [...new Set([OWNER_JID, ...(params.authorized_jids ?? [])])];
        }

        try {
          const result = await callPiWorker(request);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error del controlador Pi: ${String(error)}` }],
            details: {},
            isError: true,
          };
        }
      },
    };
  }, { name: "pi_worker" });
}
