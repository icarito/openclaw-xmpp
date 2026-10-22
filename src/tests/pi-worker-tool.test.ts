import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { registerPiWorkerTool } from "../pi-worker-tool.js";

const state = vi.hoisted(() => ({ requests: [] as string[], syncError: false, syncArgs: [] as string[] }));

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_file: string, args: string[], _options: unknown, callback: (error: Error | null) => void) => {
    state.syncArgs = args;
    callback(state.syncError ? new Error("private sync detail") : null);
  }),
}));

vi.mock("node:net", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    createConnection: vi.fn(() => {
      const socket = new EventEmitter() as EventEmitter & {
        setTimeout: () => void;
        write: (payload: string) => void;
        destroy: () => void;
      };
      socket.setTimeout = () => {};
      socket.destroy = () => {};
      socket.write = (payload) => {
        state.requests.push(payload);
        queueMicrotask(() => socket.emit("data", Buffer.from('{"ok":true}\n')));
      };
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    }),
  };
});

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
  beforeEach(() => {
    state.requests = [];
    state.syncArgs = [];
    state.syncError = false;
  });

  it("does not treat a MUC nickname as the sender JID", async () => {
    const tool = toolFor(context("sebastian@hablar.fuentelibre.org"));
    expect(tool).not.toBeNull();
    const result = await tool!.execute("call-1", {
      action: "start",
      project: "claudio-w",
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
      project: "claudio-w",
      room_jid: "other@conference.hablar.fuentelibre.org",
      spec: "Revisar un proyecto",
      authorized_jids: ["sebastian@hablar.fuentelibre.org"],
    });
    expect(result.content[0].text).toContain("MUC XMPP de este turno");
  });

  it("is absent outside the Operator XMPP account", () => {
    expect(toolFor({ ...context("Sebastian <sebastian@hablar.fuentelibre.org>"), agentId: "other" })).toBeNull();
  });

  it("requires an explicit project for every action", async () => {
    const tool = toolFor(context("Sebastian <sebastian@hablar.fuentelibre.org>"));
    const result = await tool!.execute("call-3", { action: "status" });
    expect(result.content[0].text).toContain("identificador de proyecto válido");
    expect(state.requests).toHaveLength(0);
  });

  it("synchronizes the selected clone before sending a start request", async () => {
    const tool = toolFor(context("Sebastian <sebastian@hablar.fuentelibre.org>"));
    const result = await tool!.execute("call-4", {
      action: "start",
      project: "fleet-ops",
      room_jid: "puente@conference.hablar.fuentelibre.org",
      spec: "Revisar el proyecto",
      authorized_jids: ["sebastian@hablar.fuentelibre.org"],
    });
    expect(result.content[0].text).toContain('"ok":true');
    expect(state.syncArgs).toEqual(["/opt/claudio-w/openclaw-server/scripts/pi-worker/pi-source-sync", "fleet-ops"]);
    expect(JSON.parse(state.requests[0])).toMatchObject({ action: "start", project: "fleet-ops" });
  });

  it("fails closed when clone synchronization fails", async () => {
    state.syncError = true;
    const tool = toolFor(context("Sebastian <sebastian@hablar.fuentelibre.org>"));
    const result = await tool!.execute("call-5", {
      action: "start",
      project: "fleet-ops",
      room_jid: "puente@conference.hablar.fuentelibre.org",
      spec: "private spec",
      authorized_jids: ["sebastian@hablar.fuentelibre.org"],
    });
    expect(result.content[0].text).toContain("No se pudo sincronizar");
    expect(result.content[0].text).not.toContain("private");
    expect(state.requests).toHaveLength(0);
  });
});
