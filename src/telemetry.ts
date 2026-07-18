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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  calculateContextTokens,
  getLastAssistantUsage,
  loadEntriesFromFile,
} from "openclaw/plugin-sdk/agent-sessions";
import type { ResolvedXmppAccount } from "./accounts.js";
import type { XmppConnection } from "./client.js";
import { normalizeXmppMessagingTarget } from "./normalize.js";
import type { CoreConfig } from "./types.js";
import { CAPS_FEATURES, CAPS_IDENTITY, CAPS_NODE } from "./xep-0050.js";
import { getXmppAccountActivity } from "./activity-registry.js";
import { buildVCardUpdateElement, getPublishedAvatarHash } from "./avatar.js";

/** PEP node carrying agent telemetry. */
const TELEMETRY_NODE = "urn:openclaw:telemetry:0";
const PRESENCE_INTERVAL_MS = 10_000;
const TELEMETRY_CONTEXT_DELTA = 500; // tokens -- below this the gauge cannot visibly move
const RECENT_TOOL_TTL_MS = 90_000;

export interface AgentTelemetry {
  contextUsed: number | null;
  contextMax: number;
  contextMaxSource: "config" | "model-table" | "fallback";
  tokens: { total: number; input: number; output: number; requests: number } | null;
  cost: number | null;
  sessionCost: number | null;
  dayCost: number | null;
  model: string | null;
  tool: string | null;
  activity: "available" | "busy" | "paused" | "pending";
  availability: "available" | "busy" | "away";
  /** Sólo con activity="pending": mensajes en cola sin procesar aún. */
  pendingCount?: number;
  sessionStatus: string | null;
}

type Show = "away" | "chat" | "dnd" | "xa";

function capsVerHash(): string {
  const identityStr = `${CAPS_IDENTITY.category}/${CAPS_IDENTITY.type}//${CAPS_IDENTITY.name}<`;
  const featuresStr = CAPS_FEATURES.map((f) => `${f}<`).join("");
  return crypto.createHash("sha1").update(identityStr + featuresStr, "utf8").digest("base64");
}

function buildCapsPresence(accountId: string, show?: Show, status?: string): Element {
  const ver = capsVerHash();
  // XEP-0153: el hash del avatar viaja en CADA presencia; es así como los
  // clientes se enteran de que hay uno nuevo que pedir.
  const vcardUpdate = buildVCardUpdateElement(accountId);
  return xml(
    "presence",
    {},
    ...(show ? [xml("show", {}, show)] : []),
    ...(status ? [xml("status", {}, status)] : []),
    xml("c", { xmlns: "http://jabber.org/protocol/caps", hash: "sha-1", node: CAPS_NODE, ver }),
    ...(vcardUpdate ? [vcardUpdate] : []),
  );
}

function humanStatus(t: AgentTelemetry): string {
  if (t.tool) return `Usando herramienta: ${t.tool}`;
  if (t.activity === "busy") return "Trabajando";
  if (t.activity === "paused") return "Ausente";
  if (t.activity === "pending") {
    const n = t.pendingCount ?? 1;
    return n === 1 ? "1 mensaje por procesar" : `${n} mensajes por procesar`;
  }
  return "Disponible";
}

function directedShow(t: AgentTelemetry): Show | null {
  if (t.activity === "busy") return "dnd";
  if (t.activity === "paused" || t.activity === "pending") return "away";
  return null;
}

function buildDirectedStatusPresence(accountId: string, to: string, t: AgentTelemetry): Element {
  const ver = capsVerHash();
  const show = directedShow(t);
  const vcardUpdate = buildVCardUpdateElement(accountId);
  return xml(
    "presence",
    { to },
    ...(show ? [xml("show", {}, show)] : []),
    xml("status", {}, humanStatus(t)),
    xml("c", { xmlns: "http://jabber.org/protocol/caps", hash: "sha-1", node: CAPS_NODE, ver }),
    ...(vcardUpdate ? [vcardUpdate] : []),
  );
}

