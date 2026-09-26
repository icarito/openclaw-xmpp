// Tareas 6.1/6.2/6.3 de xmpp-first-class-channel: registro persistente de
// cards de aprobación y reconciliación de huérfanas al arranque.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ApprovalCardRegistry, type XmppApprovalCard } from "../approval-card-registry.js";

const tempDirs: string[] = [];

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "xmpp-approval-cards-"));
  tempDirs.push(dir);
  return join(dir, "account-approval-cards.json");
}

function card(overrides: Partial<XmppApprovalCard> = {}): XmppApprovalCard {
  return {
    approvalId: "apr-1",
    stanzaId: "oc-card-1",
    accountId: "test-account",
    jid: "operator@example.org",
    node: "cmd:oc-card-1",
    expiresAt: Date.now() + 15 * 60 * 1000,
    createdAt: Date.now(),
    sessionKey: "agent:test-account:peer",
    commandText: "/approve apr-1 allow-once",
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ApprovalCardRegistry", () => {
  it("persiste la card activa y la recarga tras un reinicio", () => {
    const path = tempPath();
    const first = new ApprovalCardRegistry({ path });
    first.register(card());
    expect(first.stats().active).toBe(1);

    const restarted = new ApprovalCardRegistry({ path });
    expect(restarted.get("oc-card-1")).toMatchObject({
      approvalId: "apr-1",
      jid: "operator@example.org",
      sessionKey: "agent:test-account:peer",
    });
  });

  it("remueve por stanza y por approval id", () => {
    const registry = new ApprovalCardRegistry({ path: null });
    registry.register(card());
    registry.register(card({ stanzaId: "oc-card-2", approvalId: "apr-2", node: "cmd:oc-card-2" }));
    expect(registry.removeByStanza("oc-card-1")).toBe(true);
    expect(registry.removeByApprovalId("apr-2")).toBe(true);
    expect(registry.stats().active).toBe(0);
  });

  it("kill con una card huérfana: se cierra con XEP-0308 y libera sessionKey", async () => {
    const path = tempPath();
    const dead = new ApprovalCardRegistry({ path });
    dead.register(card());

    // Proceso nuevo: la card persistida cruzó un reinicio.
    const restarted = new ApprovalCardRegistry({ path });
    const edits: Array<{ stanzaId: string; text: string }> = [];
    const released: string[] = [];
    const result = await restarted.reconcile({
      editCard: async (entry, text) => {
        edits.push({ stanzaId: entry.stanzaId, text });
      },
      releaseSessionKey: (sessionKey) => released.push(sessionKey),
    });

    expect(result).toEqual({ reconciled: 1, failed: 0 });
    expect(edits).toHaveLength(1);
    expect(edits[0]!.stanzaId).toBe("oc-card-1");
    expect(edits[0]!.text).toMatch(/reconciliada/i);
    expect(released).toEqual(["agent:test-account:peer"]);
    expect(restarted.stats().active).toBe(0);
  });

  it("arranque limpio sin huérfanas: sin ediciones ni ruido", async () => {
    const registry = new ApprovalCardRegistry({ path: null });
    let edits = 0;
    const result = await registry.reconcile({
      editCard: async () => {
        edits += 1;
      },
      releaseSessionKey: () => {
        throw new Error("no debería liberar nada");
      },
    });
    expect(result).toEqual({ reconciled: 0, failed: 0 });
    expect(edits).toBe(0);
  });

  it("una edición fallida no deja la card persistida (sin reintento eterno)", async () => {
    const registry = new ApprovalCardRegistry({ path: null });
    registry.register(card());
    const result = await registry.reconcile({
      editCard: async () => {
        throw new Error("connection down");
      },
    });
    expect(result).toEqual({ reconciled: 0, failed: 1 });
    expect(registry.stats().active).toBe(0);
  });
});
