// Xmpp plugin module implements presence + PEP telemetry publishing, ported
// from src/channels/xmpp.ts's agentState()/publishPresence()/PEP-publish
// logic (NanoClaw).
//
// TODO(xmpp-migration): the READ side of this is stubbed. NanoClaw's
// agentState()/readAgentTelemetry() read directly from opencode.db (a
// per-session SQLite file NanoClaw's own container-runner produced) via
// src/agent-telemetry.ts. OpenClaw is a single gateway process with its own
// internal agent/session/token accounting; this plugin has NOT found a
// documented `api.runtime.agent.session.*` (or similar) primitive in the
// IRC/Matrix reference plugins that would let a channel plugin read a
// running agent's current context usage, token totals, or "what tool is it
// running right now" -- IRC and Matrix don't attempt anything like this at
// all (no channel-native presence/telemetry surface in either).
//
// What IS implemented: the PEP publish mechanics (building+sending the
// pubsub IQ, presence caps, and the "did anything actually change?"
// thresholding that keeps this from spamming a stanza every few seconds).
// The publish loop below calls readTelemetryStub(), which always returns
// null (no session) until a real read path is wired in -- so this ships
// inert rather than fabricating numbers.
import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";
import crypto from "node:crypto";
import type { ResolvedXmppAccount } from "./accounts.js";
import type { XmppConnection } from "./client.js";
import { CAPS_FEATURES, CAPS_IDENTITY, CAPS_NODE } from "./xep-0050.js";

/** PEP node carrying agent telemetry (renamed from NanoClaw's urn:nanoclaw:telemetry:0). */
const TELEMETRY_NODE = "urn:openclaw:telemetry:0";
const PRESENCE_INTERVAL_MS = 10_000;
const TELEMETRY_CONTEXT_DELTA = 500; // tokens -- below this the gauge cannot visibly move

export interface AgentTelemetry {
  contextUsed: number | null;
  contextMax: number;
  tokens: { total: number; input: number; output: number; requests: number } | null;
  cost: number | null;
  model: string | null;
  tool: string | null;
}

type Show = "away" | "chat" | "dnd" | "xa";

function capsVerHash(): string {
  const identityStr = `${CAPS_IDENTITY.category}/${CAPS_IDENTITY.type}//${CAPS_IDENTITY.name}<`;
  const featuresStr = CAPS_FEATURES.map((f) => `${f}<`).join("");
  return crypto.createHash("sha1").update(identityStr + featuresStr, "utf8").digest("base64");
}

function buildCapsPresence(show?: Show, status?: string): Element {
  const ver = capsVerHash();
  return xml(
    "presence",
    {},
    ...(show ? [xml("show", {}, show)] : []),
    ...(status ? [xml("status", {}, status)] : []),
    xml("c", { xmlns: "http://jabber.org/protocol/caps", hash: "sha-1", node: CAPS_NODE, ver }),
  );
}

function buildTelemetryItem(t: AgentTelemetry): Element {
  const children: Element[] = [];
  if (t.contextUsed !== null) {
    children.push(xml("context", { used: String(t.contextUsed), max: String(t.contextMax) }));
  }
  if (t.tokens) {
    children.push(
      xml("tokens", {
        total: String(t.tokens.total),
        input: String(t.tokens.input),
        output: String(t.tokens.output),
        requests: String(t.tokens.requests),
      }),
    );
  }
  if (t.cost !== null) children.push(xml("cost", { usd: t.cost.toFixed(4) }));
  if (t.model) children.push(xml("model", {}, t.model));
  if (t.tool) children.push(xml("tool", {}, t.tool));
  return xml("telemetry", { xmlns: TELEMETRY_NODE }, ...children);
}

function buildTelemetryPublish(t: AgentTelemetry): Element {
  return xml(
    "iq",
    { type: "set", id: `tel-${Date.now().toString(36)}` },
    xml(
      "pubsub",
      { xmlns: "http://jabber.org/protocol/pubsub" },
      xml("publish", { node: TELEMETRY_NODE }, xml("item", { id: "current" }, buildTelemetryItem(t))),
      xml(
        "publish-options",
        {},
        xml(
          "x",
          { xmlns: "jabber:x:data", type: "submit" },
          xml("field", { var: "FORM_TYPE", type: "hidden" }, xml("value", {}, "http://jabber.org/protocol/pubsub#publish-options")),
          xml("field", { var: "pubsub#persist_items" }, xml("value", {}, "true")),
          xml("field", { var: "pubsub#max_items" }, xml("value", {}, "1")),
          xml("field", { var: "pubsub#access_model" }, xml("value", {}, "presence")),
        ),
      ),
    ),
  );
}

function telemetryChanged(prev: AgentTelemetry | null, next: AgentTelemetry): boolean {
  if (!prev) return true;
  if (prev.model !== next.model || prev.tool !== next.tool) return true;
  if (prev.contextMax !== next.contextMax) return true;
  const before = prev.contextUsed ?? -1;
  const after = next.contextUsed ?? -1;
  return Math.abs(after - before) >= TELEMETRY_CONTEXT_DELTA;
}

/**
 * TODO(xmpp-migration): replace with a real read once an OpenClaw-native
 * agent/session telemetry API is confirmed. Always inert (null) for now.
 */
function readTelemetryStub(_account: ResolvedXmppAccount): { show: Show; status: string; telemetry: AgentTelemetry | null } {
  return { show: "chat", status: "OpenClaw connected", telemetry: null };
}

export type TelemetryLoopHandle = { stop: () => void };

/**
 * Start the periodic presence+PEP publish loop for one connection. Mirrors
 * xmpp.ts's publishPresence()/PRESENCE_INTERVAL_MS wiring: caps presence
 * updates only when show/status actually changed; telemetry PEP publish
 * only when the numbers moved by a visible amount.
 */
export function startTelemetryLoop(params: {
  account: ResolvedXmppAccount;
  connection: XmppConnection;
  logger?: { info: (m: string) => void; warn?: (m: string) => void; debug?: (m: string) => void };
}): TelemetryLoopHandle {
  const { account, connection, logger } = params;
  let lastPresence: { show: Show; status: string } | null = null;
  let lastTelemetry: AgentTelemetry | null = null;

  const tick = async (force = false) => {
    if (!connection.isConnected()) return;
    const state = readTelemetryStub(account);

    if (force || lastPresence?.show !== state.show || lastPresence.status !== state.status) {
      await connection.send(buildCapsPresence(state.show, state.status)).catch((err) =>
        logger?.warn?.(`XMPP presence publish failed: ${String(err)}`),
      );
      lastPresence = { show: state.show, status: state.status };
    }

    if (state.telemetry && (force || telemetryChanged(lastTelemetry, state.telemetry))) {
      await connection.send(buildTelemetryPublish(state.telemetry)).catch((err) =>
        logger?.warn?.(`XMPP telemetry publish failed: ${String(err)}`),
      );
      lastTelemetry = state.telemetry;
    }
  };

  void tick(true);
  const timer = setInterval(() => void tick(), PRESENCE_INTERVAL_MS);

  return {
    stop: () => clearInterval(timer),
  };
}
