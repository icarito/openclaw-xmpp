// Tareas 5.1/5.6 de xmpp-first-class-channel: cliente XEP-0313 MAM.
import { describe, expect, it } from "vitest";
import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";

import {
  MamClient,
  NS_DELAY,
  NS_FORWARD,
  NS_MAM2,
  NS_RSM,
  buildMamQuery,
  extractArchivedMessage,
  parseMamFin,
} from "../mam.js";
import { NS_STANZA_ID } from "../protocol.js";
import { NS_ORIGIN_ID } from "../protocol.js";

function mamResult(
  queryId: string,
  archiveId: string,
  body: string,
  options: { by?: string; from?: string; originId?: string; stamp?: string; type?: string } = {},
): Element {
  return xml(
    "message",
    {},
    xml(
      "result",
      { xmlns: NS_MAM2, queryid: queryId, id: archiveId },
      xml(
        "forwarded",
        { xmlns: NS_FORWARD },
        ...(options.stamp ? [xml("delay", { xmlns: NS_DELAY, stamp: options.stamp })] : []),
        xml(
          "message",
          { from: options.from ?? "peer@example.org", type: options.type ?? "chat", id: archiveId },
          xml("body", {}, body),
          xml("stanza-id", { xmlns: NS_STANZA_ID, by: options.by ?? "bot@example.org", id: archiveId }),
          ...(options.originId ? [xml("origin-id", { xmlns: NS_ORIGIN_ID, id: options.originId })] : []),
        ),
      ),
    ),
  );
}

function finIq(params: { complete: boolean; first?: string; last?: string; count?: number }): Element {
  return xml(
    "iq",
    { type: "result" },
    xml(
      "fin",
      { xmlns: NS_MAM2, complete: params.complete ? "true" : "false" },
      xml(
        "set",
        { xmlns: NS_RSM },
        ...(params.first ? [xml("first", {}, params.first)] : []),
        ...(params.last ? [xml("last", {}, params.last)] : []),
        ...(params.count !== undefined ? [xml("count", {}, String(params.count))] : []),
      ),
    ),
  );
}

function queryOf(iq: Element): Element {
  return iq.getChild("query", NS_MAM2)!;
}

describe("mam build/parse", () => {
  it("construye el IQ-set con form XEP-0004 y RSM after", () => {
    const iq = buildMamQuery({
      to: "bot@example.org",
      queryId: "q1",
      with: "peer@example.org",
      after: "m0",
      start: Date.parse("2026-09-01T00:00:00Z"),
      max: 50,
    });
    expect(iq.attrs.type).toBe("set");
    expect(iq.attrs.to).toBe("bot@example.org");
    const query = queryOf(iq);
    expect(query.attrs.queryid).toBe("q1");
    const x = query.getChild("x", "jabber:x:data")!;
    expect(x.attrs.type).toBe("submit");
    const formType = x.getChildren("field").find((f) => f.attrs.var === "FORM_TYPE")!;
    expect(formType.getChildText("value")).toBe(NS_MAM2);
    const withField = x.getChildren("field").find((f) => f.attrs.var === "with")!;
    expect(withField.getChildText("value")).toBe("peer@example.org");
    const set = query.getChild("set", NS_RSM)!;
    expect(set.getChildText("max")).toBe("50");
    expect(set.getChildText("after")).toBe("m0");
  });

  it("usa <before/> vacío para fetch-latest", () => {
    const iq = buildMamQuery({ to: "bot@example.org", queryId: "q2", before: "", max: 50 });
    const set = queryOf(iq).getChild("set", NS_RSM)!;
    expect(set.getChild("before")).toBeTruthy();
    expect(set.getChild("after")).toBeUndefined();
  });

  it("extrae archive-id compuesto (by,id), origin-id y cuerpo", () => {
    const message = extractArchivedMessage(
      mamResult("q1", "m1", "hola", { by: "room@conference.example.org", originId: "oc-1", from: "room@conference.example.org/nick" }),
    );
    expect(message).not.toBeNull();
    expect(message!.archiveId).toEqual({ by: "room@conference.example.org", id: "m1" });
    expect(message!.originId).toBe("oc-1");
    expect(message!.body).toBe("hola");
    expect(message!.from).toBe("room@conference.example.org/nick");
  });

  it("hace fallback al id del <result> sin stanza-id", () => {
    const stanza = xml(
      "message",
      {},
      xml(
        "result",
        { xmlns: NS_MAM2, queryid: "q1", id: "archive-9" },
        xml("forwarded", { xmlns: NS_FORWARD }, xml("message", { from: "peer@example.org", type: "chat" }, xml("body", {}, "x"))),
      ),
    );
    expect(extractArchivedMessage(stanza)!.archiveId).toEqual({ by: "", id: "archive-9" });
    expect(extractArchivedMessage(xml("message", {}, xml("body", {}, "no result")))).toBeNull();
  });

  it("parsea el <fin/> con su set RSM", () => {
    const fin = parseMamFin(finIq({ complete: true, first: "m1", last: "m3", count: 3 }))!;
    expect(fin.complete).toBe(true);
    expect(fin.first).toBe("m1");
    expect(fin.last).toBe("m3");
    expect(fin.count).toBe(3);
    expect(parseMamFin(xml("iq", { type: "result" }))).toBeNull();
  });
});

