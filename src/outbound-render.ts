// Xmpp plugin module implements outbound stanza rendering for interactive
// content (ask_question, cards, corrections).
//
// Ported from src/channels/xmpp-control/outbound-render.ts (NanoClaw).
// Cheogram Android does not support XEP-0439 quick responses; it instead
// renders inline <query xmlns="disco#items" node="commands"><item/></query>
// as buttons. Each <item> becomes a button; on press, Cheogram sends an
// XEP-0050 execute IQ to the item's `jid`/`node`.
import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";

const DISCO_ITEMS_NS = "http://jabber.org/protocol/disco#items";
const COMMAND_NS = "http://jabber.org/protocol/commands";
const QR_NS = "urn:xmpp:quick-response:0";

export type XmppInlineButtonsScope = "off" | "dm" | "group" | "all" | "allowlist";

/**
 * Resolve the configured inline-buttons scope from an account's `capabilities`.
 * Accepts both the legacy array form (`["inlineButtons"]` => "all") and the
 * object form (`{ inlineButtons: "dm" | ... }`). Anything unrecognized => "off".
 * Pure so both the send path (per-message gating) and channel.ts (agent
 * capability advertisement) share one source of truth.
 */
export function resolveInlineButtonsScope(capabilities: unknown): XmppInlineButtonsScope {
  if (Array.isArray(capabilities)) {
    return capabilities.some((entry) => String(entry).trim().toLowerCase() === "inlinebuttons")
      ? "all"
      : "off";
  }
  if (capabilities && typeof capabilities === "object") {
    const raw = String((capabilities as { inlineButtons?: unknown }).inlineButtons ?? "")
      .trim()
      .toLowerCase();
    if (raw === "dm" || raw === "group" || raw === "all" || raw === "allowlist") {
      return raw;
    }
  }
  return "off";
}

/**
 * Build a `<message>` stanza with an inline `<query>` disco#items element
 * that Cheogram Android renders as interactive buttons. Also includes a
 * text `<body>` with numbered options for clients that don't render inline
 * disco#items (graceful degradation).
 */
export function buildQueryCommandStanza(
  title: string,
  question: string,
  options: Array<{ label: string; value: string }>,
  to: string,
  type: string,
  id: string,
  botFullJid: string,
  nodeForOption: (index: number, option: { label: string; value: string }) => string,
): Element {
  const lines = options.map((o, i) => `${i + 1}) ${o.label}`).join("\n");
  const bodyText = `${title}${question ? `\n\n${question}` : ""}\n\n${lines}`;

  const items = options.map((o, i) => {
    const shortName = o.label.length > 20 ? o.label.slice(0, 18) + "…" : o.label;
    return xml("item", { jid: botFullJid, node: nodeForOption(i, o), name: shortName });
  });

  const query = xml("query", { xmlns: DISCO_ITEMS_NS, node: COMMAND_NS }, ...items);
  return xml("message", { type, to, id }, xml("body", {}, bodyText), query);
}

export function buildQuickResponseStanza(
  title: string,
  body: string,
  options: Array<{ label: string; value: string; style?: string }>,
  to: string,
  type: string,
  id: string,
  metadata?: {
    expiresAtMs?: number;
    commandItems?: Array<{ jid: string; node: string; label: string; style?: string }>;
  },
): Element {
  const cleanTitle = title.trim();
  const cleanBody = body.trim();
  const bodyText = cleanBody.toLowerCase().startsWith(cleanTitle.toLowerCase())
    ? cleanBody
    : `${cleanTitle}${cleanBody ? `\n\n${cleanBody}` : ""}`;
  const quickResponseReference = xml(
    "reference",
    { xmlns: QR_NS, type: "action" },
    ...options.map((o) => xml("body", {}, o.label)),
  );
  const quickResponseAttrs = (o: { label: string; value: string; style?: string }) => ({
    xmlns: QR_NS,
    value: o.value,
    label: o.label,
    // Non-standard hint read by color-capable clients (gtk-llm-chat); ignored
    // by everyone else. One of primary|secondary|success|danger.
    ...(o.style ? { style: o.style } : {}),
    ...(typeof metadata?.expiresAtMs === "number" ? { "expires-at-ms": String(metadata.expiresAtMs) } : {}),
  });
  const quickResponses = options.map((o) => xml("response", quickResponseAttrs(o)));
  const queryItems = metadata?.commandItems?.map((item) => {
    const shortName = item.label.length > 20 ? item.label.slice(0, 18) + "..." : item.label;
    return xml("item", {
      jid: item.jid,
      node: item.node,
      name: shortName,
      ...(item.style ? { style: item.style } : {}),
      // Mismo expiry que los <response>: un command-item se contesta por IQ y
      // no deja mensaje saliente, así que el cliente no puede deducir "ya lo
      // respondí" por texto. Sin este dato, una tarjeta restaurada del cache
      // revive una y otra vez si la corrección XEP-0308 no llegó.
      ...(typeof metadata?.expiresAtMs === "number"
        ? { "expires-at-ms": String(metadata.expiresAtMs) }
        : {}),
    });
  }) ?? [];
  const query = queryItems.length > 0
    ? [xml("query", { xmlns: DISCO_ITEMS_NS, node: COMMAND_NS }, ...queryItems)]
    : [];
  return xml("message", { type, to, id }, xml("body", {}, bodyText), quickResponseReference, ...quickResponses, ...query);
}

/**
 * XEP-0308 correction stanza: retires an answered question so its buttons
 * vanish in LMC-capable clients and it can no longer be answered.
 */
export function buildCorrectionStanza(to: string, type: string, body: string, replaceId: string, newId?: string): Element {
  const id = newId ?? `oc-corr-${Date.now().toString(36)}`;
  return xml(
    "message",
    { type, to, id },
    xml("body", {}, body),
    xml("replace", { xmlns: "urn:xmpp:message-correct:0", id: replaceId }),
  );
}

/**
 * Render a card (title/description/children/actions) as plain text.
 * XEP-0004 forms embedded directly in a <message/> stanza have no defined
 * client behavior outside a wrapper protocol like ad-hoc commands, and
 * mainstream clients don't look for jabber:x:data in plain messages at all.
 */
export function buildCardStanza(card: Record<string, unknown>, to: string, type: string, id: string): Element | null {
  const parts: string[] = [];
  if (typeof card.title === "string" && card.title) parts.push(card.title);
  if (typeof card.description === "string" && card.description) parts.push(card.description);
  if (Array.isArray(card.children)) {
    for (const ch of card.children) {
      if (typeof ch === "string" && ch) parts.push(ch);
      else if (ch && typeof ch === "object" && typeof (ch as Record<string, unknown>).text === "string") {
        parts.push((ch as Record<string, string>).text);
      }
    }
  }
  if (Array.isArray(card.actions)) {
    for (const a of card.actions as Array<Record<string, unknown>>) {
      if (typeof a.url === "string" && a.url && typeof a.label === "string") {
        parts.push(`${a.label}: ${a.url}`);
      }
    }
  }
  const bodyText = parts.join("\n\n");
  if (!bodyText) return null;
  return xml("message", { type, to, id }, xml("body", {}, bodyText));
}
