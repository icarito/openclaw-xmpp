// Tarea 7.5/7.6 de xmpp-first-class-channel: reacciones XEP-0444.
import { describe, expect, it, afterEach } from "vitest";
import { xml } from "@xmpp/client";

import {
  NS_REACTIONS,
  REACTION_APPROVED,
  REACTION_DENIED,
  buildReactionStanza,
  reactionForApprovalText,
  resolveReactionEligibility,
} from "../reactions.js";
import { clearAllRoomStates, handleMucPresence } from "../omemo/muc-occupants.js";

const ROOM = "room@conference.example.org";

function mucPresence(nick: string, statusCodes: string[]) {
  return xml(
    "presence",
    { from: `${ROOM}/${nick}` },
    xml(
      "x",
      { xmlns: "http://jabber.org/protocol/muc#user" },
      ...statusCodes.map((code) => xml("status", { code })),
      xml("item", { affiliation: "participant", role: "participant" }),
    ),
  );
}

afterEach(() => {
  clearAllRoomStates("acct");
});

describe("XEP-0444 reacciones", () => {
  it("construye el stanza de reacción con el id del mensaje original", () => {
    const stanza = buildReactionStanza({
      to: "peer@example.org",
      type: "chat",
      messageId: "m-1",
      reactions: [REACTION_APPROVED],
      id: "oc-react-1",
    });
    expect(stanza.name).toBe("message");
    expect(stanza.attrs.to).toBe("peer@example.org");
    expect(stanza.attrs.type).toBe("chat");
    expect(stanza.attrs.id).toBe("oc-react-1");
    const reactions = stanza.getChild("reactions", NS_REACTIONS)!;
    expect(reactions.attrs.id).toBe("m-1");
    expect(reactions.getChildText("reaction")).toBe(REACTION_APPROVED);
  });

  it("habilita DM siempre y bloquea el opt-in desactivado", () => {
    expect(
      resolveReactionEligibility({ accountId: "acct", target: "peer@example.org", isGroup: false, reactionsEnabled: true }),
    ).toEqual({ allowed: true });
    expect(
      resolveReactionEligibility({ accountId: "acct", target: "peer@example.org", isGroup: false, reactionsEnabled: false })
        .allowed,
    ).toBe(false);
  });

  it("sólo permite rooms non-anonymous y registra la razón de la elisión", () => {
    handleMucPresence(mucPresence("alice", ["100"]), "acct");
    expect(
      resolveReactionEligibility({ accountId: "acct", target: ROOM, isGroup: true, reactionsEnabled: true }),
    ).toEqual({ allowed: true });
  });

  it("elide rooms semi-anonymous", () => {
    handleMucPresence(mucPresence("bob", ["170"]), "acct");
    const eligibility = resolveReactionEligibility({
      accountId: "acct",
      target: ROOM,
      isGroup: true,
      reactionsEnabled: true,
    });
    expect(eligibility.allowed).toBe(false);
    expect(eligibility.reason).toBe("semi-anonymous-room");
  });

  it("mapea el resultado de la aprobación al emoji correcto", () => {
    expect(reactionForApprovalText("✅ aprobado — ls")).toBe(REACTION_APPROVED);
    expect(reactionForApprovalText("🚫 denegado — ls")).toBe(REACTION_DENIED);
    expect(reactionForApprovalText("⏳ expirada")).toBeNull();
  });
});
