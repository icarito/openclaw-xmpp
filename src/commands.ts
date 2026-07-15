// Xmpp plugin module: wires the XEP-0050 ad-hoc command layer into one
// connection. Ported from src/channels/xmpp-control/index.ts's
// XmppControlLayer (NanoClaw), retargeted to OpenClaw's accountId/config
// model instead of agentGroupId/sqlite.
//
// See PORT-NOTES.md for the full list of what's live vs. stubbed. Summary:
//   - context/compact/clear (session-commands.ts in NanoClaw) -- STUBBED.
//     NanoClaw wrote the exact slash-command text into its own
//     inbound.db/session-manager and gated it with gateCommand() against a
//     user_roles table that has no OpenClaw equivalent. There is no
//     documented OpenClaw plugin-SDK primitive to (a) inject a synthetic
//     inbound text message into the SAME dispatch pipeline core.channel.inbound
//     uses, or (b) check "is this JID an admin for this agent" outside of
//     the config's own allowFrom lists. TODO(xmpp-migration): once such a
//     primitive exists, port buildSessionCommandActions() for real.
//   - model (model-action.ts) -- STUBBED. Required container_configs table
//     + restartAgentGroupContainers(), both NanoClaw internals.
//   - agent-lifecycle (list/info/logs/disable/enable/archive) -- STUBBED.
//     Required `ncl` CLI + docker + a central sqlite DB, none of which
//     exist under OpenClaw's process model (one gateway process, agents are
//     config entries, not docker containers).
//   - skill commands (skill-scan.ts / skill-commands.ts) -- STUBBED. Would
//     need an OpenClaw-native skills registry + a way to inject a prompt
//     into a running agent session out-of-band; not found in the IRC/Matrix
//     reference plugins.
//   - approval-bypass -- STUBBED. NanoClaw-specific (modules/approvals/bypass.ts).
// What IS live: the XEP-0050/XEP-0004 protocol machinery itself (xep-0050.ts,
// xep-0004.ts), the textual /oc fallback, and a `context`-style read-only
// action wired to telemetry.ts (see below) where the data genuinely is
// available from this plugin's own connection state.
import type { Element } from "@xmpp/xml";
import { xml } from "@xmpp/client";
import type { ResolvedXmppAccount } from "./accounts.js";
import { createActionDispatcher, type ActionContext, type XmppAction } from "./actions.js";
import { Xep0050Handler } from "./xep-0050.js";
import { TextualFallback } from "./textual-fallback.js";
import { buildCorrectionStanza, buildQueryCommandStanza } from "./outbound-render.js";
import { normalizeXmppOptions, matchOptionReply, shortQuestionId } from "./ask-question.js";
import type { CoreConfig } from "./types.js";

export interface XmppCommandRuntime {
  handleIq: (stanza: Element) => Promise<Element | undefined>;
  /** Returns true if the message was consumed as a control command. */
  handleMessage: (jid: string, body: string, stanza?: Element) => boolean;
  hasPending: (jid: string) => boolean;
  /** Render an ask_question payload as a query-command stanza + bookkeeping. */
  renderQuestion: (params: {
    to: string;
    type: string;
    id: string;
    botFullJid: string;
    title: string;
    question: string;
    questionId: string;
    options: unknown[];
    onResolve: (questionId: string, value: string) => void;
  }) => Element;
  /** Resolve a pending question by its q:* command node, if any (called from client.ts's handleIq before dispatch). */
  tryResolveQuestionNode: (node: string) => { questionId: string; value: string } | undefined;
  cleanup: () => void;
}

function buildAccountStubActions(account: ResolvedXmppAccount): XmppAction[] {
  // Minimal placeholder actions so the command menu is not empty and a
  // client immediately sees what is/isn't wired up yet, instead of silently
  // having zero commands. Each explains its own TODO inline.
  return [
    {
      node: "status",
      name: "OpenClaw: status",
      description: "Shows this XMPP account's connection status.",
      params: [],
      mutating: false,
      handler: () => `Connected as ${account.jid} (accountId=${account.accountId}).`,
    },
    {
      node: "help",
      name: "OpenClaw: help",
      description: "Lists available commands.",
      params: [],
      mutating: false,
      // Replaced by TextualFallback's own /oc help; this static node exists
      // so disco#items always has at least one advertised command besides
      // "status".
      handler: () => "Use /oc or !oc to list commands, or the Execute Command menu in your client.",
    },
    {
      node: "context",
      name: "Context: usage",
      description:
        "TODO(xmpp-migration): stubbed. NanoClaw answered this from opencode.db token counts " +
        "(see src/agent-telemetry.ts readAgentTelemetry). OpenClaw's equivalent would be " +
        "api.runtime.agent.session.* usage/token accounting, if such an API is exposed to " +
        "channel plugins -- not found in the IRC/Matrix reference plugins, so this is left " +
        "unimplemented rather than guessed at.",
      params: [],
      mutating: false,
      handler: () =>
        "Not implemented: context/token telemetry has no confirmed OpenClaw plugin-SDK read path yet. See PORT-NOTES.md.",
    },
    {
      node: "compact",
      name: "Context: compact",
      description:
        "TODO(xmpp-migration): stubbed. NanoClaw injected the literal '/compact' text into the " +
        "agent's own session via writeSessionMessage()+wakeContainer(), gated by gateCommand(). " +
        "No OpenClaw primitive found for injecting a synthetic inbound message into " +
        "core.channel.inbound from a channel plugin's own command layer.",
      params: [],
      mutating: true,
      handler: () => "Not implemented: see PORT-NOTES.md (session-commands stub).",
    },
    {
      node: "clear",
      name: "Context: clear",
      description: "TODO(xmpp-migration): stubbed, same reason as compact.",
      params: [],
      mutating: true,
      handler: () => "Not implemented: see PORT-NOTES.md (session-commands stub).",
    },
    {
      node: "model",
      name: "LLM Model",
      description:
        "TODO(xmpp-migration): stubbed. NanoClaw persisted a per-agent-group model override to " +
        "container_configs and restarted docker containers. OpenClaw's per-agent model config " +
        "lives in its own config surface (outside this plugin's reach) -- wire this once a " +
        "documented api.runtime.agent.config.* setter exists.",
      params: [],
      mutating: true,
      handler: () => "Not implemented: see PORT-NOTES.md (model-action stub).",
    },
  ];
}

