import { describe, expect, it } from "vitest";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { registerPiWorkerTool } from "../pi-worker-tool.js";

type ToolFactory = (ctx: OpenClawPluginToolContext) => {
  execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
} | null;

function toolFor(ctx: OpenClawPluginToolContext) {
  let factory: ToolFactory | undefined;
  const api = {
    registerTool(candidate: unknown) {
      factory = candidate as ToolFactory;
    },
  } as unknown as OpenClawPluginApi;
  registerPiWorkerTool(api);
  return factory?.(ctx);
}

function context(requesterSenderId: string): OpenClawPluginToolContext {
  return {
    agentId: "operator",
    messageChannel: "xmpp",
    agentAccountId: "operator",
    requesterSenderId,
    deliveryContext: {
      channel: "xmpp",
      accountId: "operator",
      to: "channel:puente@conference.hablar.fuentelibre.org",
    },
  } as OpenClawPluginToolContext;
}

describe("pi_worker trust boundary", () => {
  it("does not treat a MUC nickname as the sender JID", async () => {
    const tool = toolFor(context("sebastian@hablar.fuentelibre.org"));
    expect(tool).not.toBeNull();
    const result = await tool!.execute("call-1", {
      action: "start",
      room_jid: "puente@conference.hablar.fuentelibre.org",
      spec: "Revisar un proyecto",
      authorized_jids: ["sebastian@hablar.fuentelibre.org"],
    });
    expect(result.content[0].text).toContain("Solo el propietario");
  });

  it("requires the start room to be the current MUC", async () => {
    const tool = toolFor(context("Sebastian <sebastian@hablar.fuentelibre.org/resource>"));
    expect(tool).not.toBeNull();
    const result = await tool!.execute("call-2", {
      action: "start",
      room_jid: "other@conference.hablar.fuentelibre.org",
      spec: "Revisar un proyecto",
      authorized_jids: ["sebastian@hablar.fuentelibre.org"],
    });
    expect(result.content[0].text).toContain("MUC XMPP de este turno");
  });

  it("is absent outside the Operator XMPP account", () => {
    expect(toolFor({ ...context("Sebastian <sebastian@hablar.fuentelibre.org>"), agentId: "other" })).toBeNull();
  });
});
