// Una aprobación en sala MUC salía dos veces: el prompt local del core
// (payload con channelData.execApproval vía message adapter) y la card del
// handler nativo. El adapter descarta el prompt cuando el handler está activo.
import { describe, expect, it } from "vitest";

import { isNativelyHandledApprovalPrompt } from "../message-adapter.js";
import type { CoreConfig } from "../types.js";

function cfg(inlineButtons: string): CoreConfig {
  return {
    channels: {
      xmpp: {
        capabilities: { inlineButtons },
        accounts: {
          xispa: {
            jid: "xispa@example.org",
            password: "x",
            allowFrom: ["sebastian@example.org"],
          },
        },
      },
    },
  } as unknown as CoreConfig;
}

const approvalPayload = {
  text: "Approval required",
  channelData: { execApproval: { approvalId: "apr-1", approvalSlug: "apr-1" } },
};

describe("isNativelyHandledApprovalPrompt", () => {
  it("descarta el prompt local si el handler nativo entrega la card", () => {
    expect(isNativelyHandledApprovalPrompt({ cfg: cfg("all"), accountId: "xispa", payload: approvalPayload })).toBe(true);
  });

  it("conserva el prompt si los botones están apagados (sin handler nativo)", () => {
    expect(isNativelyHandledApprovalPrompt({ cfg: cfg("off"), accountId: "xispa", payload: approvalPayload })).toBe(false);
  });

  it("no toca payloads que no son aprobaciones", () => {
    expect(isNativelyHandledApprovalPrompt({ cfg: cfg("all"), accountId: "xispa", payload: { channelData: { xmpp: {} } } })).toBe(false);
    expect(isNativelyHandledApprovalPrompt({ cfg: cfg("all"), accountId: "xispa", payload: null })).toBe(false);
  });
});
