// Xmpp action definitions -- domain-level, protocol-agnostic.
//
// Ported near-verbatim from src/channels/xmpp-control/actions.ts (NanoClaw).
// Each action describes a command the XMPP control layer can expose via
// XEP-0050 ad-hoc commands or textual (/oc) fallback.
export interface ActionParam {
  name: string;
  label: string;
  type: "text-single" | "text-multi" | "list-single" | "list-multi" | "boolean" | "jid-single";
  required: boolean;
  description?: string;
  options?: { label: string; value: string }[];
  default?: string;
}

/**
 * Context passed to an action handler at execution time. Static handlers
 * ignore it; handlers that need to resolve an OpenClaw agent/session use it
 * to gate by the requesting JID and to find the right session.
 */
export interface ActionContext {
  /** Bare JID of the IQ sender (sealed by the XMPP server for c2s). */
  fromJid: string;
  /** OpenClaw accountId this XMPP connection belongs to. */
  accountId: string;
}

export interface XmppAction {
  /** Unique command node for XEP-0050 (e.g. "context", "model"). */
  node: string;
  /** Human-readable name. */
  name: string;
  /** Description shown in command lists. */
  description: string;
  /** Parameters for XEP-0004 forms. Empty array = action takes no params. */
  params: ActionParam[];
  /** Whether this action is mutating (requires confirmation / permission gate). */
  mutating: boolean;
  /**
   * Handler: receives resolved params {key: value} and an execution context.
   * Static handlers may ignore ctx (kept optional for backward-compat).
   */
  handler: (params: Record<string, string>, ctx?: ActionContext) => Promise<string> | string;
}

export interface ActionDispatcher {
  listActions(): XmppAction[];
  getAction(node: string): XmppAction | undefined;
  execute(node: string, params: Record<string, string>, ctx?: ActionContext): Promise<string>;
  registerAction(action: XmppAction): void;
  unregisterAction(node: string): void;
}

export function createActionDispatcher(actions: XmppAction[]): ActionDispatcher {
  const byNode = new Map<string, XmppAction>();
  for (const a of actions) byNode.set(a.node, a);

  return {
    listActions() {
      return [...byNode.values()];
    },
    getAction(node) {
      return byNode.get(node);
    },
    async execute(node, params, ctx) {
      const action = byNode.get(node);
      if (!action) throw new Error(`Unknown action: ${node}`);
      return action.handler(params, ctx);
    },
    registerAction(action) {
      byNode.set(action.node, action);
    },
    unregisterAction(node) {
      byNode.delete(node);
    },
  };
}
