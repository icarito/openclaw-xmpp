import { describe, expect, it } from "vitest";
import { isolateProbeAccount } from "../probe.js";
import type { ResolvedXmppAccount } from "../accounts.js";

describe("XMPP probe isolation", () => {
  it("uses a unique resource and does not join the monitored rooms", () => {
    const account = {
      accountId: "operator",
      resource: "openclaw-operator",
      mucRooms: ["engineering@conference.example.org"],
      config: { resource: "openclaw-operator", mucRooms: ["engineering@conference.example.org"] },
    } as ResolvedXmppAccount;
    const first = isolateProbeAccount(account);
    const second = isolateProbeAccount(account);
    expect(first.resource).not.toBe(account.resource);
    expect(second.resource).not.toBe(first.resource);
    expect(first.mucRooms).toEqual([]);
    expect(first.config.mucRooms).toEqual([]);
    expect(account.mucRooms).toEqual(["engineering@conference.example.org"]);
  });
});