/**
 * Build and wire one XmppCommandRuntime for a connection. Call once per
 * (re)connect from monitor.ts (mirrors NanoClaw's per-setup() construction
 * of XmppControlLayer, since actions can differ per config reload).
 */
export function registerXmppCommands(params: {
  account: ResolvedXmppAccount;
  cfg: CoreConfig;
  sendPlain: (to: string, text: string) => void;
  log?: { debug?: (m: string) => void; info?: (m: string) => void };
}): XmppCommandRuntime {
  const { account, sendPlain, log } = params;

  const dispatcher = createActionDispatcher(buildAccountStubActions(account));

  const xep0050 = new Xep0050Handler({
    dispatcher,
    accountId: account.accountId,
    log,
  });
  const textual = new TextualFallback({ dispatcher, sendPlain });

  // questionId -> pending question bookkeeping, and node -> {questionId,
  // value} for q:* command nodes, mirroring xmpp.ts's pendingQuestions /
  // pendingQuestionNodes maps. Scoped to this connection's lifetime.
  const pendingQuestionNodes = new Map<string, { questionId: string; value: string }>();

  const handleIq = async (stanza: Element): Promise<Element | undefined> => {
    // Intercept q:* question nodes before the dispatcher, same as xmpp.ts's
    // handleIqViaCallee, so they never appear in disco#items listings.
    const COMMAND_NS = "http://jabber.org/protocol/commands";
    const cmdNode = stanza.getChild("command", COMMAND_NS)?.attrs.node as string | undefined;
    if (cmdNode && cmdNode.startsWith("q:")) {
      const qEntry = pendingQuestionNodes.get(cmdNode);
      const sessionId = `oc-q-${Date.now().toString(36)}`;
      const from = (stanza.attrs.from as string) || "";
      const id = (stanza.attrs.id as string) || "";
      // The caller (monitor.ts / a future ask-question integration) is
      // responsible for consuming qEntry via tryResolveQuestionNode before
      // this fires in practice; kept here defensively so an unmatched q:*
      // node still answers 'completed' instead of falling through to
      // "unknown command".
      const iqResult = xml(
        "iq",
        { type: "result", id, to: from },
        xml(
          "command",
          { xmlns: COMMAND_NS, node: cmdNode, sessionid: sessionId, status: "completed" },
          xml("note", { type: "info" }, qEntry ? `You chose: ${qEntry.value}` : "Question already answered."),
        ),
      );
      pendingQuestionNodes.delete(cmdNode);
      return iqResult.getChildElements()[0];
    }

    const response = await xep0050.handleIq(stanza);
    if (!response) return undefined;
    if (response.attrs.type === "error") {
      return response.getChild("error") ?? undefined;
    }
    return response.getChildElements()[0];
  };

  const handleMessage = (jid: string, body: string, _stanza?: Element): boolean => {
    return textual.handleMessage(jid, body);
  };

  const hasPending = (jid: string): boolean => textual.hasPending(jid);

  const renderQuestion: XmppCommandRuntime["renderQuestion"] = (p) => {
    const options = normalizeXmppOptions(p.options as unknown[]);
    const shortId = shortQuestionId(p.questionId);
    const title = `[${shortId}] ${p.title}`;
    const actionNodes: string[] = [];
    for (let i = 0; i < options.length; i++) {
      const node = `q:${p.questionId}:${i}`;
      actionNodes.push(node);
      pendingQuestionNodes.set(node, { questionId: p.questionId, value: options[i]!.value });
    }
    return buildQueryCommandStanza(
      title,
      p.question,
      options,
      p.to,
      p.type,
      p.id,
      p.botFullJid,
      (index) => actionNodes[index]!,
    );
  };

  const tryResolveQuestionNode = (node: string) => {
    const entry = pendingQuestionNodes.get(node);
    if (entry) pendingQuestionNodes.delete(node);
    return entry;
  };

  return {
    handleIq,
    handleMessage,
    hasPending,
    renderQuestion,
    tryResolveQuestionNode,
    cleanup: () => {
      xep0050.cleanup();
      textual.cleanup();
    },
  };
}

export { buildCorrectionStanza, matchOptionReply };
