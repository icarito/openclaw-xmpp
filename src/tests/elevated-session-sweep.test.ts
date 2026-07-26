// sweepExpiredElevatedBypasses -- fail-closed en vez de fail-open cuando el
// gateway reinicia con un bypass activo. Reemplaza
// approval-bypass-sweep.test.ts tras xmpp-elevated-session-command: mismos
// casos, ahora sobre elevatedLevel. Archivo separado de
// elevated-session.test.ts porque necesita controlar directamente lo que
// devuelve listSessionEntries (entradas "persistidas" preexistentes), no
// solo lo que este módulo escribe durante el propio test.
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockEntry = {
  elevatedLevel?: string;
  pluginExtensions?: Record<string, Record<string, unknown>>;
};

const sessionStore = new Map<string, MockEntry>();

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: vi.fn(({ sessionKey }: { sessionKey: string }) => sessionStore.get(sessionKey)),
  patchSessionEntry: vi.fn(async ({ sessionKey, update }: { sessionKey: string; update: (e: MockEntry) => Partial<MockEntry> }) => {
    const current = sessionStore.get(sessionKey) ?? {};
    const patch = update(current);
    const next = { ...current, ...patch };
    sessionStore.set(sessionKey, next);
    return next;
  }),
  listSessionEntries: vi.fn(() =>
    [...sessionStore.entries()].map(([sessionKey, entry]) => ({ sessionKey, entry })),
  ),
}));

vi.mock("openclaw/plugin-sdk/routing", () => ({
  resolveAgentRoute: vi.fn(),
}));

import { sweepExpiredElevatedBypasses } from "../elevated-session.js";

describe("sweepExpiredElevatedBypasses", () => {
  beforeEach(() => {
    sessionStore.clear();
  });

  it("revierte una sesión con un bypass persistido ya vencido", async () => {
    sessionStore.set("agent:test-agent:xmpp:default:direct:user@example.org", {
      elevatedLevel: "full",
      pluginExtensions: {
        xmpp: {
          elevatedBypass: {
            expiresAtMs: Date.now() - 60_000,
            previousElevatedLevel: "ask",
          },
        },
      },
    });

    const { reverted } = await sweepExpiredElevatedBypasses();

    expect(reverted).toBe(1);
    const entry = sessionStore.get("agent:test-agent:xmpp:default:direct:user@example.org");
    expect(entry?.elevatedLevel).toBe("ask");
    expect(entry?.pluginExtensions?.xmpp?.elevatedBypass).toBeUndefined();
  });

  it("no toca una sesión cuyo bypass persistido todavía no venció", async () => {
    sessionStore.set("agent:test-agent:xmpp:default:direct:user@example.org", {
      elevatedLevel: "full",
      pluginExtensions: {
        xmpp: { elevatedBypass: { expiresAtMs: Date.now() + 60_000, previousElevatedLevel: "ask" } },
      },
    });

    const { reverted } = await sweepExpiredElevatedBypasses();

    expect(reverted).toBe(0);
    const entry = sessionStore.get("agent:test-agent:xmpp:default:direct:user@example.org");
    expect(entry?.elevatedLevel).toBe("full");
    expect(entry?.pluginExtensions?.xmpp?.elevatedBypass).toBeDefined();
  });

  it("no revierte ni lanza cuando ninguna sesión tiene un bypass persistido", async () => {
    sessionStore.set("agent:test-agent:xmpp:default:direct:someone@example.org", { elevatedLevel: "ask" });

    const { reverted } = await sweepExpiredElevatedBypasses();

    expect(reverted).toBe(0);
  });

  it("preserva otras claves de pluginExtensions ajenas al bypass al limpiar", async () => {
    sessionStore.set("agent:test-agent:xmpp:default:direct:user@example.org", {
      elevatedLevel: "full",
      pluginExtensions: {
        xmpp: {
          elevatedBypass: { expiresAtMs: Date.now() - 1000, previousElevatedLevel: null },
          someOtherFeature: { value: "keep-me" },
        },
        otherPlugin: { unrelated: true },
      },
    });

    await sweepExpiredElevatedBypasses();

    const entry = sessionStore.get("agent:test-agent:xmpp:default:direct:user@example.org");
    expect(entry?.pluginExtensions?.xmpp?.someOtherFeature).toEqual({ value: "keep-me" });
    expect(entry?.pluginExtensions?.otherPlugin).toEqual({ unrelated: true });
  });

  it("barre varias sesiones de distintos agentes en una sola pasada", async () => {
    sessionStore.set("agent:agent-a:xmpp:default:direct:a@example.org", {
      elevatedLevel: "full",
      pluginExtensions: { xmpp: { elevatedBypass: { expiresAtMs: Date.now() - 1000, previousElevatedLevel: "ask" } } },
    });
    sessionStore.set("agent:agent-b:xmpp:default:direct:b@example.org", {
      elevatedLevel: "full",
      pluginExtensions: { xmpp: { elevatedBypass: { expiresAtMs: Date.now() - 1000, previousElevatedLevel: "off" } } },
    });

    const { reverted } = await sweepExpiredElevatedBypasses();

    expect(reverted).toBe(2);
    expect(sessionStore.get("agent:agent-a:xmpp:default:direct:a@example.org")?.elevatedLevel).toBe("ask");
    expect(sessionStore.get("agent:agent-b:xmpp:default:direct:b@example.org")?.elevatedLevel).toBe("off");
  });
});
