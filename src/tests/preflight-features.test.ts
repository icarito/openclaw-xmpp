// Tarea 1.3 de xmpp-first-class-channel: preflight disco de MAM v2.
import { describe, expect, it } from "vitest";
import { xml } from "@xmpp/client";

import {
  buildDiscoInfoIq,
  clearXmppFeaturePreflight,
  describeXmppFeaturePreflight,
  discoInfoHasMam2,
  preflightXmppFeatures,
} from "../preflight-features.js";
import type { ResolvedXmppAccount } from "../accounts.js";

function account(): ResolvedXmppAccount {
  return {
    accountId: "test-account",
    enabled: true,
    configured: true,
    jid: "bot@example.org",
    service: "xmpp://127.0.0.1:5222",
    resource: "openclaw",
    mucDomain: "conference.example.org",
    mucRooms: [],
    password: "secret",
    passwordSource: "config",
    config: { jid: "bot@example.org", service: "xmpp://127.0.0.1:5222", resource: "openclaw" },
  };
}

function disco(hasMam: boolean) {
  return xml(
    "query",
    { xmlns: "http://jabber.org/protocol/disco#info" },
    xml("feature", { var: "http://jabber.org/protocol/disco#info" }),
    ...(hasMam ? [xml("feature", { var: "urn:xmpp:mam:2" })] : []),
  );
}

describe("preflight-features", () => {
  it("detecta urn:xmpp:mam:2 en disco#info", () => {
    expect(discoInfoHasMam2(disco(true))).toBe(true);
    expect(discoInfoHasMam2(disco(false))).toBe(false);
    expect(discoInfoHasMam2(undefined)).toBe(false);
  });

  it("construye el IQ disco#info con el target correcto", () => {
    const iq = buildDiscoInfoIq("conference.example.org");
    expect(iq.attrs.type).toBe("get");
    expect(iq.attrs.to).toBe("conference.example.org");
    expect(iq.getChild("query", "http://jabber.org/protocol/disco#info")).toBeTruthy();
  });

  it("cachea server y MUC domain y lo expone para status", () => {
    clearXmppFeaturePreflight("test-account");
    return preflightXmppFeatures({
      account: account(),
      discoInfo: async (jid) => disco(jid.startsWith("conference")),
    }).then((result) => {
      expect(result.server?.mam2).toBe(false);
      expect(result.muc?.mam2).toBe(true);
      expect(describeXmppFeaturePreflight("test-account")).toContain("MAM v2");
      expect(describeXmppFeaturePreflight("test-account")).toContain("conference.example.org");
    });
  });

  it("marca no alcanzable sin lanzar (fail-closed)", async () => {
    clearXmppFeaturePreflight("test-account");
    const result = await preflightXmppFeatures({
      account: account(),
      discoInfo: async () => { throw new Error("timeout"); },
    });
    expect(result.server?.reachable).toBe(false);
    expect(result.muc?.reachable).toBe(false);
  });
});
