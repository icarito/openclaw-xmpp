import { beforeEach, describe, expect, it, vi } from "vitest";
import { xml } from "@xmpp/client";
import { getActiveXmppConnection } from "../connection-registry.js";
import { fetchMucAffiliatedJids, mergeMucRecipientJids } from "../omemo/muc-members.js";

vi.mock("../connection-registry.js", () => ({ getActiveXmppConnection: vi.fn() }));

const NS = "http://jabber.org/protocol/muc#admin";
const room = "engineering@conference.example.org";
const self = "operator@example.org";

describe("MUC OMEMO recipient roster", () => {
  beforeEach(() => vi.resetAllMocks());

  it("includes an offline owner alongside online members", async () => {
    const iqRequest = vi.fn(async (iq) => {
      expect(iq.attrs.type).toBe("get");
      expect(iq.attrs.to).toBe(room);
      const affiliation = iq.getChild("query", NS)!.getChild("item")!.attrs.affiliation;
      const jids = affiliation === "member" ? [self, "jclema@example.org"]
        : affiliation === "owner" ? ["sebastian@example.org"] : [];
      return xml("iq", { type: "result" }, xml("query", { xmlns: NS },
        ...jids.map((jid) => xml("item", { affiliation, jid }))));
    });
    vi.mocked(getActiveXmppConnection).mockReturnValue({ isConnected: () => true, iqRequest } as never);

    const affiliated = await fetchMucAffiliatedJids("operator", room);
    const recipients = mergeMucRecipientJids(affiliated, ["jclema@example.org"], self);
    expect(recipients).toEqual(["jclema@example.org", "sebastian@example.org"]);
    expect(iqRequest).toHaveBeenCalledTimes(3);
  });

  it("rejects the send if the owner list cannot be read", async () => {
    const iqRequest = vi.fn(async (iq) => {
      const affiliation = iq.getChild("query", NS)!.getChild("item")!.attrs.affiliation;
      if (affiliation === "owner") throw new Error("forbidden");
      return xml("iq", { type: "result" }, xml("query", { xmlns: NS }));
    });
    vi.mocked(getActiveXmppConnection).mockReturnValue({ isConnected: () => true, iqRequest } as never);
    await expect(fetchMucAffiliatedJids("operator", room)).rejects.toThrow("owner list unavailable");
  });

  it("rejects malformed affiliation JIDs instead of silently omitting them", async () => {
    const iqRequest = vi.fn(async (iq) => {
      const affiliation = iq.getChild("query", NS)!.getChild("item")!.attrs.affiliation;
      return xml("iq", { type: "result" }, xml("query", { xmlns: NS },
        ...(affiliation === "owner" ? [xml("item", { affiliation })] : [])));
    });
    vi.mocked(getActiveXmppConnection).mockReturnValue({ isConnected: () => true, iqRequest } as never);
    await expect(fetchMucAffiliatedJids("operator", room)).rejects.toThrow("invalid owner JID");
  });
});
