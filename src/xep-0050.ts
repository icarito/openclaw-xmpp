// Xmpp plugin module implements XEP-0050 Ad-Hoc Commands.
//
// Ported from src/channels/xmpp-control/xep-0050.ts (NanoClaw), retargeted
// from agentGroupId to OpenClaw's accountId. Implements the server side of
// ad-hoc commands: disco#items listing, disco#info for each command, and
// the multi-stage execute flow (form request -> submit -> result/completed).
//
// This has NO OpenClaw-native equivalent -- there is no `api.registerCommand`
// or similar primitive in the plugin SDK (confirmed against both the IRC and
// Matrix reference plugins: they only expose text-command gating via
// core.channel.commands.shouldHandleTextCommands / core.channel.text.hasControlCommand,
// which parse the message BODY, not a protocol-level IQ mechanism). XEP-0050
// is therefore implemented entirely inside this plugin's own IQ-handling
// layer (wired through client.ts's handleIq hook), bypassing OpenClaw's
// command/dispatch APIs altogether.
import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";
import type { ActionDispatcher, XmppAction } from "./actions.js";
import {
  buildRequestForm,
  parseSubmitForm,
  isFormSubmit,
  isFormCancel,
  type FormField,
} from "./xep-0004.js";

const COMMAND_NS = "http://jabber.org/protocol/commands";
const DISCO_INFO_NS = "http://jabber.org/protocol/disco#info";
const DISCO_ITEMS_NS = "http://jabber.org/protocol/disco#items";
const OPENCLAW_TELEMETRY_NOTIFY_NS = "urn:openclaw:telemetry:0+notify";

// Must mirror CAPS_IDENTITY/CAPS_FEATURES in client.ts's presence caps
// builder -- the ver hash a client caches from <c/> in presence is only
// valid if disco#info for that node answers with the exact same identity
// and feature set.
export const CAPS_NODE = "https://github.com/openclaw/openclaw";
export const CAPS_IDENTITY = { category: "automation", type: "command-list", name: "OpenClaw" };
export const CAPS_FEATURES = [
  COMMAND_NS,
  DISCO_INFO_NS,
  DISCO_ITEMS_NS,
  OPENCLAW_TELEMETRY_NOTIFY_NS,
].sort();

const XEP0004_COMMAND_FORMS_ENABLED = true;

interface PendingSession {
  node: string;
  jid: string;
}

export interface Xep0050HandlerOptions {
  dispatcher: ActionDispatcher;
  onActionComplete?: (node: string, result: string, fromJid: string) => void;
  /** OpenClaw accountId this handler's XMPP connection belongs to. */
  accountId: string;
  log?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
  };
}

export class Xep0050Handler {
  private dispatcher: ActionDispatcher;
  private pending: Map<string, PendingSession> = new Map();
  private onActionComplete?: (node: string, result: string, fromJid: string) => void;
  private accountId: string;
  private log: { debug?: (m: string) => void; info?: (m: string) => void };

  constructor(options: Xep0050HandlerOptions) {
    this.dispatcher = options.dispatcher;
    this.onActionComplete = options.onActionComplete;
    this.accountId = options.accountId;
    this.log = options.log ?? {};
  }

  private sessionKey(from: string, id: string): string {
    return `${from}::${id}`;
  }

  async handleIq(iq: Element): Promise<Element | null> {
    const type = iq.attrs.type as string;
    if (type !== "get" && type !== "set") return null;

    const from = (iq.attrs.from as string) || "";
    this.log.debug?.(`XEP-0050 IQ received type=${type} from=${from}`);

    const command = iq.getChild("command", COMMAND_NS);
    if (command) {
      this.log.info?.(`XEP-0050 command node=${String(command.attrs.node)} action=${String(command.attrs.action)} from=${from}`);
      return await this.handleCommand(iq, command);
    }

    const discoItems = iq.getChild("query", DISCO_ITEMS_NS);
    if (discoItems) {
      return this.handleDiscoItems(iq);
    }

    const discoInfo = iq.getChild("query", DISCO_INFO_NS);
    if (discoInfo) {
      return this.handleDiscoInfo(iq);
    }

    return null;
  }

