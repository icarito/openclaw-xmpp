/**
 * OMEMO Bundle Management (XEP-0384)
 *
 * Handles key bundle publication and retrieval via PEP (XEP-0163).
 */

import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";
import { pepPublish, pepFetch } from "../pep.js";
import { isTrackedMucJid } from "./muc-occupants.js";
import type { Logger, OmemoBundle } from "./types.js";
import { toBase64, fromBase64, getElementText } from "../xml-utils.js";
import { NS_OMEMO, NS_OMEMO_BUNDLES, NS_OMEMO_V2, NS_OMEMO_BUNDLES_V2, type OmemoProtocol } from "./types.js";

// toBase64, fromBase64, getElementText imported from xml-utils.ts

// =============================================================================
// BUNDLE MANAGEMENT
// =============================================================================

/**
 * Publish our key bundle via PEP.
 *
 * The bundle contains:
 * - Identity public key
 * - Signed pre-key
 * - One-time pre-keys
 */
export async function publishBundle(
  accountId: string,
  deviceId: number,
  bundle: OmemoBundle,
  log?: Logger,
  protocol: OmemoProtocol = "legacy"
): Promise<{ ok: boolean; error?: string }> {
  try {
    const isV2 = protocol === "v2";
    // OMEMO 2 changed both the element names and the location of the
    // pre-key id.  Gajim/Dino reject a v2 bundle containing legacy
    // <preKeyPublic preKeyId=...> elements, even when the outer namespace
    // is urn:xmpp:omemo:2.
    const preKeyElements = bundle.preKeys.map((pk) =>
      xml(isV2 ? "pk" : "preKeyPublic", isV2 ? { id: String(pk.id) } : { preKeyId: String(pk.id) }, toBase64(pk.publicKey))
    );

    const payload = xml(
      "bundle",
      { xmlns: isV2 ? NS_OMEMO_V2 : NS_OMEMO },
      xml(isV2 ? "spk" : "signedPreKeyPublic", isV2 ? { id: String(bundle.signedPreKey.id) } : { signedPreKeyId: String(bundle.signedPreKey.id) }, toBase64(bundle.signedPreKey.publicKey)),
      xml(isV2 ? "spks" : "signedPreKeySignature", {}, toBase64(bundle.signedPreKey.signature)),
      xml(isV2 ? "ik" : "identityKey", {}, toBase64(bundle.identityKey)),
      xml("prekeys", {}, ...preKeyElements)
    );

    const node = `${isV2 ? NS_OMEMO_BUNDLES_V2 : NS_OMEMO_BUNDLES}:${deviceId}`;
    const result = await pepPublish(
      accountId,
      node,
      "current",
      payload,
      {
        accessModel: "open",
        persistItems: true,
        maxItems: 1,
      },
      log
    );

    if (result.ok) {
      log?.info?.(`[${accountId}] OMEMO published bundle for device ${deviceId} (${bundle.preKeys.length} pre-keys)`);
    }

    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.error?.(`[${accountId}] OMEMO failed to publish bundle: ${error}`);
    return { ok: false, error };
  }
}

/**
 * Fetch key bundle for a remote device.
 *
 * @param accountId - Our account ID
 * @param jid - Target JID
 * @param deviceId - Target device ID
 * @param log - Logger
 */
export async function fetchBundle(
  accountId: string,
  jid: string,
  deviceId: number,
  log?: Logger,
  protocol?: OmemoProtocol
): Promise<OmemoBundle | null> {
  if (jid && isTrackedMucJid(accountId, jid)) {
    log?.warn?.(`[${accountId}] OMEMO refusing bundle lookup for bare MUC ${jid}; resolve occupant real JID first`);
    return null;
  }
  try {
    const v2Node = `${NS_OMEMO_BUNDLES_V2}:${deviceId}`;
    let result = await pepFetch(accountId, jid, protocol === "legacy" ? `${NS_OMEMO_BUNDLES}:${deviceId}` : v2Node, undefined, log);
    if (!protocol && (!result.ok || !result.data?.length)) {
      result = await pepFetch(accountId, jid, `${NS_OMEMO_BUNDLES}:${deviceId}`, undefined, log);
    }

    if (!result.ok || !result.data?.length) {
      log?.warn?.(`[${accountId}] OMEMO bundle not found for ${jid}:${deviceId}`);
      return null;
    }

    const bundle = parseBundle(result.data[0].payload);
    if (bundle) {
      log?.debug?.(`[${accountId}] OMEMO fetched bundle for ${jid}:${deviceId} (${bundle.preKeys.length} pre-keys)`);
    }
    return bundle;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.warn?.(`[${accountId}] OMEMO failed to fetch bundle for ${jid}:${deviceId}: ${error}`);
    return null;
  }
}

/**
 * Parse bundle XML to OmemoBundle object
 */
function parseBundle(element: Element): OmemoBundle | null {
  try {
    if (!element || element.name !== "bundle") {
      return null;
    }

    // Identity key (legacy uses 'identityKey', OMEMO 2.0 uses 'ik')
    let ikText = element.getChildText("identityKey");
    if (!ikText) ikText = element.getChildText("ik");
    if (!ikText) return null;

    // Signed pre-key (legacy vs OMEMO 2.0 element names)
    let spk = element.getChild("signedPreKeyPublic");
    let spksText = element.getChildText("signedPreKeySignature");
    let spkIdAttr = "signedPreKeyId";

    // Fallback to OMEMO 2.0 format
    if (!spk) {
      spk = element.getChild("spk");
      spksText = element.getChildText("spks");
      spkIdAttr = "id";
    }
    if (!spk || !spksText) return null;

    const spkId = parseInt(spk.attrs?.[spkIdAttr], 10);
    const spkText = getElementText(spk);
    if (isNaN(spkId) || !spkText) return null;

    // Pre-keys (legacy uses 'preKeyPublic' with 'preKeyId', OMEMO 2.0 uses 'pk' with 'id')
    const prekeysElement = element.getChild("prekeys");
    if (!prekeysElement) return null;

    // Try legacy format first
    let preKeyElements = prekeysElement.getChildren("preKeyPublic");
    let preKeyIdAttr = "preKeyId";

    // Fallback to OMEMO 2.0 format
    if (preKeyElements.length === 0) {
      preKeyElements = prekeysElement.getChildren("pk");
      preKeyIdAttr = "id";
    }

    const preKeys: Array<{ id: number; publicKey: Uint8Array }> = [];

    for (const pk of preKeyElements) {
      const pkId = parseInt(pk.attrs?.[preKeyIdAttr], 10);
      const pkText = getElementText(pk);
      if (!isNaN(pkId) && pkText) {
        preKeys.push({
          id: pkId,
          publicKey: fromBase64(pkText),
        });
      }
    }

    return {
      identityKey: fromBase64(ikText),
      signedPreKey: {
        id: spkId,
        publicKey: fromBase64(spkText),
        signature: fromBase64(spksText),
      },
      preKeys,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Build a bundle from store data
 */
export function buildBundleFromStore(
  identityPublicKey: Uint8Array,
  signedPreKey: { id: number; publicKey: Uint8Array; signature: Uint8Array },
  preKeys: Array<{ id: number; publicKey: Uint8Array }>
): OmemoBundle {
  return {
    identityKey: identityPublicKey,
    signedPreKey,
    preKeys,
  };
}