function buildTelemetryItem(t: AgentTelemetry, node = TELEMETRY_NODE): Element {
  const children: Element[] = [];
  if (t.contextUsed !== null) {
    children.push(xml("context", {
      used: String(t.contextUsed),
      max: String(t.contextMax),
      scope: "active",
      maxSource: t.contextMaxSource,
    }));
  }
  if (t.tokens) {
    children.push(
      xml("tokens", {
        total: String(t.tokens.total),
        input: String(t.tokens.input),
        output: String(t.tokens.output),
        requests: String(t.tokens.requests),
        scope: "session",
      }),
    );
  }
  if (t.cost !== null) children.push(xml("cost", { usd: t.cost.toFixed(4), scope: "last-request" }));
  if (t.sessionCost !== null) children.push(xml("session-cost", { usd: t.sessionCost.toFixed(4), scope: "session" }));
  if (t.dayCost !== null) children.push(xml("day-cost", { usd: t.dayCost.toFixed(4), scope: "day-local" }));
  if (t.model) children.push(xml("model", {}, t.model));
  if (t.tool) children.push(xml("tool", {}, t.tool));
  if (t.sessionStatus) children.push(xml("session", { status: t.sessionStatus }));
  return xml("telemetry", { xmlns: node, activity: t.activity, availability: t.availability }, ...children);
}