  private handleDiscoItems(iq: Element): Element {
    const from = (iq.attrs.from as string) || "";
    const to = (iq.attrs.to as string) || "";
    const id = (iq.attrs.id as string) || "";
    const node = iq.getChild("query", DISCO_ITEMS_NS)?.attrs.node as string | undefined;

    const actions = this.dispatcher.listActions();
    const items = actions.map((a) => xml("item", { jid: to, node: a.node, name: a.name }));

    if (!node || node === COMMAND_NS) {
      return xml(
        "iq",
        { type: "result", id, to: from },
        xml("query", { xmlns: DISCO_ITEMS_NS, ...(node ? { node } : {}) }, ...items),
      );
    }

    return xml("iq", { type: "result", id, to: from }, xml("query", { xmlns: DISCO_ITEMS_NS, node }));
  }

  private handleDiscoInfo(iq: Element): Element {
    const from = (iq.attrs.from as string) || "";
    const id = (iq.attrs.id as string) || "";
    const node = iq.getChild("query", DISCO_INFO_NS)?.attrs.node as string | undefined;

    if (!node || node.startsWith(`${CAPS_NODE}#`)) {
      return xml(
        "iq",
        { type: "result", id, to: from },
        xml(
          "query",
          { xmlns: DISCO_INFO_NS, ...(node ? { node } : {}) },
          xml("identity", CAPS_IDENTITY),
          ...CAPS_FEATURES.map((f) => xml("feature", { var: f })),
        ),
      );
    }

    const action = this.dispatcher.getAction(node);
    if (!action) {
      return xml(
        "iq",
        { type: "error", id, to: from },
        xml("query", { xmlns: DISCO_INFO_NS, node }),
        xml(
          "error",
          { type: "cancel", code: "404" },
          xml("item-not-found", { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" }),
        ),
      );
    }

    return xml(
      "iq",
      { type: "result", id, to: from },
      xml(
        "query",
        { xmlns: DISCO_INFO_NS, node },
        xml("identity", { category: "automation", type: "command-node", name: action.name }),
        xml("feature", { var: COMMAND_NS }),
        ...(XEP0004_COMMAND_FORMS_ENABLED && action.params.length > 0
          ? [xml("feature", { var: "jabber:x:data" })]
          : []),
      ),
    );
  }

  private async handleCommand(iq: Element, command: Element): Promise<Element> {
    const from = (iq.attrs.from as string) || "";
    const id = (iq.attrs.id as string) || "";
    const node = command.attrs.node as string | undefined;
    const action = (command.attrs.action as string) || "execute";
    const sessionid = command.attrs.sessionid as string | undefined;

    if (!node) {
      return this.iqError(from, id, "bad-request");
    }

    const cmdAction = this.dispatcher.getAction(node);
    if (!cmdAction) {
      return this.commandError(from, id, node, "item-not-found");
    }

    if (action === "cancel") {
      if (sessionid) this.pending.delete(this.sessionKey(from, sessionid));
      return xml(
        "iq",
        { type: "result", id, to: from },
        xml("command", { xmlns: COMMAND_NS, node, sessionid, status: "canceled" }),
      );
    }

    if (action === "execute") {
      const newSessionId = `oc-cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      if (cmdAction.params.length === 0) {
        this.pending.set(this.sessionKey(from, newSessionId), { node, jid: from });
        return await this.executeNoParams(from, id, node, newSessionId, cmdAction);
      }

      if (!XEP0004_COMMAND_FORMS_ENABLED) {
        return this.commandCompleted(
          from,
          id,
          node,
          newSessionId,
          `${cmdAction.name} needs parameters, but data forms are disabled. Use the textual fallback: /oc ${node}`,
        );
      }

      this.pending.set(this.sessionKey(from, newSessionId), { node, jid: from });
      return this.presentForm(from, id, node, newSessionId, cmdAction);
    }

    if (!sessionid) {
      return this.commandError(from, id, node, "bad-request", "Missing sessionid");
    }

    const pending = this.pending.get(this.sessionKey(from, sessionid));
    if (!pending || pending.node !== node) {
      return this.commandError(from, id, node, "item-not-found");
    }

    if (isFormCancel(command)) {
      this.pending.delete(this.sessionKey(from, sessionid));
      return xml(
        "iq",
        { type: "result", id, to: from },
        xml("command", { xmlns: COMMAND_NS, node, sessionid, status: "canceled" }),
      );
    }

    if (!isFormSubmit(command)) {
      return this.presentForm(from, id, node, sessionid, cmdAction);
    }

    const xElement = command.getChild("x", "jabber:x:data");
    if (!xElement) {
      return this.commandError(from, id, node, "bad-request", "Missing data form");
    }

    const params = parseSubmitForm(xElement);
    return await this.executeAndComplete(from, id, node, sessionid, cmdAction, params);
  }

  private presentForm(from: string, id: string, node: string, sessionid: string, action: XmppAction): Element {
    const fields: FormField[] = action.params.map((p) => ({
      var: p.name,
      type: mapParamType(p.type),
      label: p.label,
      desc: p.description,
      required: p.required,
      options: p.options,
      value: p.default,
    }));

    const form = buildRequestForm(action.name, [action.description], fields);

    return xml(
      "iq",
      { type: "result", id, to: from },
      xml("command", { xmlns: COMMAND_NS, node, sessionid, status: "executing" }, form),
    );
  }

  private async executeNoParams(
    from: string,
    id: string,
    node: string,
    sessionid: string,
    action: XmppAction,
  ): Promise<Element> {
    try {
      const result = await action.handler({}, { fromJid: from, accountId: this.accountId });
      this.onActionComplete?.(node, result, from);
      return this.commandCompleted(from, id, node, sessionid, result);
    } catch (err) {
      if (String((err as Error)?.message) === "not-authorized") {
        return this.commandError(from, id, node, "forbidden", "Not authorized to run this command.");
      }
      return this.commandError(from, id, node, "internal-server-error", String(err));
    } finally {
      this.pending.delete(this.sessionKey(from, sessionid));
    }
  }

  private async executeAndComplete(
    from: string,
    id: string,
    node: string,
    sessionid: string,
    action: XmppAction,
    params: Record<string, string>,
  ): Promise<Element> {
    try {
      const missing: string[] = [];
      for (const p of action.params) {
        if (p.required && (!(p.name in params) || !params[p.name]?.trim())) {
          missing.push(p.label);
        }
      }
      if (missing.length > 0) {
        return this.commandError(from, id, node, "bad-request", `Required parameters: ${missing.join(", ")}`);
      }

      const result = await action.handler(params, { fromJid: from, accountId: this.accountId });
      this.onActionComplete?.(node, result, from);
      return this.commandCompleted(from, id, node, sessionid, typeof result === "string" ? result : "");
    } catch (err) {
      if (String((err as Error)?.message) === "not-authorized") {
        return this.commandError(from, id, node, "forbidden", "Not authorized to run this command.");
      }
      return this.commandError(from, id, node, "internal-server-error", String(err));
    } finally {
      this.pending.delete(this.sessionKey(from, sessionid));
    }
  }

  private commandCompleted(from: string, id: string, node: string, sessionid: string, text: string): Element {
    return xml(
      "iq",
      { type: "result", id, to: from },
      xml("command", { xmlns: COMMAND_NS, node, sessionid, status: "completed" }, xml("note", { type: "info" }, text)),
    );
  }

  private commandError(from: string, id: string, node: string, errorType: string, text?: string): Element {
    const cmdChildren: Element[] = [];
    if (text) cmdChildren.push(xml("note", { type: "error" }, text));

    return xml(
      "iq",
      { type: "error", id, to: from },
      xml("command", { xmlns: COMMAND_NS, node, status: "canceled" }, ...cmdChildren),
      xml(
        "error",
        errorType === "forbidden"
          ? { type: "auth", code: "403" }
          : { type: "cancel", code: errorType === "item-not-found" ? "404" : "400" },
        xml(`${errorType}`, { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" }),
      ),
    );
  }

  private iqError(from: string, id: string, errorType: string): Element {
    return xml(
      "iq",
      { type: "error", id, to: from },
      xml("error", { type: "modify", code: "400" }, xml(`${errorType}`, { xmlns: "urn:ietf:params:xml:ns:xmpp-stanzas" })),
    );
  }

  cleanup(maxAgeMs: number = 300_000): void {
    const now = Date.now();
    for (const [key, _session] of this.pending) {
      const tsMatch = key.match(/oc-cmd-(\w+)/);
      if (tsMatch) {
        const ts = parseInt(tsMatch[1]!, 36);
        if (now - ts > maxAgeMs) {
          this.pending.delete(key);
        }
      }
    }
  }
}

function mapParamType(t: string): FormField["type"] {
  switch (t) {
    case "text-single":
      return "text-single";
    case "text-multi":
      return "text-multi";
    case "list-single":
      return "list-single";
    case "list-multi":
      return "list-multi";
    case "boolean":
      return "boolean";
    case "jid-single":
      return "jid-single";
    default:
      return "text-single";
  }
}
