// Xmpp plugin module implements the XEP-0313 (MAM) client for history
// catch-up (change xmpp-first-class-channel, tarea 5.1). It builds the query
// IQ-set with an XEP-0004 form, pages with XEP-0059 RSM (mandatory: Prosody's
// default max_archive_query_results is 50), reads XEP-0359 archive ids in
// their composite (by, id) key with an origin-id fallback, and is only used
// when the disco preflight reported `urn:xmpp:mam:2`.
//
// The QUERY is an IQ but the archived messages arrive as separate
// <message><result xmlns='urn:xmpp:mam:2'/></message> stanzas correlated by
// `queryid`; callers must feed those to handleStanza while the query is in
// flight. Anchor-purged degradation follows the fluux pattern: an anchor the
// server no longer holds degrades to fetch-latest exactly once, never loops.
import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";

import { buildFormElement, type FormField } from "./xep-0004.js";
import { getOriginId, getStanzaIdKey, NS_ORIGIN_ID, NS_STANZA_ID } from "./protocol.js";

export const NS_MAM2 = "urn:xmpp:mam:2";
export const NS_RSM = "http://jabber.org/protocol/rsm";
export const NS_FORWARD = "urn:xmpp:forward:0";
export const NS_DELAY = "urn:xmpp:delay";

const DEFAULT_MAX_PER_PAGE = 50;
const MAM_TIMEOUT_MS = 30_000;

export type MamArchiveId = { by: string; id: string };

export type MamArchivedMessage = {
  /** XEP-0359 stanza-id (by,id); falls back to the <result id>. */
  archiveId: MamArchiveId | null;
  /** XEP-0359 origin-id of the sender, when present. */
  originId?: string;
  /** The forwarded inner <message>. */
  message: Element;
  queryId?: string;
  from?: string;
  type?: string;
  body: string;
  /** Original timestamp from XEP-0203 <delay/> inside the forwarded wrapper. */
  delayMs?: number;
};

export type MamPage = {
  messages: MamArchivedMessage[];
  complete: boolean;
  first?: string;
  last?: string;
  count?: number;
};

export type MamFin = {
  complete: boolean;
  stable?: boolean;
  first?: string;
  last?: string;
  count?: number;
};

export type MamCatchupResult = {
  messages: MamArchivedMessage[];
  /** True when the anchor was purged/stale and fetch-latest was used instead. */
  degraded: boolean;
  pages: number;
};

export type MamQueryTransport = (iq: Element, timeoutMs: number) => Promise<Element>;

export type MamClientOptions = {
  accountId: string;
  /** Bare account JID; the DM archive owner. */
  selfJid: string;
  iqRequest: MamQueryTransport;
  maxPerPage?: number;
  maxPages?: number;
  now?: () => number;
  log?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
};

/** Build the XEP-0313 query IQ-set (XEP-0004 form + XEP-0059 RSM). */
export function buildMamQuery(params: {
  to: string;
  queryId: string;
  with?: string;
  /** RSM <after/> anchor: page forward from the last seen archive id. */
  after?: string;
  /** RSM <before/>: empty string asks for the latest page (fetch-latest). */
  before?: string;
  start?: number;
  end?: number;
  max: number;
  id?: string;
}): Element {
  const fields: FormField[] = [{ var: "FORM_TYPE", type: "hidden", value: NS_MAM2 }];
  if (params.with) fields.push({ var: "with", value: params.with });
  if (params.start !== undefined) fields.push({ var: "start", value: new Date(params.start).toISOString() });
  if (params.end !== undefined) fields.push({ var: "end", value: new Date(params.end).toISOString() });

  const rsm: Element[] = [xml("max", {}, String(params.max))];
  if (params.after !== undefined) rsm.push(xml("after", {}, params.after));
  else if (params.before !== undefined) rsm.push(xml("before", {}, params.before));

  const query = xml(
    "query",
    { xmlns: NS_MAM2, queryid: params.queryId },
    buildFormElement({ type: "submit", fields }),
    xml("set", { xmlns: NS_RSM }, ...rsm),
  );
  return xml(
    "iq",
    { type: "set", to: params.to, id: params.id ?? params.queryId },
    query,
  );
}

