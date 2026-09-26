// Tareas 7.1/7.2/7.6 de xmpp-first-class-channel: eventos PEP versionados.
import { describe, expect, it } from "vitest";
import type { Element } from "@xmpp/xml";

import {
  HOOKS_ACTIVITY_NODE,
  HOOKS_APPROVAL_NODE,
  HOOKS_CONTRACT_VERSION,
  HOOKS_PROGRESS_NODE,
  buildActivityHookPayload,
  buildApprovalHookPayload,
  buildHookEventElement,
  buildProgressHookPayload,
} from "../hooks/pep-events.js";

function payloadOf(element: Element): Record<string, unknown> {
  return JSON.parse(element.text()) as Record<string, unknown>;
}

describe("PEP hooks payloads", () => {
  it("envuelve el JSON en el namespace versionado", () => {
    const element = buildHookEventElement(HOOKS_ACTIVITY_NODE, { hello: "world" });
    expect(element.name).toBe("event");
    expect(element.attrs.xmlns).toBe(HOOKS_ACTIVITY_NODE);
    expect(element.attrs.version).toBe(String(HOOKS_CONTRACT_VERSION));
    expect(payloadOf(element)).toEqual({ hello: "world" });
  });

  it("activity incluye sessionKey, estado, JID y timestamp", () => {
    const now = Date.parse("2026-09-26T12:00:00Z");
    const payload = buildActivityHookPayload({
      state: "busy",
      sessionKey: "agent:clawdio:xmpp:peer@example.org",
      originJid: "peer@example.org",
      target: "peer@example.org",
      now,
    });
    expect(payload.event).toBe("activity");
    expect(payload.state).toBe("busy");
    expect(payload.contractVersion).toBe(HOOKS_CONTRACT_VERSION);
    expect(payload.sessionKey).toBe("agent:clawdio:xmpp:peer@example.org");
    expect(payload.originJid).toBe("peer@example.org");
    expect(payload.timestamp).toBe("2026-09-26T12:00:00.000Z");
    const element = buildHookEventElement(HOOKS_ACTIVITY_NODE, payload);
    expect((payloadOf(element) as { state: string }).state).toBe("busy");
  });

  it("activity propaga pendingCount cuando existe", () => {
    const payload = buildActivityHookPayload({ state: "pending", pendingCount: 3 });
    expect(payload.pendingCount).toBe(3);
    expect(payload.sessionKey).toBeNull();
  });

  it("approval incluye id, estado y expiración", () => {
    const payload = buildApprovalHookPayload({
      state: "pending",
      approvalId: "appr-1",
      stanzaId: "oc-1",
      jid: "peer@example.org",
      sessionKey: "agent:clawdio:xmpp:peer@example.org",
      expiresAtMs: 1234,
    });
    expect(payload.event).toBe("approval");
    expect(payload.state).toBe("pending");
    expect(payload.approvalId).toBe("appr-1");
    expect(payload.stanzaId).toBe("oc-1");
    expect(payload.expiresAtMs).toBe(1234);
    expect(payload.contractVersion).toBe(HOOKS_CONTRACT_VERSION);

    const resolved = buildApprovalHookPayload({
      state: "resolved",
      approvalId: "appr-1",
      decision: "allow",
    });
    expect(resolved.decision).toBe("allow");
  });

  it("progress distingue inicio y fin de turno", () => {
    const start = buildProgressHookPayload({ state: "start", sessionKey: "s1", target: "peer@example.org" });
    const end = buildProgressHookPayload({ state: "end", sessionKey: "s1", detail: "completed" });
    expect(start.event).toBe("progress");
    expect(start.state).toBe("start");
    expect(end.state).toBe("end");
    expect(end.detail).toBe("completed");
    expect(buildHookEventElement(HOOKS_PROGRESS_NODE, end).attrs.xmlns).toBe(HOOKS_PROGRESS_NODE);
  });
});
