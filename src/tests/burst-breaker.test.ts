// Tareas 3.3 y 3.5 de xmpp-first-class-channel: burst breaker de salida.
import { describe, expect, it } from "vitest";

import { OutboundBurstBreaker, type ResolvedBurstBreakerLimits } from "../burst-breaker.js";

const limits: ResolvedBurstBreakerLimits = {
  enabled: true,
  maxTurns: 6,
  maxMessages: 3,
  windowMs: 10_000,
  pausedMs: 60_000,
};

describe("OutboundBurstBreaker", () => {
  it("una cadena de fallos auto-sostenida se frena tras el umbral", () => {
    let now = 0;
    const trips: string[] = [];
    const breaker = new OutboundBurstBreaker({
      limits,
      now: () => now,
      onTrip: (destination) => { trips.push(destination); },
    });

    for (let i = 0; i < 3; i++) {
      expect(breaker.allow("dest@example.org", "normal")).toBe(true);
      breaker.record("dest@example.org", "normal", { turn: true });
    }
    expect(breaker.isTripped("dest@example.org")).toBe(true);
    expect(trips).toEqual(["dest@example.org"]);
    expect(breaker.allow("dest@example.org", "normal")).toBe(false);

    // Reanuda cuando expira la pausa.
    now = limits.pausedMs + 1;
    expect(breaker.allow("dest@example.org", "normal")).toBe(true);
  });

  it("el turno final jamás se descarta", () => {
    const breaker = new OutboundBurstBreaker({ limits, now: () => 0 });
    for (let i = 0; i < limits.maxMessages; i++) breaker.record("dest@example.org", "normal");
    expect(breaker.allow("dest@example.org", "normal")).toBe(false);
    expect(breaker.allow("dest@example.org", "final")).toBe(true);
    breaker.record("dest@example.org", "final", { turn: true });
  });

  it("la lane de control/aprobaciones queda exenta", () => {
    const breaker = new OutboundBurstBreaker({ limits, now: () => 0 });
    for (let i = 0; i < limits.maxMessages; i++) breaker.record("dest@example.org", "normal");
    expect(breaker.isTripped("dest@example.org")).toBe(true);
    expect(breaker.allow("dest@example.org", "control")).toBe(true);
    // Ni siquiera cuenta para el umbral.
    breaker.record("dest@example.org", "control");
    expect(breaker.status("dest@example.org").messages).toBe(limits.maxMessages);
  });

  it("está deshabilitado por config sin frenar nada", () => {
    const breaker = new OutboundBurstBreaker({ limits: { ...limits, enabled: false }, now: () => 0 });
    for (let i = 0; i < 50; i++) breaker.record("dest@example.org", "normal");
    expect(breaker.isTripped("dest@example.org")).toBe(false);
    expect(breaker.allow("dest@example.org", "normal")).toBe(true);
  });
});
