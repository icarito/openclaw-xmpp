// Tareas 5.2/5.6 de xmpp-first-class-channel: watermark persistente MAM.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MamWatermark, archiveIdKey, dmPeerKey, parsePeerKey, roomPeerKey } from "../mam-watermark.js";

const tempDirs: string[] = [];

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "xmpp-mam-watermark-"));
  tempDirs.push(dir);
  return join(dir, "account-mam-watermark.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("MamWatermark", () => {
  it("avanza sin gaps y conserva todos los ids vistos", () => {
    const watermark = new MamWatermark({ path: null });
    const peer = dmPeerKey("peer@example.org");
    watermark.setLast(peer, { by: "bot@example.org", id: "m1" });
    watermark.setLast(peer, { by: "bot@example.org", id: "m2" });
    watermark.setLast(peer, { by: "bot@example.org", id: "m3" });

    expect(watermark.last(peer)).toEqual({ by: "bot@example.org", id: "m3" });
    expect(watermark.anchor(peer).anchor).toBe("m3");
    expect(watermark.isSeen(peer, { by: "bot@example.org", id: "m1" })).toBe(true);
    expect(watermark.isSeen(peer, { by: "bot@example.org", id: "m3" })).toBe(true);
    expect(watermark.isSeen(peer, { by: "otro@example.org", id: "m3" })).toBe(false);
  });

  it("persiste y recarga tras un reinicio del proceso", () => {
    const path = tempPath();
    const first = new MamWatermark({ path });
    first.setLast(roomPeerKey("room@conference.example.org"), { by: "room@conference.example.org", id: "r7" });

    const restarted = new MamWatermark({ path });
    const peer = roomPeerKey("room@conference.example.org");
    expect(restarted.last(peer)).toEqual({ by: "room@conference.example.org", id: "r7" });
    expect(restarted.anchor(peer).anchor).toBe("r7");
    expect(restarted.isSeen(peer, { by: "room@conference.example.org", id: "r7" })).toBe(true);
    expect(restarted.peersList()).toContain(peer);

    const raw = JSON.parse(readFileSync(path, "utf8")) as { version: number };
    expect(raw.version).toBe(1);
  });

  it("markSeen no mueve el anclaje", () => {
    const watermark = new MamWatermark({ path: null });
    const peer = dmPeerKey("peer@example.org");
    watermark.setLast(peer, { by: "b", id: "m5" });
    watermark.markSeen(peer, { by: "b", id: "m6" });
    expect(watermark.anchor(peer).anchor).toBe("m5");
    expect(watermark.isSeen(peer, { by: "b", id: "m6" })).toBe(true);
  });

  it("poda ids vistos por TTL", () => {
    const watermark = new MamWatermark({ path: null, seenTtlMs: 10 });
    const peer = dmPeerKey("peer@example.org");
    watermark.markSeen(peer, { by: "b", id: "viejo" }, 0);
    expect(watermark.isSeen(peer, { by: "b", id: "viejo" }, 5)).toBe(true);
    expect(watermark.prune(1000)).toBe(1);
    expect(watermark.isSeen(peer, { by: "b", id: "viejo" }, 1000)).toBe(false);
  });

  it("archiveIdKey y claves de peer son inequívocas", () => {
    expect(archiveIdKey({ by: "a", id: "1" })).toBe("a\u00001");
    expect(archiveIdKey(null)).toBeNull();
    expect(parsePeerKey(dmPeerKey("x@example.org"))).toEqual({ kind: "dm", jid: "x@example.org" });
    expect(parsePeerKey(roomPeerKey("room@conference.example.org"))).toEqual({
      kind: "room",
      jid: "room@conference.example.org",
    });
    expect(parsePeerKey("garbage")).toBeNull();
  });
});