describe("MamClient catch-up", () => {
  function makeClient(maxPages = 4, now = () => Date.now()) {
    let handler: ((iq: Element, timeoutMs: number) => Promise<Element>) | null = null;
    const client = new MamClient({
      accountId: "test",
      selfJid: "bot@example.org",
      iqRequest: (iq, timeoutMs) => {
        if (!handler) throw new Error("no transport");
        return handler(iq, timeoutMs);
      },
      maxPages,
      now,
    });
    return { client, setHandler: (fn: (iq: Element, timeoutMs: number) => Promise<Element>) => { handler = fn; } };
  }

  it("pagina con after y sin gaps hasta complete", async () => {
    const { client, setHandler } = makeClient();
    let queries = 0;
    setHandler(async (iq) => {
      queries += 1;
      const qid = queryOf(iq).attrs.queryid as string;
      if (queries === 1) {
        client.handleStanza(mamResult(qid, "m1", "uno"));
        client.handleStanza(mamResult(qid, "m2", "dos"));
        return finIq({ complete: false, first: "m1", last: "m2", count: 3 });
      }
      client.handleStanza(mamResult(qid, "m3", "tres"));
      return finIq({ complete: true, first: "m3", last: "m3", count: 3 });
    });

    const result = await client.catchup({
      archive: "bot@example.org",
      with: "peer@example.org",
      anchor: "m0",
      anchorAt: Date.now(),
      windowMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(queries).toBe(2);
    expect(result.messages.map((m) => m.archiveId!.id)).toEqual(["m1", "m2", "m3"]);
    expect(result.degraded).toBe(false);
    expect(result.pages).toBe(2);
  });

  it("respeta el tope de páginas", async () => {
    const { client, setHandler } = makeClient(2);
    let queries = 0;
    setHandler(async (iq) => {
      queries += 1;
      const qid = queryOf(iq).attrs.queryid as string;
      client.handleStanza(mamResult(qid, `m${queries}`, "x"));
      return finIq({ complete: false, last: `m${queries}`, count: 99 });
    });
    const result = await client.catchup({ archive: "bot@example.org", windowMs: 1_000_000 });
    expect(result.pages).toBe(2);
    expect(queries).toBe(2);
    expect(result.messages).toHaveLength(2);
  });

  it("degrada a fetch-latest si el anclaje fue purgado (una sola vez)", async () => {
    const { client, setHandler } = makeClient();
    const queries: Element[] = [];
    setHandler(async (iq) => {
      queries.push(iq);
      const set = queryOf(iq).getChild("set", NS_RSM)!;
      if (set.getChildText("after")) {
        const error = new Error("item-not-found");
        (error as Error & { condition?: string }).condition = "item-not-found";
        throw error;
      }
      const qid = queryOf(iq).attrs.queryid as string;
      client.handleStanza(mamResult(qid, "m9", "ultimo"));
      return finIq({ complete: true, first: "m9", last: "m9" });
    });

    const result = await client.catchup({
      archive: "bot@example.org",
      with: "peer@example.org",
      anchor: "muerto",
      anchorAt: Date.now(),
      windowMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(result.degraded).toBe(true);
    expect(result.messages.map((m) => m.archiveId!.id)).toEqual(["m9"]);
    expect(queries).toHaveLength(2);
    expect(queryOf(queries[1]!).getChild("set", NS_RSM)!.getChild("before")).toBeTruthy();
    expect(queryOf(queries[1]!).getChild("set", NS_RSM)!.getChild("after")).toBeUndefined();
  });

  it("trata un anclaje más viejo que la ventana como purgado (fetch-latest directo)", async () => {
    const now = Date.parse("2026-09-26T12:00:00Z");
    const { client, setHandler } = makeClient(4, () => now);
    const queries: Element[] = [];
    setHandler(async (iq) => {
      queries.push(iq);
      const qid = queryOf(iq).attrs.queryid as string;
      client.handleStanza(mamResult(qid, "m5", "reciente"));
      return finIq({ complete: true, last: "m5" });
    });
    const result = await client.catchup({
      archive: "bot@example.org",
      anchor: "viejo",
      anchorAt: now - 10 * 24 * 60 * 60 * 1000,
      windowMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(result.degraded).toBe(true);
    expect(queries).toHaveLength(1);
    expect(queryOf(queries[0]!).getChild("set", NS_RSM)!.getChild("after")).toBeUndefined();
  });
});
