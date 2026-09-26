// Tareas 3.2 y 3.5 de xmpp-first-class-channel: dedupe durable de despacho.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DispatchDedupeStore } from "../dispatch-dedupe.js";

const tempDirs: string[] = [];

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "xmpp-dedupe-"));
  tempDirs.push(dir);
  return join(dir, "account-dispatch-dedupe.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("DispatchDedupeStore", () => {
  it("descarta el replay de una stanza tras reinicio dentro del TTL", () => {
    const path = tempPath();
    const first = new DispatchDedupeStore({ path, ttlMs: 1_000_000 });
    expect(first.claim("dispatch:k")).toBe("new");
    first.commit("dispatch:k");

    const restarted = new DispatchDedupeStore({ path, ttlMs: 1_000_000 });
    expect(restarted.claim("dispatch:k")).toBe("duplicate");
  });

  it("rollback de un claim no comprometido permite reintentar", () => {
    const store = new DispatchDedupeStore({ path: null, ttlMs: 1_000_000 });
    expect(store.claim("dispatch:k")).toBe("new");
    expect(store.rollback("dispatch:k")).toBe(true);
    expect(store.claim("dispatch:k")).toBe("new");
  });

  it("no libera un claim ya comprometido (evita turno doble)", () => {
    const store = new DispatchDedupeStore({ path: null, ttlMs: 1_000_000 });
    store.claim("dispatch:k");
    store.commit("dispatch:k");
    expect(store.rollback("dispatch:k")).toBe(false);
    expect(store.claim("dispatch:k")).toBe("duplicate");
  });

  it("un commit duplicado es fatal", () => {
    const store = new DispatchDedupeStore({ path: null, ttlMs: 1_000_000 });
    store.claim("dispatch:k");
    expect(store.commit("dispatch:k")).toEqual({ ok: true, duplicateCommit: false });
    expect(store.commit("dispatch:k")).toEqual({ ok: false, duplicateCommit: true });
    expect(store.commit("dispatch:unknown")).toEqual({ ok: false, duplicateCommit: true });
  });

  it("expira claims fuera del TTL", () => {
    const store = new DispatchDedupeStore({ path: null, ttlMs: 100 });
    expect(store.claim("dispatch:k", 0)).toBe("new");
    expect(store.claim("dispatch:k", 500)).toBe("new");
  });
});
