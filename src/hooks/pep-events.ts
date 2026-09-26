// Xmpp plugin module implements the PEP event surface for ad-hoc clients
// (change xmpp-first-class-channel, tareas 7.1/7.2). Versioned PEP nodes
// publish a structured JSON payload describing channel activity, approval
// lifecycle and turn progress so any authorized client can subscribe with
// XEP-0163 instead of polling the XEP-0050 nodes.
//
// Access model: PEP is user-centric PubSub (XEP-0163); the SERVER applies the
// node's access model to subscriptions (the plugin cannot filter subscribers).
// These nodes are published with `pubsub#access_model=presence` so only
// contacts the bot has authorized via presence can receive them — the same
// allowFrom identities are already roster contacts. Operators that need a
// stricter boundary must configure a whitelist node access model server-side
// (see HOOKS.md). Publishing failures are swallowed: an unavailable PEP
// service must never break the chat/turn flow.
import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";
import { pepPublish, type PepResult } from "../pep.js";
import type { Logger } from "../omemo/types.js";

export const HOOKS_ACTIVITY_NODE = "urn:openclaw:hooks:activity:0";
export const HOOKS_APPROVAL_NODE = "urn:openclaw:hooks:approval:0";
export const HOOKS_PROGRESS_NODE = "urn:openclaw:hooks:progress:0";

/** Contract version carried in every payload (`contractVersion`). */
export const HOOKS_CONTRACT_VERSION = 1;

export type HookActivityState = "available" | "processing" | "busy" | "paused" | "pending";
export type HookApprovalState = "pending" | "resolved" | "expired" | "canceled" | "failed";
export type HookProgressState = "start" | "end";

export type HookEventPayload = Record<string, unknown>;

let hookItemSeq = 0;

function nextHookItemId(kind: string): string {
  hookItemSeq += 1;
  return `oc-hook-${kind}-${Date.now().toString(36)}-${hookItemSeq.toString(36)}`;
}

function isoNow(now = Date.now()): string {
  return new Date(now).toISOString();
}

/**
 * Build the PEP event item payload element. The JSON document is the text
 * content of one element whose namespace IS the versioned node, so clients
 * can distinguish contracts without parsing attributes.
 */
export function buildHookEventElement(node: string, payload: HookEventPayload): Element {
  return xml(
    "event",
    { xmlns: node, version: String(HOOKS_CONTRACT_VERSION) },
    JSON.stringify(payload),
  );
}

export function buildActivityHookPayload(params: {
  state: HookActivityState;
  sessionKey?: string | null;
  originJid?: string | null;
  target?: string | null;
  pendingCount?: number;
  now?: number;
}): HookEventPayload {
  return {
    contractVersion: HOOKS_CONTRACT_VERSION,
    event: "activity",
    state: params.state,
    sessionKey: params.sessionKey ?? null,
    originJid: params.originJid ?? null,
    target: params.target ?? null,
    ...(params.pendingCount !== undefined ? { pendingCount: params.pendingCount } : {}),
    timestamp: isoNow(params.now),
  };
}

export function buildApprovalHookPayload(params: {
  state: HookApprovalState;
  approvalId: string;
  stanzaId?: string | null;
  jid?: string | null;
  sessionKey?: string | null;
  expiresAtMs?: number | null;
  decision?: string | null;
  command?: string | null;
  now?: number;
}): HookEventPayload {
  return {
    contractVersion: HOOKS_CONTRACT_VERSION,
    event: "approval",
    state: params.state,
    approvalId: params.approvalId,
    stanzaId: params.stanzaId ?? null,
    jid: params.jid ?? null,
    sessionKey: params.sessionKey ?? null,
    expiresAtMs: params.expiresAtMs ?? null,
    ...(params.decision ? { decision: params.decision } : {}),
    ...(params.command ? { command: params.command } : {}),
    timestamp: isoNow(params.now),
  };
}

export function buildProgressHookPayload(params: {
  state: HookProgressState;
  sessionKey?: string | null;
  originJid?: string | null;
  target?: string | null;
  detail?: string | null;
  now?: number;
}): HookEventPayload {
  return {
    contractVersion: HOOKS_CONTRACT_VERSION,
    event: "progress",
    state: params.state,
    sessionKey: params.sessionKey ?? null,
    originJid: params.originJid ?? null,
    target: params.target ?? null,
    ...(params.detail ? { detail: params.detail } : {}),
    timestamp: isoNow(params.now),
  };
}

async function publishHookEvent(
  accountId: string,
  node: string,
  kind: string,
  payload: HookEventPayload,
  log?: Logger,
): Promise<PepResult> {
  try {
    return await pepPublish(
      accountId,
      node,
      nextHookItemId(kind),
      buildHookEventElement(node, payload),
      { accessModel: "presence", persistItems: false, notifyRetract: false },
      log,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log?.debug?.(`[hooks] PEP publish failed for ${node}: ${message}`);
    return { ok: false, error: message };
  }
}

export function publishActivityHookEvent(params: {
  accountId: string;
  state: HookActivityState;
  sessionKey?: string | null;
  originJid?: string | null;
  target?: string | null;
  pendingCount?: number;
  now?: number;
  log?: Logger;
}): Promise<PepResult> {
  return publishHookEvent(
    params.accountId,
    HOOKS_ACTIVITY_NODE,
    "activity",
    buildActivityHookPayload(params),
    params.log,
  );
}

export function publishApprovalHookEvent(params: {
  accountId: string;
  state: HookApprovalState;
  approvalId: string;
  stanzaId?: string | null;
  jid?: string | null;
  sessionKey?: string | null;
  expiresAtMs?: number | null;
  decision?: string | null;
  command?: string | null;
  now?: number;
  log?: Logger;
}): Promise<PepResult> {
  return publishHookEvent(
    params.accountId,
    HOOKS_APPROVAL_NODE,
    "approval",
    buildApprovalHookPayload(params),
    params.log,
  );
}

export function publishProgressHookEvent(params: {
  accountId: string;
  state: HookProgressState;
  sessionKey?: string | null;
  originJid?: string | null;
  target?: string | null;
  detail?: string | null;
  now?: number;
  log?: Logger;
}): Promise<PepResult> {
  return publishHookEvent(
    params.accountId,
    HOOKS_PROGRESS_NODE,
    "progress",
    buildProgressHookPayload(params),
    params.log,
  );
}
