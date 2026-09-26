// Tareas 5.3/5.4/5.5/5.6 de xmpp-first-class-channel: contexto observacional,
// decisión del guard XEP-0203 y control de historial MUC.
import { describe, expect, it } from "vitest";
import { xml } from "@xmpp/client";

import { buildMucJoinPresence } from "../client.js";
import {
  CatchupContextStore,
  applyCatchupMessages,
  decideArchiveReplay,
  formatCatchupContext,
} from "../history-context.js";
import type { MamArchivedMessage } from "../mam.js";
import { stanzaArchiveId } from "../mam.js";
import { MamWatermark, dmPeerKey } from "../mam-watermark.js";
import { NS_STANZA_ID } from "../protocol.js";

function archived(id: string, body: string, from = "peer@example.org"): MamArchivedMessage {
  return {
    archiveId: { by: "bot@example.org", id },
    message: xml("message", { from, type: "chat" }, xml("body", {}, body)),
    body,
    from,
    type: "chat",
    delayMs: Date.parse("2026-09-26T10:00:00Z"),
  };
}

describe("decideArchiveReplay", () => {
  const archiveId = { by: "bot@example.org", id: "m1" };

  it("con MAM, un archive-id ya cubierto es replay", () => {
    expect(decideArchiveReplay({ mamEnabled: true, archiveId, seen: true, staleByAge: true })).toBe("replay");
  });

  it("con MAM, un mensaje viejo no cubierto cae al guard de edad (red de seguridad)", () => {
    expect(decideArchiveReplay({ mamEnabled: true, archiveId, seen: false, staleByAge: true })).toBe("stale");
  });

  it("sin MAM reproduce el guard actual (regresión cero)", () => {
    expect(decideArchiveReplay({ mamEnabled: false, archiveId, seen: true, staleByAge: true })).toBe("stale");
    expect(decideArchiveReplay({ mamEnabled: false, archiveId, seen: false, staleByAge: false })).toBe("fresh");
  });

  it("una delayed stanza cubierta por el watermark se descarta por dedupe", () => {
    const watermark = new MamWatermark({ path: null });
    const peer = dmPeerKey("peer@example.org");
    watermark.setLast(peer, { by: "bot@example.org", id: "m10" });
    const delayed = xml(
      "message",
      { type: "chat", from: "peer@example.org", id: "oc-live" },
      xml("delay", { xmlns: "urn:xmpp:delay", stamp: new Date(Date.now() - 10 * 60 * 1000).toISOString() }),
      xml("stanza-id", { xmlns: NS_STANZA_ID, by: "bot@example.org", id: "m10" }),
      xml("body", {}, "viejo"),
    );
    const id = stanzaArchiveId(delayed);
    expect(id).toEqual({ by: "bot@example.org", id: "m10" });
    expect(
      decideArchiveReplay({ mamEnabled: true, archiveId: id, seen: watermark.isSeen(peer, id), staleByAge: true }),
    ).toBe("replay");
  });
});

describe("CatchupContextStore", () => {
  it("acumula, limita y drena por peer", () => {
    const store = new CatchupContextStore({ maxEntries: 3 });
    store.record("dm:a", [
      { from: "a", at: 1, text: "uno" },
      { from: "a", at: 2, text: "dos" },
    ]);
    store.record("dm:a", [
      { from: "a", at: 3, text: "tres" },
      { from: "a", at: 4, text: "cuatro" },
    ]);
    expect(store.peek("dm:a").map((e) => e.text)).toEqual(["dos", "tres", "cuatro"]);
    expect(store.drain("dm:a")).toHaveLength(3);
    expect(store.drain("dm:a")).toHaveLength(0);
    expect(store.stats().entries).toBe(0);
  });

  it("formatea un transcript compacto de contexto", () => {
    const text = formatCatchupContext([{ from: "peer@example.org", at: Date.parse("2026-09-26T10:00:00Z"), text: "hola" }]);
    expect(text).toContain("Historial recuperado");
    expect(text).toContain("peer@example.org: hola");
    expect(formatCatchupContext([])).toBe("");
  });
});

describe("applyCatchupMessages", () => {
  it("modo observacional: contexto, sin turnos, watermark sin gaps", () => {
    const watermark = new MamWatermark({ path: null });
    const context = new CatchupContextStore();
    const peer = dmPeerKey("peer@example.org");
    const dispatched: string[] = [];

    const applied = applyCatchupMessages({
      peerKey: peer,
      messages: [archived("m1", "uno"), archived("m2", "dos"), archived("m3", "tres")],
      watermark,
      context,
      spawnTurns: false,
      dispatch: (message) => dispatched.push(message.body ?? ""),
    });

    expect(applied).toEqual({ contextCount: 3, turnCount: 0 });
    expect(dispatched).toHaveLength(0);
    expect(watermark.anchor(peer).anchor).toBe("m3");
    expect(watermark.isSeen(peer, { by: "bot@example.org", id: "m1" })).toBe(true);
    expect(context.peek(peer).map((e) => e.text)).toEqual(["uno", "dos", "tres"]);
  });

  it("spawnTurns opt-in: despacha turnos y no llena el contexto", () => {
    const watermark = new MamWatermark({ path: null });
    const context = new CatchupContextStore();
    const peer = dmPeerKey("peer@example.org");
    const dispatched: string[] = [];

    const applied = applyCatchupMessages({
      peerKey: peer,
      messages: [archived("m1", "uno"), archived("m2", "dos")],
      watermark,
      context,
      spawnTurns: true,
      dispatch: (message) => dispatched.push(message.body ?? ""),
    });

    expect(applied).toEqual({ contextCount: 0, turnCount: 2 });
    expect(dispatched).toEqual(["uno", "dos"]);
    expect(context.peek(peer)).toHaveLength(0);
  });
});

describe("control de historial MUC", () => {
  it("join con maxstanzas=0 por default (sin replay del servidor)", () => {
    const presence = buildMucJoinPresence("room@conference.example.org", "bot");
    expect(presence.attrs.to).toBe("room@conference.example.org/bot");
    const x = presence.getChild("x", "http://jabber.org/protocol/muc")!;
    expect(x.getChild("history")!.attrs.maxstanzas).toBe("0");
  });

  it("join respeta un maxstanzas configurado", () => {
    const presence = buildMucJoinPresence("room@conference.example.org", "bot", 5);
    const x = presence.getChild("x", "http://jabber.org/protocol/muc")!;
    expect(x.getChild("history")!.attrs.maxstanzas).toBe("5");
  });
});
