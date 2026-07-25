// Tarea 2.9 de xmpp-approval-bypass-and-fallback-cleanup: cubre los
// escenarios de specs/xmpp-approval-bypass/spec.md (activación,
// auto-reversión con timers falseados, desactivación manual, status, clamp
// de máximo, sender no autorizado).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionStore = new Map<string, { execSecurity?: string; execAsk?: string }>();

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: vi.fn(({ sessionKey }: { sessionKey: string }) => sessionStore.get(sessionKey)),
  patchSessionEntry: vi.fn(async ({ sessionKey, update }: { sessionKey: string; update: (e: any) => any }) => {
    const current = sessionStore.get(sessionKey) ?? {};
    const patch = update(current);
    const next = { ...current, ...patch };
    sessionStore.set(sessionKey, next);
    return next;
  }),
}));

let currentSessionKey = "agent:test-agent:xmpp:default:direct:user@example.org";

vi.mock("openclaw/plugin-sdk/routing", () => ({
  resolveAgentRoute: vi.fn(() => ({
    agentId: "test-agent",
    channel: "xmpp",
    accountId: "default",
    sessionKey: currentSessionKey,
    mainSessionKey: "agent:test-agent:main",
    lastRoutePolicy: "session" as const,
    matchedBy: "default" as const,
  })),
}));

import { buildApprovalBypassAction } from "../approval-bypass.js";
import type { ResolvedXmppAccount } from "../accounts.js";
import type { CoreConfig } from "../types.js";

const AUTHORIZED_JID = "user@example.org";

function makeAccount(allowFrom: string[]): ResolvedXmppAccount {
  return { config: { allowFrom } } as unknown as ResolvedXmppAccount;
}

// approval-bypass.ts mantiene su Map `activeBypasses` a nivel de módulo, por
// diseño (estado in-memory, ver header del módulo) -- no está exportado para
// testearse directo. Cada test usa una sessionKey única (vía este contador)
// para no heredar el estado de bypass activado por un test previo, igual que
// en producción dos sesiones reales nunca comparten sessionKey.
let sessionKeyCounter = 0;
function freshSessionKey(): string {
  sessionKeyCounter += 1;
  currentSessionKey = `agent:test-agent:xmpp:default:direct:user-${sessionKeyCounter}@example.org`;
  return currentSessionKey;
}

describe("approval-bypass", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStore.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("activa el bypass y patchea execSecurity/execAsk relajados", async () => {
    const SESSION_KEY = freshSessionKey();
    const action = buildApprovalBypassAction({ account: makeAccount([AUTHORIZED_JID]), cfg: {} as CoreConfig });
    const result = await action.handler({ mode: "on", minutes: "10" }, { fromJid: AUTHORIZED_JID, accountId: "default" });

    expect(String(result)).toContain("activado");
    expect(sessionStore.get(SESSION_KEY)).toMatchObject({ execSecurity: "full", execAsk: "off" });
  });

  it("mode=status reporta activo con tiempo restante mientras el bypass no expiró", async () => {
    freshSessionKey();
    const action = buildApprovalBypassAction({ account: makeAccount([AUTHORIZED_JID]), cfg: {} as CoreConfig });
    await action.handler({ mode: "on", minutes: "10" }, { fromJid: AUTHORIZED_JID, accountId: "default" });

    vi.advanceTimersByTime(60_000);
    const status = await action.handler({ mode: "status" }, { fromJid: AUTHORIZED_JID, accountId: "default" });

    expect(String(status)).toContain("activo");
    expect(String(status)).toMatch(/quedan/);
  });

  it("auto-revierte al vencer la duración, sin necesitar otro comando", async () => {
    const SESSION_KEY = freshSessionKey();
    const action = buildApprovalBypassAction({ account: makeAccount([AUTHORIZED_JID]), cfg: {} as CoreConfig });
    await action.handler({ mode: "on", minutes: "1" }, { fromJid: AUTHORIZED_JID, accountId: "default" });
    expect(sessionStore.get(SESSION_KEY)).toMatchObject({ execSecurity: "full", execAsk: "off" });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(sessionStore.get(SESSION_KEY)?.execSecurity).not.toBe("full");
    const status = await action.handler({ mode: "status" }, { fromJid: AUTHORIZED_JID, accountId: "default" });
    expect(String(status)).toContain("inactivo");
  });

  it("mode=off revierte de inmediato y cancela el timer de auto-reversión", async () => {
    const SESSION_KEY = freshSessionKey();
    const action = buildApprovalBypassAction({ account: makeAccount([AUTHORIZED_JID]), cfg: {} as CoreConfig });
    await action.handler({ mode: "on", minutes: "10" }, { fromJid: AUTHORIZED_JID, accountId: "default" });

    const off = await action.handler({ mode: "off" }, { fromJid: AUTHORIZED_JID, accountId: "default" });
    expect(String(off)).toContain("desactivado");
    expect(sessionStore.get(SESSION_KEY)?.execSecurity).not.toBe("full");

    // Si el timer no se hubiera cancelado, avanzar el reloj lanzaría una
    // segunda reversión sobre un entry ya borrado -- no debe pasar nada.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const status = await action.handler({ mode: "status" }, { fromJid: AUTHORIZED_JID, accountId: "default" });
    expect(String(status)).toContain("inactivo");
  });

  it("clampea minutes por encima del máximo configurado y lo informa", async () => {
    freshSessionKey();
    const action = buildApprovalBypassAction({ account: makeAccount([AUTHORIZED_JID]), cfg: {} as CoreConfig });
    const result = await action.handler({ mode: "on", minutes: "999" }, { fromJid: AUTHORIZED_JID, accountId: "default" });

    expect(String(result)).toMatch(/ajustado al maximo/);
    expect(String(result)).toContain("60");
  });

  it("rechaza mode=on de un sender fuera de allowFrom, sin mutar la sesión", async () => {
    const SESSION_KEY = freshSessionKey();
    const action = buildApprovalBypassAction({ account: makeAccount(["otro@example.org"]), cfg: {} as CoreConfig });

    await expect(
      action.handler({ mode: "on", minutes: "10" }, { fromJid: AUTHORIZED_JID, accountId: "default" }),
    ).rejects.toThrow("not-authorized");
    expect(sessionStore.has(SESSION_KEY)).toBe(false);
  });

  it("mode=status no requiere autorización -- cualquier sender puede consultar", async () => {
    freshSessionKey();
    const action = buildApprovalBypassAction({ account: makeAccount(["otro@example.org"]), cfg: {} as CoreConfig });
    const status = await action.handler({ mode: "status" }, { fromJid: AUTHORIZED_JID, accountId: "default" });

    expect(String(status)).toContain("inactivo");
  });
});
