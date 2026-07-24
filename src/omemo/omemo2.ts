import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";
import { parse } from "ltx";
import { getActiveXmppConnection } from "../connection-registry.js";
import { pepFetch, pepPublish, pepRetract } from "../pep.js";
import type { Logger } from "./types.js";
import { Omemo2SidecarClient, type Omemo2Callback } from "./sidecar-client.js";

const NS_OMEMO_V2 = "urn:xmpp:omemo:2";
const DEVICES_NODE = `${NS_OMEMO_V2}:devices`;
const BUNDLES_NODE = `${NS_OMEMO_V2}:bundles`;
const clients = new Map<string, Omemo2SidecarClient>();
const deviceIds = new Map<string, number>();

function parseXml(value: string): Element {
  return parse(value) as Element;
}

function xmlPayload(result: Awaited<ReturnType<typeof pepFetch>>): string | null {
  const item = result.ok ? result.data?.[0] : undefined;
  return item?.payload?.toString() ?? null;
}

async function callback(
  accountId: string,
  ownJid: string,
  retiredDeviceIds: ReadonlySet<number>,
  method: Omemo2Callback,
  params: Record<string, unknown>,
  log?: Logger,
): Promise<unknown> {
  const jid = String(params.jid ?? "");
  const deviceId = Number(params.deviceId);
  switch (method) {
    case "upload_bundle": {
      const result = await pepPublish(accountId, BUNDLES_NODE, String(deviceId),
        parseXml(String(params.payload)), {
          accessModel: "open", persistItems: true, maxItems: 100,
        }, log);
      if (!result.ok) throw new Error(result.error ?? "bundle publication failed");
      return { ok: true };
    }
    case "download_bundle": {
      let result = await pepFetch(accountId, jid, BUNDLES_NODE, [String(deviceId)], log);
      let payload = xmlPayload(result);
      // Transitional read compatibility for the previously deployed draft layout.
      if (!payload) {
        result = await pepFetch(accountId, jid, `${BUNDLES_NODE}:${deviceId}`, undefined, log);
        payload = xmlPayload(result);
      }
      if (!payload) throw new Error(`OMEMO 2 bundle not found for ${jid}:${deviceId}`);
      return payload;
    }
    case "delete_bundle": {
      const result = await pepRetract(accountId, BUNDLES_NODE, String(deviceId), log);
      if (!result.ok) throw new Error(result.error ?? "bundle retraction failed");
      return { ok: true };
    }
    case "upload_device_list": {
      const result = await pepPublish(accountId, DEVICES_NODE, "current",
        parseXml(String(params.payload)), {
          accessModel: "open", persistItems: true, maxItems: 1,
        }, log);
      if (!result.ok) throw new Error(result.error ?? "device-list publication failed");
      return { ok: true };
    }
    case "download_device_list": {
      const result = await pepFetch(accountId, jid, DEVICES_NODE, undefined, log);
      const payload = xmlPayload(result);
      if (!payload) return `<devices xmlns="${NS_OMEMO_V2}"/>`;
      if (jid !== ownJid || retiredDeviceIds.size === 0) return payload;
      const devices = parseXml(payload).getChildren("device")
        .filter((device) => !retiredDeviceIds.has(Number(device.attrs.id)))
        .map((device) => xml("device", { ...device.attrs }));
      return xml("devices", { xmlns: NS_OMEMO_V2 }, ...devices).toString();
    }
    case "send_message": {
      const connection = getActiveXmppConnection(accountId);
      if (!connection?.xmpp) throw new Error("XMPP client not connected");
      await connection.xmpp.send(xml("message", { to: jid, type: "chat" },
        parseXml(String(params.payload))));
      return { ok: true };
    }
  }
}

export async function initializeOmemo2(
  accountId: string,
  selfJid: string,
  label: string | undefined,
  log?: Logger,
  retireDeviceIds: number[] = [],
): Promise<number> {
  const existing = clients.get(accountId);
  if (existing) await existing.stop();
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const python = process.env.OPENCLAW_OMEMO2_PYTHON
    ?? "/opt/claudio-w/openclaw-home/omemo2-venv/bin/python";
  const stateRoot = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  const ownJid = selfJid.split("/")[0]!;
  const retired = new Set(retireDeviceIds);
  for (const deviceId of retired) {
    await pepRetract(accountId, BUNDLES_NODE, String(deviceId), log);
    await pepRetract(accountId, `${BUNDLES_NODE}:${deviceId}`, "current", log);
  }
  const client = new Omemo2SidecarClient(
    python,
    path.join(moduleDir, "sidecar.py"),
    (method, params) => callback(accountId, ownJid, retired, method, params, log),
  );
  const result = await client.request<{ deviceId: number }>("initialize", {
    accountId,
    jid: ownJid,
    label: label || "OpenClaw",
    stateDir: path.join(stateRoot, "channel-cache", "xmpp"),
  });
  clients.set(accountId, client);
  deviceIds.set(accountId, result.deviceId);
  log?.info?.(`[${accountId}] genuine OMEMO 2 initialized (device ${result.deviceId})`);
  return result.deviceId;
}

export function hasOmemo2(accountId: string): boolean {
  return clients.has(accountId);
}

export async function encryptOmemo2(
  accountId: string,
  recipients: string[],
  plaintext: string,
): Promise<Element | null> {
  const client = clients.get(accountId);
  if (!client) return null;
  const result = await client.request<{ messages: string[]; errors: string[] }>("encrypt", {
    jids: recipients,
    plaintext,
  });
  if (result.messages.length === 0) {
    throw new Error(result.errors.join("; ") || "OMEMO 2 produced no encrypted message");
  }
  return parseXml(result.messages[0]!);
}

export async function decryptOmemo2(
  accountId: string,
  senderJid: string,
  encrypted: Element,
): Promise<string | null> {
  const client = clients.get(accountId);
  if (!client) return null;
  const result = await client.request<{ plaintext: string | null }>("decrypt", {
    jid: senderJid,
    payload: encrypted.toString(),
  });
  return result.plaintext === null ? null : Buffer.from(result.plaintext, "base64").toString("utf8");
}

export async function shutdownOmemo2(accountId: string): Promise<void> {
  const client = clients.get(accountId);
  clients.delete(accountId);
  deviceIds.delete(accountId);
  await client?.stop();
}
