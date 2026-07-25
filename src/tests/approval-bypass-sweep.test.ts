// Fase 2 (xmpp-approval-unified-contract), tarea 3: sweepExpiredApprovalBypasses
// -- fail-closed en vez de fail-open cuando el gateway reinicia con un bypass
// activo. Archivo separado de approval-bypass.test.ts porque necesita
// controlar directamente lo que devuelve listSessionEntries (entradas
// "persistidas" preexistentes), no solo lo que este módulo escribe durante el
// propio test.
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockEntry = {
  execSecurity?: string;
  execAsk?: string;
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

import { sweepExpiredApprovalBypasses } from "../approval-bypass.js";

describe("sweepExpiredApprovalBypasses", () => {
  beforeEach(() => {
    sessionStore.clear();
  });

  it("revierte una sesión con un bypass persistido ya vencido", async () => {
    sessionStore.set("agent:test-agent:xmpp:default:direct:user@example.org", {
      execSecurity: "full",
      execAsk: "off",
      pluginExtensions: {
        xmpp: {
          approvalBypass: {
            expiresAtMs: Date.now() - 60_000,
            previousExecSecurity: "allowlist",
            previousExecAsk: "on-miss",
          },
        },
      },
    });

    const { reverted } = await sweepExpiredApprovalBypasses();

    expect(reverted).toBe(1);
    const entry = sessionStore.get("agent:test-agent:xmpp:default:direct:user@example.org");
    expect(entry?.execSecurity).toBe("allowlist");
    expect(entry?.execAsk).toBe("on-miss");
    expect(entry?.pluginExtensions?.xmpp?.approvalBypass).toBeUndefined();
  });

  it("no toca una sesión cuyo bypass persistido todavía no venció", async () => {
    sessionStore.set("agent:test-agent:xmpp:default:direct:user@example.org", {
      execSecurity: "full",
      execAsk: "off",
      pluginExtensions: {
        xmpp: { approvalBypass: { expiresAtMs: Date.now() + 60_000, previousExecSecurity: "allowlist", previousExecAsk: "on-miss" } },
      },
    });

    const { reverted } = await sweepExpiredApprovalBypasses();

    expect(reverted).toBe(0);
    const entry = sessionStore.get("agent:test-agent:xmpp:default:direct:user@example.org");
    expect(entry?.execSecurity).toBe("full");
    expect(entry?.pluginExtensions?.xmpp?.approvalBypass).toBeDefined();
  });

  it("no revierte ni lanza cuando ninguna sesión tiene un bypass persistido", async () => {
    sessionStore.set("agent:test-agent:xmpp:default:direct:someone@example.org", { execSecurity: "ask" });

    const { reverted } = await sweepExpiredApprovalBypasses();

    expect(reverted).toBe(0);
  });

  it("preserva otras claves de pluginExtensions ajenas al bypass al limpiar", async () => {
    sessionStore.set("agent:test-agent:xmpp:default:direct:user@example.org", {
      execSecurity: "full",
      execAsk: "off",
      pluginExtensions: {
        xmpp: {
          approvalBypass: { expiresAtMs: Date.now() - 1000, previousExecSecurity: null, previousExecAsk: null },
          someOtherFeature: { value: "keep-me" },
        },
        otherPlugin: { unrelated: true },
      },
    });

    await sweepExpiredApprovalBypasses();

    const entry = sessionStore.get("agent:test-agent:xmpp:default:direct:user@example.org");
    expect(entry?.pluginExtensions?.xmpp?.someOtherFeature).toEqual({ value: "keep-me" });
    expect(entry?.pluginExtensions?.otherPlugin).toEqual({ unrelated: true });
  });

  it("barre varias sesiones de distintos agentes en una sola pasada", async () => {
    sessionStore.set("agent:agent-a:xmpp:default:direct:a@example.org", {
      execSecurity: "full",
      pluginExtensions: { xmpp: { approvalBypass: { expiresAtMs: Date.now() - 1000, previousExecSecurity: "ask", previousExecAsk: null } } },
    });
    sessionStore.set("agent:agent-b:xmpp:default:direct:b@example.org", {
      execSecurity: "full",
      pluginExtensions: { xmpp: { approvalBypass: { expiresAtMs: Date.now() - 1000, previousExecSecurity: "deny", previousExecAsk: null } } },
    });

    const { reverted } = await sweepExpiredApprovalBypasses();

    expect(reverted).toBe(2);
    expect(sessionStore.get("agent:agent-a:xmpp:default:direct:a@example.org")?.execSecurity).toBe("ask");
    expect(sessionStore.get("agent:agent-b:xmpp:default:direct:b@example.org")?.execSecurity).toBe("deny");
  });
});
