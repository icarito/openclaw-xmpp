/** Fetch the complete OMEMO recipient roster for a non-anonymous MUC. */
import { xml } from "@xmpp/client";
import { getActiveXmppConnection } from "../connection-registry.js";
import { bareJid } from "../normalize.js";

const NS_MUC_ADMIN = "http://jabber.org/protocol/muc#admin";
const AFFILIATIONS = ["member", "admin", "owner"] as const;
let requestCounter = 0;

export async function fetchMucAffiliatedJids(accountId: string, roomJid: string): Promise<string[]> {
  const connection = getActiveXmppConnection(accountId);
  if (!connection?.isConnected()) {
    throw new Error(`Cannot determine OMEMO recipients for ${roomJid}: XMPP is disconnected`);
  }

  // XEP-0384 §5.8.1 requires all three lists, including offline owners.
  // Query on each send so affiliation changes cannot leave a stale recipient.
  const lists = await Promise.all(AFFILIATIONS.map(async (affiliation) => {
    const iq = xml("iq", {
      type: "get",
      to: roomJid,
      id: `muc-omemo-${Date.now().toString(36)}-${++requestCounter}`,
    }, xml("query", { xmlns: NS_MUC_ADMIN }, xml("item", { affiliation })));
    let response;
    try {
      response = await connection.iqRequest(iq, 10_000);
    } catch {
      throw new Error(`Cannot determine OMEMO recipients for ${roomJid}: ${affiliation} list unavailable`);
    }
    if (response.is("iq") && response.attrs.type !== "result") {
      throw new Error(`Cannot determine OMEMO recipients for ${roomJid}: ${affiliation} list rejected`);
    }
    const query = response.is("query", NS_MUC_ADMIN)
      ? response : response.getChild("query", NS_MUC_ADMIN);
    if (!query) {
      throw new Error(`Cannot determine OMEMO recipients for ${roomJid}: ${affiliation} list missing`);
    }
    return query.getChildren("item").map((item) => {
      const jid = bareJid(String(item.attrs.jid ?? "")).toLowerCase();
      if (!/^[^@\s/]+@[^@\s/]+$/.test(jid) || jid === bareJid(roomJid)) {
        throw new Error(`Cannot determine OMEMO recipients for ${roomJid}: invalid ${affiliation} JID`);
      }
      return jid;
    });
  }));
  return [...new Set(lists.flat())];
}

export function mergeMucRecipientJids(
  affiliatedJids: readonly string[],
  occupantJids: readonly string[],
  selfJid: string,
): string[] {
  const self = bareJid(selfJid).toLowerCase();
  return [...new Set([...affiliatedJids, ...occupantJids]
    .map((jid) => bareJid(jid).toLowerCase()))].filter((jid) => jid !== self);
}
