// Xmpp plugin module: el agente publica su propio avatar.
//
// Se publican los dos estándares a la vez, porque ningún cliente implementa
// ambos:
//   - XEP-0084 (User Avatar): los datos y los metadatos van a dos nodos PEP.
//     Es lo que usan los clientes modernos.
//   - XEP-0153 (vCard-Based Avatars): sube la imagen a la vCard y anuncia su
//     SHA-1 en cada <presence>. Es lo que miran los clientes viejos, y el
//     único camino para que aparezca en muchos rosters.
//
// A diferencia del `ver` de las caps (ver telemetry.ts, donde el hash es un
// identificador opaco), aquí el SHA-1 SÍ es el de la spec: es la clave con la
// que los clientes cachean y piden la imagen. Un hash inventado deja el avatar
// sin resolver.
import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { XmppConnection } from "./client.js";

const AVATAR_DATA_NS = "urn:xmpp:avatar:data";
const AVATAR_METADATA_NS = "urn:xmpp:avatar:metadata";
const VCARD_NS = "vcard-temp";
const VCARD_UPDATE_NS = "vcard-temp:x:update";
const PUBSUB_NS = "http://jabber.org/protocol/pubsub";

/** Tope defensivo: un avatar es un icono, no una foto. */
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

export type AvatarPublishResult = {
  hash: string;
  bytes: number;
  mimeType: string;
};

/** Avatar publicado, para volver a anunciar su hash en cada presencia. */
const publishedAvatarHash = new Map<string, string>();

export function getPublishedAvatarHash(accountId: string): string | null {
  return publishedAvatarHash.get(accountId) ?? null;
}

/**
 * XEP-0153 exige que CADA presencia lleve <x xmlns='vcard-temp:x:update'> con
 * el SHA-1 del avatar; sin esto los clientes no se enteran de que cambió (y
 * algunos ni lo piden). Devuelve null si esta cuenta no tiene avatar.
 */
export function buildVCardUpdateElement(accountId: string): Element | null {
  const hash = publishedAvatarHash.get(accountId);
  if (!hash) return null;
  return xml("x", { xmlns: VCARD_UPDATE_NS }, xml("photo", {}, hash));
}

function sniffMimeType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("ascii").startsWith("GIF8")) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** Lee el avatar de una ruta local o de una URL http(s). */
async function loadImageBytes(source: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`No se pudo descargar el avatar (HTTP ${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  return readFile(source);
}

function buildDataPublish(base64: string, hash: string): Element {
  return xml(
    "iq",
    { type: "set", id: `avatar-data-${Date.now().toString(36)}` },
    xml(
      "pubsub",
      { xmlns: PUBSUB_NS },
      xml(
        "publish",
        { node: AVATAR_DATA_NS },
        // El id del item ES el hash: así lo pide XEP-0084, y es como el cliente
        // correlaciona los metadatos con los datos.
        xml("item", { id: hash }, xml("data", { xmlns: AVATAR_DATA_NS }, base64)),
      ),
    ),
  );
}

function buildMetadataPublish(hash: string, bytes: number, mimeType: string): Element {
  return xml(
    "iq",
    { type: "set", id: `avatar-meta-${Date.now().toString(36)}` },
    xml(
      "pubsub",
      { xmlns: PUBSUB_NS },
      xml(
        "publish",
        { node: AVATAR_METADATA_NS },
        xml(
          "item",
          { id: hash },
          xml(
            "metadata",
            { xmlns: AVATAR_METADATA_NS },
            xml("info", { id: hash, bytes: String(bytes), type: mimeType }),
          ),
        ),
      ),
    ),
  );
}

function buildVCardPublish(base64: string, mimeType: string): Element {
  return xml(
    "iq",
    { type: "set", id: `avatar-vcard-${Date.now().toString(36)}` },
    xml(
      "vCard",
      { xmlns: VCARD_NS },
      xml("PHOTO", {}, xml("TYPE", {}, mimeType), xml("BINVAL", {}, base64)),
    ),
  );
}

/**
 * Publica `source` (ruta local o URL) como avatar de la cuenta.
 *
 * Tras esto hay que reemitir la presencia para que el <x vcard-temp:x:update>
 * con el hash nuevo llegue a los contactos (el loop de telemetría lo hace en su
 * siguiente tick).
 */
export async function publishAvatar(params: {
  accountId: string;
  connection: XmppConnection;
  source: string;
}): Promise<AvatarPublishResult> {
  const { accountId, connection, source } = params;
  if (!connection.isConnected()) {
    throw new Error("XMPP no está conectado: no se puede publicar el avatar");
  }

  const bytes = await loadImageBytes(source);
  if (bytes.length === 0) throw new Error("El avatar está vacío");
  if (bytes.length > MAX_AVATAR_BYTES) {
    throw new Error(
      `El avatar pesa ${(bytes.length / 1024 / 1024).toFixed(1)} MB; el máximo es ${MAX_AVATAR_BYTES / 1024 / 1024} MB`,
    );
  }

  const mimeType = sniffMimeType(bytes);
  if (!mimeType) {
    throw new Error("Formato no reconocido: el avatar debe ser PNG, JPEG, GIF o WebP");
  }

  // SHA-1 de los bytes CRUDOS (no del base64): así lo definen XEP-0084 y 0153.
  const hash = createHash("sha1").update(bytes).digest("hex");
  const base64 = bytes.toString("base64");

  // send() y no iqCaller.request(): un avatar son cientos de KB en base64 y el
  // servidor tarda en confirmar los tres IQ; esperarlos agota el timeout del
  // gateway (10s) y la llamada falla aunque la publicación sí ocurra. Se envían
  // en orden -- datos, metadatos, vCard -- que es lo que exige XEP-0084.
  await connection.send(buildDataPublish(base64, hash));
  await connection.send(buildMetadataPublish(hash, bytes.length, mimeType));
  // La vCard es best-effort: si el servidor no la soporta, XEP-0084 ya cubre a
  // los clientes modernos y no tiene sentido tumbar la operación entera.
  try {
    await connection.send(buildVCardPublish(base64, mimeType));
  } catch {
    // best-effort
  }

  publishedAvatarHash.set(accountId, hash);
  return { hash, bytes: bytes.length, mimeType };
}
