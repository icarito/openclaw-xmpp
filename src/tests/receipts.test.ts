// Tarea 4.3 de xmpp-first-class-channel: forma de stanza de receipts XEP-0184
// y markers XEP-0333, y ausencia en parciales efímeros con <no-store/>.
import { describe, expect, it } from "vitest";
import { xml } from "@xmpp/client";

import {
  buildChatMarker,
  buildOriginIdElement,
  buildReceiptReceived,
  buildReceiptRequest,
  extractChatMarker,
  extractReceiptId,
  hasNoStoreHint,
  hasReceiptRequest,
} from "../protocol.js";

describe("XEP-0184 receipts", () => {
  it("construye una solicitud <request/>", () => {
    const request = buildReceiptRequest();
    expect(request.name).toBe("request");
    expect(request.attrs.xmlns).toBe("urn:xmpp:receipts");
  });

  it("construye y detecta un <received/> saliente", () => {
    const stanza = buildReceiptReceived("peer@example.org", "oc-123", "chat");
    expect(stanza.name).toBe("message");
    expect(stanza.attrs.type).toBe("chat");
    expect(extractReceiptId(stanza)).toBe("oc-123");
  });

  it("detecta la solicitud en una stanza con body", () => {
    const stanza = xml(
      "message",
      { type: "chat", to: "peer@example.org", id: "oc-1" },
      xml("body", {}, "hola"),
      buildOriginIdElement("oc-1"),
      buildReceiptRequest(),
    );
    expect(hasReceiptRequest(stanza)).toBe(true);
    expect(stanza.getChild("origin-id", "urn:xmpp:sid:0")?.attrs.id).toBe("oc-1");
  });
});

describe("XEP-0333 chat markers", () => {
  it("construye un marker displayed", () => {
    const stanza = buildChatMarker("peer@example.org", "oc-1", "displayed", "chat");
    expect(extractChatMarker(stanza)).toEqual({ marker: "displayed", id: "oc-1" });
  });

  it("construye un marker received", () => {
    const stanza = buildChatMarker("room@conference.example.org", "oc-2", "received", "groupchat");
    expect(extractChatMarker(stanza)).toEqual({ marker: "received", id: "oc-2" });
  });
});

describe("parciales efímeros", () => {
  it("una edición con <no-store/> no lleva receipt request", () => {
    const stanza = xml(
      "message",
      { type: "chat", to: "peer@example.org", id: "oc-edit" },
      xml("body", {}, "parcial"),
      xml("replace", { xmlns: "urn:xmpp:message-correct:0", id: "oc-1" }),
      xml("no-store", { xmlns: "urn:xmpp:hints" }),
    );
    expect(hasNoStoreHint(stanza)).toBe(true);
    expect(hasReceiptRequest(stanza)).toBe(false);
    expect(extractChatMarker(stanza)).toBeNull();
  });
});
