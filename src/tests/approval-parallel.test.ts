// Incidente 2026-10-11 (Bob): dos exec paralelos del mismo turno. La segunda
// aprobación se rechazaba en la entrega y el usuario solo veía un texto
// "Reply with: /approve <id>" sin botones. Ahora ambas reciben card, y solo
// la primera es dueña de la ranura del guard de sesión.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ to: string; payload: { presentation?: unknown } }> = [];
let counter = 0;

vi.mock("../channel-runtime.js", () => ({
  sendPayloadXmpp: vi.fn(async (to: string, _text: string, payload: { presentation?: unknown }) => {
    sent.push({ to, payload });
    counter += 1;
    return { messageId: `stanza-${counter}`, target: to };
  }),
  sendEditXmpp: vi.fn(async () => undefined),
}));

const registry = new Map<string, { approvalId: string; sessionKey?: string }>();
vi.mock("../approval-card-registry.js", () => ({
  getApprovalCardRegistry: () => ({
    register: (card: { stanzaId: string; approvalId: string; sessionKey?: string }) => registry.set(card.stanzaId, card),
    get: (stanzaId: string) => registry.get(stanzaId),
    removeByStanza: (stanzaId: string) => registry.delete(stanzaId),
    removeByApprovalId: () => undefined,
  }),
}));

const { xmppApprovalNativeRuntime } = await import("../approval-handler.runtime.js");
const transport = (xmppApprovalNativeRuntime as unknown as {
  transport: {
    deliverPending: (p: unknown) => Promise<{ stanzaId: string; sessionKey?: string; jid: string }>;
    updateEntry: (p: unknown) => Promise<void>;
  };
}).transport;

const cfg = { channels: { xmpp: {} } };
const SESSION = "agent:bob:xmpp:bob:direct:owner@example.test";

function deliver(id: string) {
  return transport.deliverPending({
    cfg,
    accountId: "bob",
    preparedTarget: { to: "owner@example.test", accountId: "bob" },
    pendingPayload: { text: `card ${id}`, presentation: { buttons: [`/approve ${id} allow-once`] } },
    request: { id, expiresAtMs: null, request: { sessionKey: SESSION } },
    view: { approvalKind: "exec", commandText: `cmd ${id}` },
  });
}

function resolve(entry: { stanzaId: string; jid: string; sessionKey?: string }) {
  return transport.updateEntry({ cfg, accountId: "bob", entry: { ...entry, accountId: "bob" }, payload: { text: "✅ aprobado" } });
}

describe("aprobaciones paralelas de una misma sesión", () => {
  beforeEach(() => { sent.length = 0; });

  it("entrega card con botones a ambas y solo la primera retiene la ranura", async () => {
    const first = await deliver("aaaa1111");
    const second = await deliver("bbbb2222");
    expect(sent).toHaveLength(2);
    expect(sent[1].payload.presentation).toEqual({ buttons: ["/approve bbbb2222 allow-once"] });
    expect(first.sessionKey).toBe(SESSION);
    expect(second.sessionKey).toBeUndefined();
    expect(registry.get(second.stanzaId)?.sessionKey).toBeUndefined();

    // Cerrar la paralela no libera la ranura de la primera...
    await resolve(second);
    expect((await deliver("cccc3333")).sessionKey).toBeUndefined();
    // ...cerrar la dueña sí.
    await resolve(first);
    expect((await deliver("dddd4444")).sessionKey).toBe(SESSION);
  });
});
