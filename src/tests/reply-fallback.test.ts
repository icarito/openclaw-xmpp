// Tarea 7.4/7.6 de xmpp-first-class-channel: XEP-0461 reply + XEP-0428 fallback.
import { describe, expect, it } from "vitest";

import {
  NS_FALLBACK,
  NS_REPLY,
  buildReplyElements,
  clearInboundReplyContext,
  getInboundReplyContext,
  rememberInboundReplyContext,
} from "../reply-context.js";

describe("XEP-0461 reply saliente", () => {
  it("construye <reply/> con el id y remitente originales y <fallback/> con el texto citado", () => {
    const [reply, fallback] = buildReplyElements({
      id: "inbound-1",
      to: "peer@example.org/resource",
      text: "mensaje original",
    });
    expect(reply!.name).toBe("reply");
    expect(reply!.attrs.xmlns).toBe(NS_REPLY);
    expect(reply!.attrs.id).toBe("inbound-1");
    expect(reply!.attrs.to).toBe("peer@example.org/resource");

    expect(fallback!.name).toBe("fallback");
    expect(fallback!.attrs.xmlns).toBe(NS_FALLBACK);
    expect(fallback!.attrs.for).toBe(NS_REPLY);
    expect(fallback!.getChildText("body")).toBe("mensaje original");
  });

  it("omite el body del fallback si no hay texto original", () => {
    const [, fallback] = buildReplyElements({ id: "inbound-2", to: "peer@example.org" });
    expect(fallback!.getChild("body")).toBeUndefined();
  });

  it("registra y recupera el contexto por cuenta y mensaje", () => {
    clearInboundReplyContext("acct");
    rememberInboundReplyContext("acct", "m1", { to: "peer@example.org", text: "hola" });
    const ctx = getInboundReplyContext("acct", "m1");
    expect(ctx?.to).toBe("peer@example.org");
    expect(ctx?.text).toBe("hola");
    expect(getInboundReplyContext("acct", "otro")).toBeUndefined();
    clearInboundReplyContext("acct");
    expect(getInboundReplyContext("acct", "m1")).toBeUndefined();
  });

  it("descarta un contexto expirado", () => {
    clearInboundReplyContext("acct2");
    const now = 1_000_000;
    rememberInboundReplyContext("acct2", "m2", { to: "peer@example.org", text: "x" }, now);
    expect(getInboundReplyContext("acct2", "m2", now + 1)).toBeTruthy();
    expect(getInboundReplyContext("acct2", "m2", now + 16 * 60 * 1000)).toBeUndefined();
  });
});
