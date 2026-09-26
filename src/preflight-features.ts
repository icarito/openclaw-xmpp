// Xmpp plugin module implements the disk preflight for optional server
// features (change xmpp-first-class-channel, tarea 1.3). Probing disco#info
// once per account (bare JID + MUC domain) and caching the result lets the
// MAM catch-up / receipts layers degrade fail-closed and lets the XEP-0050
// `status` node show what the server actually supports.
import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";
import type { ResolvedXmppAccount } from "./accounts.js";

export const NS_DISCO_INFO = "http://jabber.org/protocol/disco#info";
export const NS_MAM2 = "urn:xmpp:mam:2";

export type XmppFeatureProbe = {
  jid: string;
  reachable: boolean;
  mam2: boolean;
  error?: string;
};

export type XmppFeaturePreflight = {
  accountId: string;
  checkedAt: number;
  server?: XmppFeatureProbe;
  muc?: XmppFeatureProbe;
};

const REGISTRY_KEY = "__openclawXmppFeaturePreflight";

function registry(): Map<string, XmppFeaturePreflight> {
  const g = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Map<string, XmppFeaturePreflight> };
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map();
  return g[REGISTRY_KEY]!;
}

export function buildDiscoInfoIq(jid: string, id?: string): Element {
  return xml(
    "iq",
    { type: "get", to: jid, ...(id ? { id } : {}) },
    xml("query", { xmlns: NS_DISCO_INFO }),
  );
}

/** True when a disco#info result (or bare query element) advertises MAM v2. */
export function discoInfoHasMam2(element: Element | undefined): boolean {
  if (!element) return false;
  const query = element.is("query", NS_DISCO_INFO)
    ? element
    : element.getChild("query", NS_DISCO_INFO);
  if (!query) return false;
  for (const feature of query.getChildren("feature")) {
    const ns = feature.attrs.var;
    if (typeof ns === "string" && ns.split(" ").includes(NS_MAM2)) return true;
  }
  return false;
}

export function getXmppFeaturePreflight(accountId: string): XmppFeaturePreflight | undefined {
  return registry().get(accountId);
}

export function clearXmppFeaturePreflight(accountId: string): void {
  registry().delete(accountId);
}

async function probe(
  jid: string,
  discoInfo: (jid: string) => Promise<Element | undefined>,
): Promise<XmppFeatureProbe> {
  try {
    const element = await discoInfo(jid);
    return { jid, reachable: true, mam2: discoInfoHasMam2(element) };
  } catch (error) {
    return {
      jid,
      reachable: false,
      mam2: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Probe the server (bare JID) and, when configured, the MUC domain. Results
 * are cached per account for the `status` node and the history layer. A probe
 * failure is not fatal: it is recorded so callers can fall back to the legacy
 * behavior.
 */
export async function preflightXmppFeatures(params: {
  account: ResolvedXmppAccount;
  discoInfo: (jid: string) => Promise<Element | undefined>;
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
}): Promise<XmppFeaturePreflight> {
  const { account, discoInfo, log } = params;
  const server = await probe(account.jid, discoInfo);
  const muc = account.mucDomain ? await probe(account.mucDomain, discoInfo) : undefined;
  const result: XmppFeaturePreflight = {
    accountId: account.accountId,
    checkedAt: Date.now(),
    server,
    ...(muc ? { muc } : {}),
  };
  registry().set(account.accountId, result);
  if (server.mam2) {
    log?.info?.(`[${account.accountId}] preflight: server advertises ${NS_MAM2}`);
  } else {
    log?.warn?.(
      `[${account.accountId}] preflight: server does not advertise ${NS_MAM2} (history catch-up disabled)`,
    );
  }
  if (muc) {
    log?.info?.(
      `[${account.accountId}] preflight: MUC ${muc.jid} mam2=${muc.mam2} reachable=${muc.reachable}`,
    );
  }
  return result;
}

/** Human-readable one-liner for the XEP-0050 `status` node. */
export function describeXmppFeaturePreflight(accountId: string): string {
  const cached = registry().get(accountId);
  if (!cached) return "Server features: not probed yet.";
  const server = cached.server;
  const serverText = server
    ? `server MAM v2 ${server.mam2 ? "yes" : "no"}${server.reachable ? "" : " (unreachable)"}`
    : "server MAM v2 unknown";
  const mucText = cached.muc
    ? `, MUC ${cached.muc.jid} MAM v2 ${cached.muc.mam2 ? "yes" : "no"}`
    : "";
  return `Server features: ${serverText}${mucText}.`;
}
