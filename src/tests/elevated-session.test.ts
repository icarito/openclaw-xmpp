// Cubre los escenarios de specs/xmpp-elevated-session/spec.md (activación,
// auto-reversión con timers falseados, desactivación manual, status, clamp
// de máximo, sender no autorizado, preservación de elevatedLevel previo no
// default). Reemplaza approval-bypass.test.ts tras la consolidación de
// xmpp-elevated-session-command: mismos escenarios, ahora sobre
// elevatedLevel en vez de execSecurity/execAsk.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionStore = new Map<string, { elevatedLevel?: string }>();

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: vi.fn(({ sessionKey }: { sessionKey: string }) => sessionStore.get(sessionKey)),
  patchSessionEntry: vi.fn(async ({ sessionKey, update }: { sessionKey: string; update: (e: any) => any }) => {
    const current = sessionStore.get(sessionKey) ?? {};
    const patch = update(current);
    const next = { ...current, ...patch };
    sessionStore.set(sessionKey, next);
    return next;
  }),
  // Importado por elevated-session.ts (para el barrido al arranque) pero no
  // ejercitado por estos tests -- ver src/tests/elevated-session-sweep.test.ts.
  listSessionEntries: vi.fn(() => []),
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

import { buildElevatedSessionAction } from "../elevated-session.js";
import type { ResolvedXmppAccount } from "../accounts.js";
import type { CoreConfig } from "../types.js";

const AUTHORIZED_JID = "user@example.org";

function makeAccount(allowFrom: string[]): ResolvedXmppAccount {
  return { config: { allowFrom } } as unknown as ResolvedXmppAccount;
}

// mode=status devuelve {text, fields}; mode=on/off siguen devolviendo string
// plano. Este helper lee el texto legible sin importar cuál shape haya
// devuelto el handler -- equivalente al normalizeActionResult() que usa
// xep-0050.ts en producción.
function resultText(result: Awaited<ReturnType<ReturnType<typeof buildElevatedSessionAction>["handler"]>>): string {
  return typeof result === "string" ? result : result.text;
}

function resultField(
  result: Awaited<ReturnType<ReturnType<typeof buildElevatedSessionAction>["handler"]>>,
  name: string,
): string | undefined {
  if (typeof result === "string") return undefined;
  return result.fields?.find((f) => f.var === name)?.value;
}

// elevated-session.ts mantiene su Map `activeBypasses` a nivel de módulo, por
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

