// Tarea 7.3/7.6 de xmpp-first-class-channel: read-side de telemetría real.
import { describe, expect, it } from "vitest";

import { formatCreditReport, type AgentTelemetry } from "../telemetry.js";

function telemetry(overrides: Partial<AgentTelemetry> = {}): AgentTelemetry {
  return {
    contextUsed: 1_000,
    contextMax: 2_000,
    contextMaxSource: "config",
    tokens: { total: 5_000, input: 4_000, output: 1_000, requests: 3 },
    cost: 0.01,
    sessionCost: 0.03,
    dayCost: 0.05,
    model: "deepseek-v4-flash",
    tool: null,
    activity: "available",
    availability: "available",
    sessionStatus: null,
    ...overrides,
  };
}

describe("telemetría legible (node credit)", () => {
  it("reporta consumo y coste reales de la sesión", () => {
    const report = formatCreditReport(telemetry());
    expect(report).toContain("Memoria activa:");
    expect(report).toContain("(50%)");
    expect(report).toContain("Consumo de esta sesión:");
    expect(report).toContain("3 peticiones");
    expect(report).toContain("Coste de esta sesión: US$ 0.0300");
    expect(report).toContain("Coste local de hoy: US$ 0.0500");
  });

  it("no inventa datos cuando no hay sesión", () => {
    expect(formatCreditReport(null)).toContain("Aún no hay telemetría");
  });
});