/** Extract an archived message from a MAM <result/> wrapper. */
export function extractArchivedMessage(stanza: Element): MamArchivedMessage | null {
  const result = stanza.getChild("result", NS_MAM2);
  if (!result) return null;
  const forwarded = result.getChild("forwarded", NS_FORWARD);
  const inner = forwarded?.getChild("message") ?? undefined;
  const delay = forwarded?.getChild("delay", NS_DELAY);
  const delayMs = typeof delay?.attrs.stamp === "string" ? Date.parse(delay.attrs.stamp) : undefined;

  const stanzaId = inner?.getChild("stanza-id", NS_STANZA_ID);
  const origin = inner?.getChild("origin-id", NS_ORIGIN_ID);
  const resultId = result.attrs.id;
  const archiveId: MamArchiveId | null = typeof stanzaId?.attrs.id === "string" && stanzaId.attrs.id
    ? { by: typeof stanzaId.attrs.by === "string" ? stanzaId.attrs.by : "", id: stanzaId.attrs.id }
    : typeof resultId === "string" && resultId
      ? { by: "", id: resultId }
      : null;

  const materialized = inner ?? stanza;
  const from = typeof materialized.attrs.from === "string" ? materialized.attrs.from : undefined;
  const type = typeof materialized.attrs.type === "string" ? materialized.attrs.type : undefined;
  return {
    archiveId,
    ...(typeof origin?.attrs.id === "string" && origin.attrs.id ? { originId: origin.attrs.id } : {}),
    message: materialized,
    queryId: typeof result.attrs.queryid === "string" ? result.attrs.queryid : undefined,
    ...(from ? { from } : {}),
    ...(type ? { type } : {}),
    body: materialized.getChildText("body") || "",
    ...(Number.isFinite(delayMs) ? { delayMs } : {}),
  };
}

/** Parse the <fin/> element of a MAM query result (with its RSM set). */
export function parseMamFin(iq: Element): MamFin | null {
  const fin = iq.getChild("fin", NS_MAM2) ?? iq.getChild("query", NS_MAM2)?.getChild("fin", NS_MAM2);
  if (!fin) return null;
  const set = fin.getChild("set", NS_RSM);
  const countRaw = set?.getChildText("count");
  const count = countRaw !== undefined && countRaw !== "" ? Number(countRaw) : undefined;
  const first = set?.getChildText("first");
  const last = set?.getChildText("last");
  return {
    complete: fin.attrs.complete !== "false",
    ...(fin.attrs.stable === "true" ? { stable: true } : {}),
    ...(first ? { first } : {}),
    ...(last ? { last } : {}),
    ...(Number.isFinite(count) ? { count } : {}),
  };
}

/** True when an error means the RSM anchor no longer exists in the archive. */
export function isMamAnchorPurgedError(error: unknown): boolean {
  const condition = (error as { condition?: string } | undefined)?.condition;
  const text = `${condition ?? ""} ${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`;
  return /item-not-found|not-found|gone|purged|no longer|invalid-anchor/i.test(text);
}

function compareArchived(a: MamArchivedMessage, b: MamArchivedMessage): number {
  if (a.delayMs !== undefined && b.delayMs !== undefined) return a.delayMs - b.delayMs;
  return 0;
}

function archiveIdKey(id: MamArchiveId | null | undefined): string | null {
  if (!id || !id.id) return null;
  return `${id.by}\u0000${id.id}`;
}

/** XEP-0359 archive id for a live stanza, with origin-id as fallback. */
export function stanzaArchiveId(stanza: Element): MamArchiveId | null {
  const composite = getStanzaIdKey(stanza);
  if (composite) return composite;
  const origin = getOriginId(stanza);
  return origin ? { by: "", id: origin } : null;
}

export class MamClient {
  private readonly selfJid: string;
  private readonly iqRequest: MamQueryTransport;
  private readonly maxPerPage: number;
  private readonly maxPages: number;
  private readonly now: () => number;
  private readonly log: MamClientOptions["log"];
  private readonly pending = new Map<string, MamArchivedMessage[]>();
  private seq = 0;

  constructor(options: MamClientOptions) {
    this.selfJid = options.selfJid;
    this.iqRequest = options.iqRequest;
    this.maxPerPage = options.maxPerPage ?? DEFAULT_MAX_PER_PAGE;
    this.maxPages = options.maxPages ?? 4;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log;
  }