function buildTelemetryPublish(t: AgentTelemetry, node = TELEMETRY_NODE): Element {
  return xml(
    "iq",
    { type: "set", id: `tel-${Date.now().toString(36)}` },
    xml(
      "pubsub",
      { xmlns: "http://jabber.org/protocol/pubsub" },
      xml("publish", { node }, xml("item", { id: "current" }, buildTelemetryItem(t, node))),
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

function resolveDirectedStatusTarget(account: ResolvedXmppAccount): string | null {
  const configured = normalizeXmppMessagingTarget(account.config.defaultTo ?? "");
  if (configured) return configured;
  for (const raw of account.config.allowFrom ?? []) {
    const normalized = normalizeXmppMessagingTarget(String(raw));
    if (normalized && normalized !== "*") return normalized;
  }
  return null;
}

function telemetryChanged(prev: AgentTelemetry | null, next: AgentTelemetry): boolean {
  if (!prev) return true;
  if (
    prev.model !== next.model ||
    prev.tool !== next.tool ||
    prev.activity !== next.activity ||
    prev.availability !== next.availability ||
    prev.sessionStatus !== next.sessionStatus
  ) return true;
  if (prev.cost !== next.cost || prev.sessionCost !== next.sessionCost || prev.dayCost !== next.dayCost) return true;
  if (prev.contextMax !== next.contextMax) return true;
  if (prev.contextMaxSource !== next.contextMaxSource) return true;
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

function resolveContextWindow(cfg: CoreConfig, model: string | null): {
  tokens: number;
  source: AgentTelemetry["contextMaxSource"];
} {
  if (model) {
    const providers = (cfg as unknown as {
      models?: { providers?: Record<string, { models?: Array<{ id?: unknown; contextWindow?: unknown }> }> };
    }).models?.providers;
    for (const provider of Object.values(providers ?? {})) {
      const configured = provider.models?.find(
        (candidate) => typeof candidate.id === "string" && (candidate.id === model || model.endsWith(`/${candidate.id}`)),
      );
      const tokens = Number(configured?.contextWindow);
      if (Number.isFinite(tokens) && tokens > 0) return { tokens, source: "config" };
    }
    const known = CONTEXT_MAX_BY_MODEL[model];
    if (known) return { tokens: known, source: "model-table" };
  }
  return { tokens: DEFAULT_CONTEXT_MAX, source: "fallback" };
}

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

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Estados de sesión que significan "hay un turno corriendo". Es deliberadamente
 * una lista de lo OCUPADO y no de lo libre: un estado desconocido (o terminal,
 * como "failed") debe leerse como disponible, nunca dejar al agente clavado en
 * dnd. Los estados en curso reales se detectan además por toolState.active y
 * por la actividad viva del registro, así que esta lista es sólo un refuerzo.
 */
const SESSION_BUSY_STATUSES = new Set(["running", "active", "busy", "working", "in_progress", "streaming"]);

function readSessionStatus(sessionsDir: string, sessionFile: string): string | null {
  const path = join(sessionsDir, "sessions.json");
  if (!existsSync(path)) return null;
  try {
    const data = readJsonFile(path);
    const sessionBase = basename(sessionFile, ".jsonl");
    const values = Array.isArray(data) ? data : typeof data === "object" && data !== null ? Object.values(data) : [];
    for (const item of values) {
      if (typeof item !== "object" || item === null) continue;
      const row = item as { id?: unknown; sessionId?: unknown; sessionFile?: unknown; status?: unknown; paused?: unknown };
      const file = typeof row.sessionFile === "string" ? basename(row.sessionFile, ".jsonl") : "";
      const id = typeof row.sessionId === "string" ? row.sessionId : typeof row.id === "string" ? row.id : "";
      if (file === sessionBase || id === sessionBase) {
        if (row.paused === true) return "paused";
        return typeof row.status === "string" ? row.status : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

type UsageTotals = { total: number; input: number; output: number; requests: number; cost: number };

function usageFromMessage(message: unknown): { total: number; input: number; output: number; cost: number } | null {
  if (typeof message !== "object" || message === null) return null;
  const usage = (message as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as {
    totalTokens?: unknown;
    total?: unknown;
    input?: unknown;
    output?: unknown;
    cost?: { total?: unknown } | unknown;
  };
  const costObj = typeof u.cost === "object" && u.cost !== null ? u.cost as { total?: unknown } : null;
  const cost = Number(costObj?.total ?? 0);
  const total = Number(u.totalTokens ?? u.total ?? 0);
  const input = Number(u.input ?? 0);
  const output = Number(u.output ?? 0);
  if (!Number.isFinite(cost) && !Number.isFinite(total)) return null;
  return {
    total: Number.isFinite(total) ? total : 0,
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
    cost: Number.isFinite(cost) ? cost : 0,
  };
}

function sumUsage(entries: ReturnType<typeof loadEntriesFromFile>): UsageTotals {
  const totals: UsageTotals = { total: 0, input: 0, output: 0, requests: 0, cost: 0 };
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || (entry as { type?: unknown }).type !== "message") continue;
    const message = (entry as { message?: unknown }).message;
    if (typeof message !== "object" || message === null || (message as { role?: unknown }).role !== "assistant") continue;
    const usage = usageFromMessage(message);
    if (!usage) continue;
    totals.total += usage.total;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cost += usage.cost;
    totals.requests += 1;
  }
  return totals;
}

function activeContextTokens(usage: NonNullable<ReturnType<typeof getLastAssistantUsage>>): number | null {
  // OpenClaw's helper prefers the provider's contextUsage snapshot and only
  // falls back to total/input/output/cache counters. input+output alone is
  // provider accounting, not the live prompt snapshot, and made this gauge
  // disagree with /status (especially when prompt caching is active).
  const calculated = calculateContextTokens(usage);
  return Number.isFinite(calculated) && calculated > 0 ? calculated : null;
}

function readDayUsage(sessionsDir: string): UsageTotals | null {
  if (!existsSync(sessionsDir)) return null;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const totals: UsageTotals = { total: 0, input: 0, output: 0, requests: 0, cost: 0 };
  for (const name of readdirSync(sessionsDir)) {
    if (!name.endsWith(".jsonl") || name.endsWith(".trajectory.jsonl")) continue;
    const path = join(sessionsDir, name);
    try {
      if (statSync(path).mtimeMs < start.getTime()) continue;
      const usage = sumUsage(loadEntriesFromFile(path));
      totals.total += usage.total;
      totals.input += usage.input;
      totals.output += usage.output;
      totals.cost += usage.cost;
      totals.requests += usage.requests;
    } catch {
      // Ignore partial or rotated transcript files.
    }
  }
  return totals.requests > 0 ? totals : null;
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

/**
 * Which tool (if any) the agent is mid-execution on, right now.
 *
 * A `toolCall` content item is "in flight" until a matching `toolResult`
 * message (same `toolCallId`) shows up later in the transcript -- verified
 * against a live session (see PORT-NOTES.md "2026-07 current-tool
 * read-side"): every assistant turn with N toolCalls is immediately
 * followed by N toolResult entries, one per call id. Scans from the tail so
 * a long-idle session with a stale unresolved call from hours ago doesn't
 * fire false-positive; toolResults always close out before the entry that
 * would trigger that (a new user/assistant turn) appears.
 */
function entryTimestampMs(entry: unknown): number | null {
  if (typeof entry !== "object" || entry === null) return null;
  const raw = (entry as { timestamp?: unknown; time?: unknown; message?: { timestamp?: unknown } }).timestamp
    ?? (entry as { time?: unknown }).time
    ?? (entry as { message?: { timestamp?: unknown } }).message?.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readCurrentTool(entries: ReturnType<typeof loadEntriesFromFile>): { name: string; active: boolean } | null {
  const pendingCallIds = new Set<string>();
  const now = Date.now();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (typeof entry !== "object" || entry === null || (entry as { type?: unknown }).type !== "message") continue;
    const message = (entry as { message?: unknown }).message;
    if (typeof message !== "object" || message === null) continue;
    const role = (message as { role?: unknown }).role;
    if (role === "toolResult") {
      const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
      if (typeof toolCallId === "string") pendingCallIds.add(toolCallId);
      continue;
    }
    if (role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const item = content[j] as { type?: unknown; id?: unknown; name?: unknown };
      if (item?.type !== "toolCall") continue;
      if (typeof item.id === "string" && pendingCallIds.has(item.id)) {
        const ts = entryTimestampMs(entry);
        if (ts !== null && now - ts <= RECENT_TOOL_TTL_MS && typeof item.name === "string") {
          return { name: item.name, active: false };
        }
        continue;
      }
      // toolCall sin toolResult: en marcha sólo si acaba de ocurrir. Si la
      // sesión murió a mitad de la llamada (proceso caído, turno abortado) el
      // resultado no va a llegar nunca, y darlo por vivo dejaba al agente en
      // dnd "usando exec" indefinidamente -- así se quedó Rolando ~1h.
      if (typeof item.name !== "string") return null;
      const startedAt = entryTimestampMs(entry);
      const stale = startedAt === null || now - startedAt > RECENT_TOOL_TTL_MS;
      return { name: item.name, active: !stale };
    }
    // Reached an assistant turn whose tool calls are all resolved (or it had
    // none) -- nothing is in flight, no need to keep scanning further back.
    return null;
  }
  return null;
}

/** Reads real telemetry for this account's bound agent from its most recent session transcript. Returns null telemetry (inert) if the account isn't bound to an agent yet, or that agent has no session file -- never fabricates numbers. */
export function readAgentTelemetry(cfg: CoreConfig, account: ResolvedXmppAccount): { show: Show; status: string; telemetry: AgentTelemetry | null } {
  const inert = { show: "chat" as Show, status: "OpenClaw connected", telemetry: null };
  const agentId = resolveAgentIdForAccount(cfg, account);
  if (!agentId) return inert;
  const agentDir = resolveAgentDir(cfg, agentId);
  if (!agentDir) return inert;
  const sessionsDir = join(dirname(agentDir), "sessions");
  const sessionFile = findLatestSessionFile(sessionsDir);
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

  const contextUsed = activeContextTokens(usage);
  const contextWindow = resolveContextWindow(cfg, model);
  const contextMax = contextWindow.tokens;
  const toolState = readCurrentTool(entries);
  // Sólo anunciamos la herramienta mientras de verdad está corriendo: el nombre
  // sobrevive a la llamada (readCurrentTool lo devuelve con active:false cuando
  // ya terminó o quedó huérfana), y humanStatus() lo usa sin mirar el flag, así
  // que el agente seguía diciendo "Usando herramienta: exec" ya estando libre.
  const tool = toolState?.active === true ? toolState.name : null;
  const sessionTotals = sumUsage(entries);
  const dayTotals = readDayUsage(sessionsDir);
  const sessionStatus = readSessionStatus(sessionsDir, sessionFile);
  const live = getXmppAccountActivity(account.accountId);
  const paused = sessionStatus === "paused" || sessionStatus === "suspended";
  // Sólo los estados que significan trabajo en curso cuentan como ocupado.
  // Antes esto era una lista blanca de estados "libres" ("done"/"idle"/
  // "completed") y CUALQUIER otro valor -- incluido "failed" -- dejaba al
  // agente en dnd para siempre: una sesión que reventó se anunciaba como
  // "Trabajando" hasta la siguiente sesión.
  const sessionBusy = sessionStatus !== null && SESSION_BUSY_STATUSES.has(sessionStatus);
  const busy = !paused && (toolState?.active === true || live?.activity === "busy" || sessionBusy);
  // "pending" sólo se anuncia si nada más ya dice que el agente está ocupado:
  // busy siempre gana, porque ya es más informativo (el remitente ya sabe que
  // hay actividad) y setXmppAccountActivity limpia el registro de pending al
  // pasar a busy, así que en condiciones normales nunca coexisten.
  const pending = !paused && !busy && live?.activity === "pending";
  const activity: AgentTelemetry["activity"] = paused ? "paused" : busy ? "busy" : pending ? "pending" : "available";
  const availability: AgentTelemetry["availability"] = paused ? "away" : busy ? "busy" : "available";

  const telemetry: AgentTelemetry = {
    contextUsed,
    contextMax,
    contextMaxSource: contextWindow.source,
    tokens: {
      total: sessionTotals.total || usage.totalTokens || 0,
      input: sessionTotals.input || usage.input || 0,
      output: sessionTotals.output || usage.output || 0,
      requests: sessionTotals.requests || 1,
    },
    cost: usage.cost?.total ?? null,
    sessionCost: sessionTotals.requests > 0 ? sessionTotals.cost : usage.cost?.total ?? null,
    dayCost: dayTotals?.cost ?? null,
    model,
    tool,
    activity,
    availability,
    sessionStatus,
    pendingCount: pending ? live?.pendingCount : undefined,
  };

  // Mirrors NanoClaw's agentState(): <status/> is what clients (Gajim,
  // Cheogram, this app's own activity chip) paint next to the contact --
  // "Tool: bash" while mid-execution, otherwise just "Available". It was
  // hardcoded to a constant string here, which is why the desktop/Android
  // "Trabajando" / "Usando herramienta: X" chip stopped updating after the
  // OpenClaw port -- this had never actually been wired up.
  if (paused) return { show: "away", status: tool ? `Paused: ${tool}` : "Paused", telemetry };
  if (busy) return { show: "dnd", status: tool ? `Tool: ${tool}` : "Working", telemetry };
  return { show: "chat", status: "Available", telemetry };
}

/** Human-readable, zero-inference usage report for menus and text clients. */
export function formatCreditReport(t: AgentTelemetry | null): string {
  if (!t) return "Aún no hay telemetría para una sesión de este agente.";
  const lines: string[] = [];
  if (t.contextUsed === null) {
    lines.push("Memoria activa: sin datos todavía.");
  } else {
    const pct = Math.round((t.contextUsed / t.contextMax) * 100);
    const sourceNote = t.contextMaxSource === "fallback" ? " (límite estimado)" : "";
    lines.push(`Memoria activa: ${t.contextUsed.toLocaleString("es")} / ${t.contextMax.toLocaleString("es")} tokens (${pct}%)${sourceNote}.`);
  }
  if (t.tokens) {
    lines.push(`Consumo de esta sesión: ${t.tokens.total.toLocaleString("es")} tokens en ${t.tokens.requests.toLocaleString("es")} peticiones.`);
  }
  if (t.sessionCost !== null) lines.push(`Coste de esta sesión: US$ ${t.sessionCost.toFixed(4)}.`);
  if (t.dayCost !== null) lines.push(`Coste local de hoy: US$ ${t.dayCost.toFixed(4)}.`);
  if (t.cost !== null) lines.push(`Última petición: US$ ${t.cost.toFixed(4)}.`);
  if (t.tokens && t.sessionCost !== null && t.tokens.requests > 0) {
    lines.push(`Promedio observado: US$ ${(t.sessionCost / t.tokens.requests).toFixed(4)} por petición.`);
  }
  lines.push("El porcentaje mide memoria activa, no crédito ni gasto acumulado.");
  lines.push("Los importes provienen de los logs locales; no representan el saldo restante del proveedor.");
  return lines.join("\n");
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
  let lastPresence: { show: Show; status: string; avatarHash: string | null } | null = null;
  let lastTelemetry: AgentTelemetry | null = null;
  let lastDirectedActivity: string | null = null;
  let loggedInert = false;
  logger?.info?.(`[xmpp] [${account.accountId}] telemetry loop started`);

  const tick = async (force = false) => {
    if (!connection.isConnected()) return;
    const state = readAgentTelemetry(cfg, account);
    if (!state.telemetry && !loggedInert) {
      logger?.info?.(`[xmpp] [${account.accountId}] telemetry inert: no bound session usage yet`);
      loggedInert = true;
    }

    // El avatar entra en la comparación: al publicar uno nuevo hay que reemitir
    // la presencia con su hash (XEP-0153) o nadie se entera del cambio.
    const avatarHash = getPublishedAvatarHash(account.accountId);
    if (
      force ||
      lastPresence?.show !== state.show ||
      lastPresence.status !== state.status ||
      lastPresence.avatarHash !== avatarHash
    ) {
      await connection.send(buildCapsPresence(account.accountId, state.show, state.status)).catch((err) =>
        logger?.warn?.(`XMPP presence publish failed: ${String(err)}`),
      );
      lastPresence = { show: state.show, status: state.status, avatarHash };
    }

    if (state.telemetry && (force || telemetryChanged(lastTelemetry, state.telemetry))) {
      await connection.send(buildTelemetryPublish(state.telemetry)).catch((err) =>
        logger?.warn?.(`XMPP telemetry publish failed: ${String(err)}`),
      );
      logger?.info?.(
        `[xmpp] [${account.accountId}] telemetry activity=${state.telemetry.activity} tool=${state.telemetry.tool ?? "-"} context=${state.telemetry.contextUsed ?? "-"} session_cost=${state.telemetry.sessionCost?.toFixed(4) ?? "-"} day_cost=${state.telemetry.dayCost?.toFixed(4) ?? "-"}`,
      );
      lastTelemetry = state.telemetry;
    }

    const currentTool = state.telemetry?.tool ?? null;
    const activity = state.telemetry?.activity ?? "available";
    const directedActivity = `${activity}:${currentTool ?? ""}`;
    if (force || directedActivity !== lastDirectedActivity) {
      const target = resolveDirectedStatusTarget(account);
      if (target && state.telemetry) {
        await connection.send(buildDirectedStatusPresence(account.accountId, target, state.telemetry)).catch((err) =>
          logger?.warn?.(`XMPP directed status publish failed: ${String(err)}`),
        );
      }
      lastDirectedActivity = directedActivity;
    }
  };

  void tick(true);
  const timer = setInterval(() => void tick(), PRESENCE_INTERVAL_MS);

  return {
    stop: () => clearInterval(timer),
  };
}
