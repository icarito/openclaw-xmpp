// Tareas 3.1 y 3.5 de xmpp-first-class-channel: debounce de entrada.
import { describe, expect, it } from "vitest";

import { InboundDebouncer, mergeXmppInboundMessages, shouldDebounceInbound } from "../inbound-debounce.js";
import type { XmppInboundMessage } from "../types.js";

function msg(overrides: Partial<XmppInboundMessage>): XmppInboundMessage {
  return {
    messageId: overrides.messageId ?? "m1",
    target: overrides.target ?? "peer@example.org",
    senderJid: overrides.senderJid ?? "peer@example.org",
    text: overrides.text ?? "",
    timestamp: overrides.timestamp ?? 1,
    isGroup: overrides.isGroup ?? false,
    wasMentioned: overrides.wasMentioned ?? true,
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mergeXmppInboundMessages", () => {
  it("fusiona texto y adjuntos preservando el orden", () => {
    const merged = mergeXmppInboundMessages([
      msg({ messageId: "a", text: "primero" }),
      msg({ messageId: "b", text: "segundo", oobUrl: "https://files.example/1" }),
      msg({ messageId: "c", text: "tercero", oobUrl: "https://files.example/2", wasMentioned: false }),
    ]);
    expect(merged.messageId).toBe("a");
    expect(merged.text.split("\n")).toEqual([
      "primero",
      "segundo",
      "tercero",
      "https://files.example/2",
    ]);
    expect(merged.oobUrl).toBe("https://files.example/1");
    expect(merged.wasMentioned).toBe(true);
  });
});

describe("InboundDebouncer", () => {
  it("una ráfaga dentro de la ventana produce un único turno", async () => {
    const flushed: XmppInboundMessage[] = [];
    const debouncer = new InboundDebouncer({ windowMs: 30, flush: (message) => { flushed.push(message); } });
    debouncer.push("k", msg({ messageId: "a", text: "uno" }));
    debouncer.push("k", msg({ messageId: "b", text: "dos" }));
    debouncer.push("k", msg({ messageId: "c", text: "tres" }));
    expect(flushed).toHaveLength(0);
    await sleep(80);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.text).toBe("uno\ndos\ntres");
  });

  it("mensajes separados por encima de la ventana van como turnos independientes", async () => {
    const flushed: XmppInboundMessage[] = [];
    const debouncer = new InboundDebouncer({ windowMs: 20, flush: (message) => { flushed.push(message); } });
    debouncer.push("k", msg({ messageId: "a", text: "uno" }));
    await sleep(60);
    debouncer.push("k", msg({ messageId: "b", text: "dos" }));
    await sleep(60);
    expect(flushed.map((message) => message.text)).toEqual(["uno", "dos"]);
  });

  it("no debouncea comandos de control ni mensajes de steer", () => {
    const base = { message: msg({}), hasPendingInteraction: false, turnBusy: false };
    expect(shouldDebounceInbound({ ...base, isControlCommand: true })).toBe(false);
    expect(shouldDebounceInbound({ ...base, isControlCommand: false, turnBusy: true })).toBe(false);
    expect(shouldDebounceInbound({ ...base, isControlCommand: false, turnBusy: false })).toBe(true);
  });
});