  /**
   * Feed a stanza; returns true when it was a MAM result. Results are buffered
   * for the in-flight query (matched by queryid) and never treated as inbound
   * chat, even when they arrive outside a query.
   */
  handleStanza(stanza: Element): boolean {
    const archived = extractArchivedMessage(stanza);
    if (!archived) return false;
    if (archived.queryId && this.pending.has(archived.queryId)) {
      this.pending.get(archived.queryId)!.push(archived);
    }
    return true;
  }

  /** Run one RSM page. */
  async queryPage(params: {
    archive: string;
    with?: string;
    after?: string;
    before?: string;
    start?: number;
    end?: number;
  }): Promise<MamPage> {
    this.seq += 1;
    const queryId = `mam-${this.seq.toString(36)}-${this.now().toString(36)}`;
    const iq = buildMamQuery({
      to: params.archive,
      queryId,
      ...(params.with ? { with: params.with } : {}),
      ...(params.after !== undefined ? { after: params.after } : {}),
      ...(params.before !== undefined ? { before: params.before } : {}),
      ...(params.start !== undefined ? { start: params.start } : {}),
      ...(params.end !== undefined ? { end: params.end } : {}),
      max: this.maxPerPage,
    });
    const collected: MamArchivedMessage[] = [];
    this.pending.set(queryId, collected);
    try {
      const response = await this.iqRequest(iq, MAM_TIMEOUT_MS);
      const fin = parseMamFin(response);
      const ordered = [...collected].sort(compareArchived);
      return {
        messages: ordered,
        complete: fin?.complete !== false,
        ...(fin?.first ? { first: fin.first } : {}),
        ...(fin?.last ?? ordered.at(-1)?.archiveId?.id
          ? { last: fin?.last ?? ordered.at(-1)?.archiveId?.id }
          : {}),
        ...(fin?.count !== undefined ? { count: fin.count } : {}),
      };
    } finally {
      this.pending.delete(queryId);
    }
  }

  /**
   * Forward catch-up from an anchor, bounded by page count and retention
   * window. A purged anchor (server error, or older than the window) degrades
   * to fetch-latest exactly once.
   */
  async catchup(params: {
    archive: string;
    with?: string;
    anchor?: string;
    anchorAt?: number;
    windowMs: number;
    start?: number;
    end?: number;
  }): Promise<MamCatchupResult> {
    let after = params.anchor;
    let before: string | undefined;
    let degraded = false;
    const windowStart = params.start ?? this.now() - params.windowMs;

    // An anchor older than the retention window can only point at purged
    // history: skip the dead anchor and ask for the latest page instead.
    if (after !== undefined && params.anchorAt !== undefined && this.now() - params.anchorAt > params.windowMs) {
      degraded = true;
      this.log?.warn?.(
        `[${this.selfJid}] MAM anchor older than the retention window for ${params.archive}; degrading to fetch-latest`,
      );
      after = undefined;
      before = "";
    }

    const messages: MamArchivedMessage[] = [];
    const seen = new Set<string>();
    let pages = 0;
    while (pages < this.maxPages) {
      pages += 1;
      let page: MamPage;
      try {
        page = await this.queryPage({
          archive: params.archive,
          ...(params.with ? { with: params.with } : {}),
          ...(after !== undefined ? { after } : {}),
          ...(before !== undefined ? { before } : {}),
          ...(after !== undefined ? { start: windowStart } : {}),
          ...(params.end !== undefined ? { end: params.end } : {}),
        });
      } catch (error) {
        if (after !== undefined && isMamAnchorPurgedError(error)) {
          degraded = true;
          this.log?.warn?.(
            `[${this.selfJid}] MAM anchor purged for ${params.archive}; degrading to fetch-latest (no anchor retry)`,
          );
          after = undefined;
          before = "";
          continue;
        }
        throw error;
      }
      for (const message of page.messages) {
        const key = archiveIdKey(message.archiveId) ?? `origin:${message.originId ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        messages.push(message);
      }
      if (page.complete) break;
      const last = page.last ?? page.messages.at(-1)?.archiveId?.id;
      if (!last || last === after) break;
      after = last;
      before = undefined;
    }
    return { messages, degraded, pages };
  }
}
