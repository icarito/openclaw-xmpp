// Tarea 2.4 de xmpp-first-class-channel: escenarios del spool de salientes.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { xml } from "@xmpp/client";

import { OutboundSpool } from "../outbound-spool.js";
import { buildOriginIdElement } from "../protocol.js";

const tempDirs: string[] = [];

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "xmpp-spool-"));
  tempDirs.push(dir);
  return join(dir, "account-outbound-spool.json");
}

function makeStanza(id: string, to: string): string {
  return xml(
    "message",
    { type: "chat", to, id },
    xml("body", {}, "hola"),
    buildOriginIdElement(id),
  ).toString();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("OutboundSpool", () => {
  it("persiste y recarga pendientes tras un reinicio del proceso", () => {
    const path = tempPath();
    const first = new OutboundSpool({ path, maxAgeMs: 1_000_000, maxAttempts: 5 });
    first.enqueue({ originId: "oc-1", to: "peer@example.org", type: "chat", stanza: makeStanza("oc-1", "peer@example.org") });
    first.noteSent("oc-1");

    const restarted = new OutboundSpool({ path, maxAgeMs: 1_000_000, maxAttempts: 5 });
    const due = restarted.listDue();
    expect(due).toHaveLength(1);
    expect(due[0]!.originId).toBe("oc-1");
    // El reenvío usa el MISMO origin-id embebido en la stanza.
    const element = restarted.toElement(due[0]!);
    expect(element.getChild("origin-id", "urn:xmpp:sid:0")?.attrs.id).toBe("oc-1");
  });

  it("un resume exitoso con contador h no deja nada por reenviar", () => {
    const path = tempPath();
    const spool = new OutboundSpool({ path, maxAgeMs: 1_000_000, maxAttempts: 5 });
    spool.enqueue({ originId: "oc-1", to: "a@example.org", type: "chat", stanza: makeStanza("oc-1", "a@example.org") });
    spool.enqueue({ originId: "oc-2", to: "a@example.org", type: "chat", stanza: makeStanza("oc-2", "a@example.org") });
    spool.noteSent("oc-1");
    spool.noteSent("oc-2");

    const acked = spool.ackUpTo(2);
    expect(acked.sort()).toEqual(["oc-1", "oc-2"]);
    expect(spool.listDue()).toHaveLength(0);
  });

  it("solo marca reconocido lo cubierto por h (no replay ciego)", () => {
    const path = tempPath();
    const spool = new OutboundSpool({ path, maxAgeMs: 1_000_000, maxAttempts: 5 });
    spool.enqueue({ originId: "oc-1", to: "a@example.org", type: "chat", stanza: makeStanza("oc-1", "a@example.org") });
    spool.enqueue({ originId: "oc-2", to: "a@example.org", type: "chat", stanza: makeStanza("oc-2", "a@example.org") });
    spool.noteSent("oc-1");
    spool.noteSent("oc-2");

    expect(spool.ackUpTo(1)).toEqual(["oc-1"]);
    expect(spool.listDue().map((entry) => entry.originId)).toEqual(["oc-2"]);
  });

  it("un ack por receipt elimina la entrada del spool", () => {
    const path = tempPath();
    const spool = new OutboundSpool({ path, maxAgeMs: 1_000_000, maxAttempts: 5 });
    spool.enqueue({ originId: "oc-9", to: "a@example.org", type: "chat", stanza: makeStanza("oc-9", "a@example.org") });
    expect(spool.stats().pending).toBe(1);
    expect(spool.ack("oc-9")).toBe(true);
    expect(spool.stats().pending).toBe(0);
  });

  it("clasifica duplicate-commit como fatal y lo pasa a dead-letter", () => {
    const path = tempPath();
    const spool = new OutboundSpool({ path, maxAgeMs: 1_000_000, maxAttempts: 5 });
    spool.enqueue({ originId: "oc-d", to: "a@example.org", type: "chat", stanza: makeStanza("oc-d", "a@example.org") });
    const entry = spool.requeue("oc-d", new Error("duplicate-commit detected"));
    expect(entry?.state).toBe("dead");
    expect(entry?.errorClass).toBe("duplicate");
    expect(spool.listDead()).toHaveLength(1);
  });

  it("aplica backoff acotado a errores retryable y dead-letter al tope", () => {
    const path = tempPath();
    const spool = new OutboundSpool({ path, maxAgeMs: 1_000_000, maxAttempts: 2, backoffBaseMs: 1000, backoffMaxMs: 5000 });
    spool.enqueue({ originId: "oc-r", to: "a@example.org", type: "chat", stanza: makeStanza("oc-r", "a@example.org") });
    const first = spool.requeue("oc-r", new Error("ECONNRESET"), 1000);
    expect(first?.state).toBe("pending");
    expect(first!.nextAttemptAt).toBeGreaterThan(1000);
    const second = spool.requeue("oc-r", new Error("ECONNRESET"), 2000);
    expect(second?.state).toBe("dead");
    expect(spool.listDue(99_999)).toHaveLength(0);
  });

  it("expira entradas viejas y escribe el archivo atómicamente", () => {
    const path = tempPath();
    const spool = new OutboundSpool({ path, maxAgeMs: 10, maxAttempts: 5 });
    spool.enqueue({ originId: "oc-old", to: "a@example.org", type: "chat", stanza: makeStanza("oc-old", "a@example.org") }, 0);
    expect(spool.prune(1000)).toBe(1);
    expect(spool.stats().pending).toBe(0);
    // El archivo persiste como JSON válido (tmp+rename).
    const raw = JSON.parse(readFileSync(path, "utf8")) as { version: number };
    expect(raw.version).toBe(1);
  });
});
