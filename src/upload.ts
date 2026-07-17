// Xmpp plugin module implements upload behavior: XEP-0363 HTTP File Upload,
// ported from the file-send block in the NanoClaw adapter's deliver()
// (src/channels/xmpp.ts).
import { xml, type Client } from "@xmpp/client";
import type { Element } from "@xmpp/xml";

const HTTP_UPLOAD_NS = "urn:xmpp:http:upload:0";
const DISCO_ITEMS_NS = "http://jabber.org/protocol/disco#items";
const DISCO_INFO_NS = "http://jabber.org/protocol/disco#info";

// XEP-0363 upload components commonly run on a dedicated subdomain (e.g.
// upload.example.org) — never assume the bare account domain hosts it.
// Cache the discovered host per bare domain for the process lifetime.
const uploadServiceHostCache = new Map<string, string | null>();

export async function discoverUploadServiceHost(xmppClient: Client, domain: string): Promise<string | null> {
  if (uploadServiceHostCache.has(domain)) return uploadServiceHostCache.get(domain)!;

  try {
    const itemsResult = await xmppClient.iqCaller.request(
      xml("iq", { type: "get", to: domain }, xml("query", { xmlns: DISCO_ITEMS_NS })),
      15000,
    );
    const items = itemsResult.getChild("query", DISCO_ITEMS_NS)?.getChildren("item") ?? [];

    for (const item of items) {
      const itemJid = item.attrs.jid as string | undefined;
      if (!itemJid) continue;
      try {
        const infoResult = await xmppClient.iqCaller.request(
          xml("iq", { type: "get", to: itemJid }, xml("query", { xmlns: DISCO_INFO_NS })),
          15000,
        );
        const hasUpload = infoResult
          .getChild("query", DISCO_INFO_NS)
          ?.getChildren("feature")
          .some((f: Element) => f.attrs.var === HTTP_UPLOAD_NS);
        if (hasUpload) {
          uploadServiceHostCache.set(domain, itemJid);
          return itemJid;
        }
      } catch {
        // Some items may not respond to disco#info (e.g. MUC components
        // with restrictive ACLs) -- skip and keep looking.
      }
    }
  } catch {
    // disco#items itself failed -- fall through to caching the miss below.
  }

  uploadServiceHostCache.set(domain, null);
  return null;
}

const EXT_MIME_MAP: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  html: "text/html",
  ogg: "audio/ogg",
  opus: "audio/opus",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  zip: "application/zip",
  gz: "application/gzip",
};

export function mimeForFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  return EXT_MIME_MAP[ext || ""] || "application/octet-stream";
}

export type UploadResult =
  | { ok: true; getUrl: string }
  | { ok: false; reason: "no-upload-service" | "no-slot" | "missing-urls" | "put-failed"; status?: number; error?: string };

/**
 * Request an upload slot (XEP-0363) and PUT the file bytes. Returns the
 * download URL on success. Does not build/send the resulting <message> —
 * that's send.ts's job (it needs to interleave the caption text, mirroring
 * xmpp.ts deliver()'s file-attachment branch).
 */
export async function uploadFileXmpp(
  xmppClient: Client,
  domain: string,
  filename: string,
  data: Buffer,
): Promise<UploadResult> {
  const uploadHost = await discoverUploadServiceHost(xmppClient, domain);
  if (!uploadHost) {
    return { ok: false, reason: "no-upload-service" };
  }

  const mime = mimeForFilename(filename);
  const uploadService = await xmppClient.iqCaller.request(
    xml(
      "iq",
      { type: "get", to: uploadHost },
      xml("request", {
        xmlns: HTTP_UPLOAD_NS,
        filename,
        size: String(data.length),
        "content-type": mime,
      }),
    ),
    15000,
  );

  const slot = uploadService.getChild("slot", HTTP_UPLOAD_NS);
  if (!slot) {
    return { ok: false, reason: "no-slot" };
  }

  // XEP-0363: the URL lives in the `url` attribute of <get>/<put>, not as
  // element text.
  const getUrl = slot.getChild("get")?.attrs.url as string | undefined;
  const putEl = slot.getChild("put");
  const putUrl = putEl?.attrs.url as string | undefined;
  if (!putUrl || !getUrl) {
    return { ok: false, reason: "missing-urls" };
  }

  const putHeaders: Record<string, string> = {};
  const headerEls = putEl?.getChildren("header") ?? [];
  for (const h of headerEls) {
    const hname = h.attrs.name as string | undefined;
    if (hname && hname.toLowerCase() !== "content-length") putHeaders[hname] = h.text();
  }

  let putRes: Response;
  try {
    putRes = await fetch(putUrl, {
      method: "PUT",
      headers: { "Content-Type": mime, ...putHeaders },
      body: data as unknown as BodyInit,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "put-failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!putRes.ok && putRes.status !== 201) {
    return { ok: false, reason: "put-failed", status: putRes.status };
  }

  return { ok: true, getUrl };
}