describe("elevated-session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStore.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("activa el bypass y patchea elevatedLevel a full", async () => {
    const SESSION_KEY = freshSessionKey();
    const action = buildElevatedSessionAction({ account: makeAccount([AUTHORIZED_JID]), cfg: {} as CoreConfig });
    const result = await action.handler({ mode: "on", minutes: "10" }, { fromJid: AUTHORIZED_JID, accountId: "default" });

    expect(String(result)).toContain("activado");
    expect(sessionStore.get(SESSION_KEY)).toMatchObject({ elevatedLevel: "full" });
  });

  it("mode=status reporta activo con tiempo restante mientras el bypass no expiró", async () => {
    freshSessionKey();
    const action = buildElevatedSessionAction({ account: makeAccount([AUTHORIZED_JID]), cfg: {} as CoreConfig });
    await action.handler({ mode: "on", minutes: "10" }, { fromJid: AUTHORIZED_JID, accountId: "default" });

    vi.advanceTimersByTime(60_000);
    const status = await action.handler({ mode: "status" }, { fromJid: AUTHORIZED_JID, accountId: "default" });

    expect(resultText(status)).toContain("activo");
    expect(resultText(status)).toMatch(/quedan/);
    expect(resultField(status, "active")).toBe("true");
    expect(Number(resultField(status, "remaining-seconds"))).toBeGreaterThan(0);
  });

  it("auto-revierte al vencer la duración, sin necesitar otro comando", async () => {
    const SESSION_KEY = freshSessionKey();
    const action = buildElevatedSessionAction({ account: makeAccount([AUTHORIZED_JID]), cfg: {} as CoreConfig });
    await action.handler({ mode: "on", minutes: "1" }, { fromJid: AUTHORIZED_JID, accountId: "default" });
    expect(sessionStore.get(SESSION_KEY)).toMatchObject({ elevatedLevel: "full" });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(sessionStore.get(SESSION_KEY)?.elevatedLevel).not.toBe("full");
    const status = await action.handler({ mode: "status" }, { fromJid: AUTHORIZED_JID, accountId: "default" });
    expect(resultText(status)).toContain("inactivo");
    expect(resultField(status, "active")).toBe("false");
  });

  it("mode=off revierte de inmediato y cancela el timer de auto-reversión", async () => {
    const SESSION_KEY = freshSessionKey();
    const action = buildElevatedSessionAction({ account: makeAccount([AUTHORIZED_JID]), cfg: {} as CoreConfig });
    await action.handler({ mode: "on", minutes: "10" }, { fromJid: AUTHORIZED_JID, accountId: "default" });

    const off = await action.handler({ mode: "off" }, { fromJid: AUTHORIZED_JID, accountId: "default" });
    expect(String(off)).toContain("desactivado");
    expect(sessionStore.get(SESSION_KEY)?.elevatedLevel).not.toBe("full");

    // Si el timer no se hubiera cancelado, avanzar el reloj lanzaría una
    // segunda reversión sobre un entry ya borrado -- no debe pasar nada.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const status = await action.handler({ mode: "status" }, { fromJid: AUTHORIZED_JID, accountId: "default" });
    expect(resultText(status)).toContain("inactivo");
  });

  it("clampea minutes por encima del máximo configurado y lo informa", async () => {
    freshSessionKey();
    const action = buildElevatedSessionAction({ account: makeAccount([AUTHORIZED_JID]), cfg: {} as CoreConfig });
    const result = await action.handler({ mode: "on", minutes: "999" }, { fromJid: AUTHORIZED_JID, accountId: "default" });

    expect(String(result)).toMatch(/ajustado al maximo/);
    expect(String(result)).toContain("60");
  });

  it("rechaza mode=on de un sender fuera de allowFrom, sin mutar la sesión", async () => {
    const SESSION_KEY = freshSessionKey();
    const action = buildElevatedSessionAction({ account: makeAccount(["otro@example.org"]), cfg: {} as CoreConfig });

    await expect(
      action.handler({ mode: "on", minutes: "10" }, { fromJid: AUTHORIZED_JID, accountId: "default" }),
    ).rejects.toThrow("not-authorized");
    expect(sessionStore.has(SESSION_KEY)).toBe(false);
  });

  it("mode=status no requiere autorización -- cualquier sender puede consultar", async () => {
    freshSessionKey();
    const action = buildElevatedSessionAction({ account: makeAccount(["otro@example.org"]), cfg: {} as CoreConfig });
    const status = await action.handler({ mode: "status" }, { fromJid: AUTHORIZED_JID, accountId: "default" });

    expect(resultText(status)).toContain("inactivo");
  });

  // Tarea 3.3 / design.md D3: una sesión con elevatedLevel no-default
  // (p.ej. "ask") seteado por alguna otra vía antes de activar el bypass
  // debe recuperar ese valor exacto al terminar, no "off" ni undefined --
  // approval-bypass.ts no tenía este caso porque restauraba dos campos
  // independientes que rara vez tenían un valor previo real fuera de un
  // bypass ya en curso.
  it("preserva un elevatedLevel previo no-default al revertir", async () => {
    const SESSION_KEY = freshSessionKey();
    sessionStore.set(SESSION_KEY, { elevatedLevel: "ask" });

    const action = buildElevatedSessionAction({ account: makeAccount([AUTHORIZED_JID]), cfg: {} as CoreConfig });
    await action.handler({ mode: "on", minutes: "1" }, { fromJid: AUTHORIZED_JID, accountId: "default" });
    expect(sessionStore.get(SESSION_KEY)).toMatchObject({ elevatedLevel: "full" });

    const off = await action.handler({ mode: "off" }, { fromJid: AUTHORIZED_JID, accountId: "default" });
    expect(String(off)).toContain("desactivado");
    expect(sessionStore.get(SESSION_KEY)?.elevatedLevel).toBe("ask");
  });
});
