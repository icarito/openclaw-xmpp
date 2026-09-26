// Tarea 2.4 de xmpp-first-class-channel: los carbons <sent/> propios se
// ignoran y los <received/> se desenvuelven (sin regresión XEP-0280).
import { describe, expect, it } from "vitest";
import { xml } from "@xmpp/client";

import { classifyCarbonStanza } from "../protocol.js";

describe("classifyCarbonStanza", () => {
  it("ignora la copia <sent/> propia", () => {
    const sent = xml(
      "message",
      { type: "chat", from: "bot@example.org/other" },
      xml("sent", { xmlns: "urn:xmpp:carbons:2" }, xml(
        "forwarded",
        { xmlns: "urn:xmpp:forward:0" },
        xml("message", { type: "chat", to: "peer@example.org" }, xml("body", {}, "hola")),
      )),
    );
    const result = classifyCarbonStanza(sent);
    expect(result.kind).toBe("sent");
  });

  it("desenvuelve un <received/> y marca isCarbonCopy", () => {
    const received = xml(
      "message",
      { type: "chat", from: "bot@example.org" },
      xml("received", { xmlns: "urn:xmpp:carbons:2" }, xml(
        "forwarded",
        { xmlns: "urn:xmpp:forward:0" },
        xml("message", { type: "chat", from: "peer@example.org" }, xml("body", {}, "hola")),
      )),
    );
    const result = classifyCarbonStanza(received);
    expect(result.kind).toBe("received");
    expect(result.isCarbonCopy).toBe(true);
    expect(result.stanza.attrs.from).toBe("peer@example.org");
  });

  it("deja pasar una stanza normal", () => {
    const plain = xml("message", { type: "chat", from: "peer@example.org" }, xml("body", {}, "hola"));
    const result = classifyCarbonStanza(plain);
    expect(result.kind).toBe("none");
    expect(result.isCarbonCopy).toBe(false);
    expect(result.stanza).toBe(plain);
  });
});
