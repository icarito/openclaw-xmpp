// Xmpp plugin module implements presence + PEP telemetry publishing, ported
// from src/channels/xmpp.ts's agentState()/publishPresence()/PEP-publish
// logic (NanoClaw).
//
// The READ side reads real session state via `openclaw/plugin-sdk/agent-sessions`
// (getLastAssistantUsage + calculateContextTokens + loadEntriesFromFile), the
// same primitives OpenClaw's own core session engine exports. This was not
// found by an earlier port pass because it isn't a small dedicated
// "telemetry" module -- it's part of the general session-management surface.
// Verified empirically against a live agent's real .jsonl transcript before
// wiring this in (see extensions/xmpp/PORT-NOTES.md "2026-07 telemetry
// read-side" section): entries live flat under
// `<agentDir>/../sessions/*.jsonl` (agentDir itself only holds the auth
// sqlite store), picked by newest mtime. The accountId->agentId mapping
// comes from the top-level `bindings` config array
// (`{type:"route", agentId, match:{channel:"xmpp", accountId}}`), the same
// structure `openclaw agents bindings` reads.
//
// What IS implemented: the PEP publish mechanics (building+sending the
// pubsub IQ, presence caps, and the "did anything actually change?"
// thresholding that keeps this from spamming a stanza every few seconds).
import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";
import crypto from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  calculateContextTokens,
  getLastAssistantUsage,
  loadEntriesFromFile,
} from "openclaw/plugin-sdk/agent-sessions";
import type { ResolvedXmppAccount } from "./accounts.js";
import type { XmppConnection } from "./client.js";
import type { CoreConfig } from "./types.js";
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

/** Rough context-window sizes for the models this deployment actually uses (tokens). Falls back to 128k for anything unrecognized -- only used to compute a percentage, never surfaced as a hard error. */
const CONTEXT_MAX_BY_MODEL: Record<string, number> = {
  "deepseek-v4-pro": 131072,
  "deepseek-v4-flash": 131072,
  "deepseek-chat": 131072,
  "deepseek-reasoner": 131072,
};
const DEFAULT_CONTEXT_MAX = 131072;

/** Finds this account's bound agentId via the top-level `bindings` route array (same structure `openclaw agents bindings` reads). */
function resolveAgentIdForAccount(cfg: CoreConfig, account: ResolvedXmppAccount): string | null {
  const bindings = (cfg as unknown as { bindings?: unknown }).bindings;
  if (!Array.isArray(bindings)) return null;
  for (const b of bindings) {
    if (typeof b !== "object" || b === null) continue;
    const entry = b as { type?: unknown; agentId?: unknown; match?: unknown };
    if (entry.type !== "route" || typeof entry.agentId !== "string") continue;
    const match = entry.match as { channel?: unknown; accountId?: unknown } | undefined;
    if (match?.channel === "xmpp" && match.accountId === account.accountId) {
      return entry.agentId;
    }
  }
  return null;
}

/**
 * Finds this agentId's `agentDir` (auth store path). Sessions live as a
 * sibling `sessions/` dir next to it, not inside it -- verified against a
 * live agent's real files (see module doc above). Agents with an explicit
 * `agentDir` in `agents.list` (e.g. bob) use that; agents without one (e.g.
 * `main`, which has no `agentDir` field in config at all) fall back to the
 * same `<OPENCLAW_STATE_DIR>/agents/<agentId>/agent` default the gateway
 * itself uses -- confirmed by inspecting main's real on-disk layout, which
 * matches bob's shape one level up (agents/<id>/{agent,sessions}/).
 */
function resolveAgentDir(cfg: CoreConfig, agentId: string): string | null {
  const agents = (cfg as unknown as { agents?: { list?: unknown } }).agents;
  const list = agents?.list;
  if (Array.isArray(list)) {
    for (const a of list) {
      if (typeof a !== "object" || a === null) continue;
      const entry = a as { id?: unknown; agentDir?: unknown };
      if (entry.id === agentId && typeof entry.agentDir === "string") {
        return entry.agentDir;
      }
    }
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) return null;
  return join(stateDir, "agents", agentId, "agent");
}

/** Newest-mtime `.jsonl` transcript in a sessions dir, skipping `.trajectory.jsonl` sidecar files. */
function findLatestSessionFile(sessionsDir: string): string | null {
  if (!existsSync(sessionsDir)) return null;
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of readdirSync(sessionsDir)) {
    if (!name.endsWith(".jsonl") || name.endsWith(".trajectory.jsonl")) continue;
    const path = join(sessionsDir, name);
    const mtimeMs = statSync(path).mtimeMs;
    if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
  }
  return best?.path ?? null;
}

/** Reads real telemetry for this account's bound agent from its most recent session transcript. Returns null telemetry (inert) if the account isn't bound to an agent yet, or that agent has no session file -- never fabricates numbers. */
function readAgentTelemetry(cfg: CoreConfig, account: ResolvedXmppAccount): { show: Show; status: string; telemetry: AgentTelemetry | null } {
  const inert = { show: "chat" as Show, status: "OpenClaw connected", telemetry: null };
  const agentId = resolveAgentIdForAccount(cfg, account);
  if (!agentId) return inert;
  const agentDir = resolveAgentDir(cfg, agentId);
  if (!agentDir) return inert;
  const sessionFile = findLatestSessionFile(join(dirname(agentDir), "sessions"));
  if (!sessionFile) return inert;

  let entries: ReturnType<typeof loadEntriesFromFile>;
  try {
    entries = loadEntriesFromFile(sessionFile);
  } catch {
    return inert;
  }
  const usage = getLastAssistantUsage(entries);
  if (!usage) return inert;

  const lastMessageEntry = [...entries].reverse().find(
    (e: unknown) => typeof e === "object" && e !== null && (e as { type?: unknown }).type === "message",
  ) as { message?: { model?: unknown } } | undefined;
  const model = typeof lastMessageEntry?.message?.model === "string" ? lastMessageEntry.message.model : null;

  const contextUsed = calculateContextTokens(usage);
  const contextMax = (model && CONTEXT_MAX_BY_MODEL[model]) || DEFAULT_CONTEXT_MAX;

  return {
    show: "chat",
    status: "OpenClaw connected",
    telemetry: {
      contextUsed,
      contextMax,
      tokens: {
        total: usage.totalTokens ?? 0,
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        requests: 1,
      },
      cost: usage.cost?.total ?? null,
      model,
      tool: null,
    },
  };
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
  cfg: CoreConfig;
  connection: XmppConnection;
  logger?: { info: (m: string) => void; warn?: (m: string) => void; debug?: (m: string) => void };
}): TelemetryLoopHandle {
  const { account, cfg, connection, logger } = params;
  let lastPresence: { show: Show; status: string } | null = null;
  let lastTelemetry: AgentTelemetry | null = null;

  const tick = async (force = false) => {
    if (!connection.isConnected()) return;
    const state = readAgentTelemetry(cfg, account);

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
