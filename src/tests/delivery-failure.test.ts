// Tarea 3.4 de xmpp-first-class-channel: clasificación de fallos de entrega.
import { describe, expect, it } from "vitest";

import { classifyDeliveryError, computeBackoffMs } from "../delivery-failure.js";

describe("classifyDeliveryError", () => {
  it("un error de red transitorio es retryable", () => {
    const result = classifyDeliveryError(new Error("connect ECONNRESET 127.0.0.1:5222"));
    expect(result.errorClass).toBe("retryable");
    expect(result.retryable).toBe(true);
    expect(result.deadLetter).toBe(false);
  });

  it("un JID inválido es fatal y va a dead-letter", () => {
    const result = classifyDeliveryError(new Error("Invalid XMPP target: not-a-jid"));
    expect(result.errorClass).toBe("fatal");
    expect(result.deadLetter).toBe(true);
  });

  it("un duplicate-commit es fatal (dead-letter), nunca reintento", () => {
    const result = classifyDeliveryError(new Error("duplicate-commit: turn already committed"));
    expect(result.errorClass).toBe("duplicate");
    expect(result.retryable).toBe(false);
    expect(result.deadLetter).toBe(true);
  });

  it("respeta una clasificación explícita del caller", () => {
    const error = Object.assign(new Error("boom"), { deliveryClass: "fatal" as const });
    expect(classifyDeliveryError(error).errorClass).toBe("fatal");
  });
});

describe("computeBackoffMs", () => {
  it("crece exponencialmente y se corta en el tope", () => {
    expect(computeBackoffMs(1, 1000, 10_000)).toBe(1000);
    expect(computeBackoffMs(2, 1000, 10_000)).toBe(2000);
    expect(computeBackoffMs(3, 1000, 10_000)).toBe(4000);
    expect(computeBackoffMs(9, 1000, 10_000)).toBe(10_000);
  });
});
