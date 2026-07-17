// Xmpp plugin module: wires the XEP-0050 ad-hoc command layer into one
// connection. Ported from src/channels/xmpp-control/index.ts's
// XmppControlLayer (NanoClaw), retargeted to OpenClaw's accountId/config
// model instead of agentGroupId/sqlite.
//
// See PORT-NOTES.md ("2026-07 update") for the full writeup. Summary:
//   - context/compact/clear/model -- LIVE. Wired to OpenClaw's real native
//     command registry (openclaw/plugin-sdk/command-auth-native, the same
//     module Telegram's bot-native-commands.ts uses) via
//     native-commands.ts's buildNativeCommandActions(). Invoking one of
//     these from the XEP-0050 menu builds the same synthetic slash-command
//     text Telegram builds (buildCommandTextFromArgs) and runs it through
//     this plugin's own handleXmppInbound() -- the exact pipeline a typed
//     "/compact" chat message already used. No NanoClaw-style container
//     restart or sqlite role table involved.
//   - agent-lifecycle (list/info/logs/disable/enable/archive) -- NOT
//     ported. Required `ncl` CLI + docker + a central sqlite DB tracking
//     per-agent-group containers. OpenClaw has no equivalent concept (one
//     gateway process, agents are config entries, not Docker containers);
//     see PORT-NOTES.md for why this isn't a mechanical port.
//   - skill commands (skill-scan.ts / skill-commands.ts) -- NOT ported.
//     OpenClaw's own skill system (openclaw/plugin-sdk/command-auth-native's
//     listSkillCommandsForAgents) is the native replacement in principle,
//     but wiring it fully requires passing skillCommands into
//     inbound.ts's hasControlCommand/shouldHandleTextCommands call sites,
//     which is deeper surgery than this pass covers -- see PORT-NOTES.md.
//   - approval-bypass -- NOT ported. NanoClaw-specific (modules/approvals/bypass.ts),
//     no OpenClaw equivalent.
// What IS live: the XEP-0050/XEP-0004 protocol machinery itself (xep-0050.ts,
// xep-0004.ts), the textual /oc fallback, and now the four native session
// commands via native-commands.ts.
import type { Element } from "@xmpp/xml";
import { xml } from "@xmpp/client";
import { buildModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import type { ResolvedXmppAccount } from "./accounts.js";
import { createActionDispatcher, type XmppAction } from "./actions.js";
import { buildNativeCommandActions, dispatchNativeCommandText } from "./native-commands.js";
import { Xep0050Handler } from "./xep-0050.js";
import { TextualFallback } from "./textual-fallback.js";
import { buildCorrectionStanza, buildQueryCommandStanza, buildQuickResponseStanza, resolveInlineButtonsScope } from "./outbound-render.js";
import { clearXmppCommandNodes, consumeXmppCommandNode, consumeXmppCommandResponse, registerXmppCommandNode, registerXmppCommandResponse } from "./command-node-registry.js";
import { normalizeXmppOptions, matchOptionReply, shortQuestionId } from "./ask-question.js";
import { clearXmppAccountActivity } from "./activity-registry.js";
import { getActiveXmppConnection } from "./connection-registry.js";
import { isGroupJid } from "./normalize.js";
import { nextStanzaId } from "./protocol.js";
import type { RuntimeEnv } from "./runtime-api.js";
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
  clearPending: () => void;
  cleanup: () => void;
}

function isResetOrClearCommandText(text: string): boolean {
  return /^\/(?:clear|reset|new)(?:\s|$)/i.test(text.trim());
}

function isResetOrClearActionNode(node: string): boolean {
  return node === "clear" || node === "reset" || node === "new";
}

function buildAccountActions(params: {
  account: ResolvedXmppAccount;
  cfg: CoreConfig;
  runtime: RuntimeEnv;
}): XmppAction[] {
  const { account, cfg, runtime } = params;
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
    // context/compact/clear/model -- see native-commands.ts. These call
    // into OpenClaw's real native command registry, the same one Telegram
    // uses for its slash commands.
    ...buildNativeCommandActions({ account, cfg, runtime }),
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
  runtime: RuntimeEnv;
  sendPlain: (to: string, text: string) => void;
  log?: { debug?: (m: string) => void; info?: (m: string) => void };
}): XmppCommandRuntime {
  const { account, cfg, runtime, sendPlain, log } = params;

  let clearPending = () => {
    clearXmppCommandNodes(account.accountId);
    clearXmppAccountActivity(account.accountId);
  };
  const actions = buildAccountActions({ account, cfg, runtime }).map((action) => {
    if (!isResetOrClearActionNode(action.node)) return action;
    return {
      ...action,
      handler: (formParams, ctx) => {
        clearPending();
        return action.handler(formParams, ctx);
      },
    } satisfies XmppAction;
  });
  const dispatcher = createActionDispatcher(actions);

  const xep0050 = new Xep0050Handler({
    dispatcher,
    accountId: account.accountId,
    log,
  });
  const textual = new TextualFallback({ dispatcher, sendPlain, accountId: account.accountId });

  // questionId -> pending question bookkeeping, and node -> {questionId,
  // value} for q:* command nodes, mirroring xmpp.ts's pendingQuestions /
  // pendingQuestionNodes maps. Scoped to this connection's lifetime.
  const pendingQuestionNodes = new Map<string, { questionId: string; value: string }>();

  clearPending = () => {
    pendingQuestionNodes.clear();
    clearXmppCommandNodes(account.accountId);
    clearXmppAccountActivity(account.accountId);
    xep0050.clearPending();
    textual.clearPending();
  };

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

    if (cmdNode && cmdNode.startsWith("cmd:")) {
      const from = (stanza.attrs.from as string) || "";
      const id = (stanza.attrs.id as string) || "";
      const entry = consumeXmppCommandNode(account.accountId, cmdNode);
      if (entry) {
        if (isResetOrClearCommandText(entry.commandText)) clearPending();
        dispatchNativeCommandText({
          commandText: entry.commandText,
          fromJid: from,
          account,
          cfg,
          runtime,
        }).catch((err) => {
          runtime.error?.(`xmpp command button dispatch failed: ${String(err)}`);
        });
      }
      const sessionId = `oc-cmd-${Date.now().toString(36)}`;
      const iqResult = xml(
        "iq",
        { type: "result", id, to: from },
        xml(
          "command",
          { xmlns: COMMAND_NS, node: cmdNode, sessionid: sessionId, status: "completed" },
          xml("note", { type: entry ? "info" : "warn" }, entry ? "Command submitted." : "Command expired."),
        ),
      );
      return iqResult.getChildElements()[0];
    }

    const response = await xep0050.handleIq(stanza);
    if (!response) return undefined;
    if (response.attrs.type === "error") {
      return response.getChild("error") ?? undefined;
    }
    return response.getChildElements()[0];
  };

  // Render `/models` (and `/models <provider>`) as an inline button menu
  // instead of the core's plain-text provider listing, mirroring Telegram's
  // model menu. Providers -> buttons that re-issue `/models <provider>`;
  // models -> buttons that issue `/model <provider/model>` (which the core
  // handles). Buttons are command-items (XEP-0050) + quick-responses, exactly
  // like approval cards, so a button press resolves back to the command text.
  const sendModelsMenu = async (jid: string, providerArg?: string): Promise<boolean> => {
    const connection = getActiveXmppConnection(account.accountId);
    if (!connection?.isConnected()) return false;
    const data = await buildModelsProviderData(cfg as never).catch(() => null);
    if (!data) return false;

    type MenuItem = { label: string; command: string };
    let title: string;
    let items: MenuItem[];
    if (!providerArg) {
      title = "Elige un proveedor:";
      items = (data.providers ?? []).map((p) => ({ label: p, command: `/models ${p}` }));
    } else {
      const models = Array.from(data.byProvider?.get(providerArg) ?? []);
      if (models.length === 0) return false; // let the core reply handle unknown provider
      title = `Modelos de ${providerArg} (elige para cambiar):`;
      items = models.map((m) => ({ label: data.modelNames?.get(m) ?? m, command: `/model ${providerArg}/${m}` }));
    }
    if (items.length === 0) return false;

    const type = isGroupJid(jid, account.mucDomain) ? "groupchat" : "chat";
    const id = nextStanzaId();
    const botFullJid = `${account.jid}/${account.resource}`;
    const controls = items.map((it) => ({ label: it.label, value: it.command }));
    const commandItems = items.map((it, index) => {
      const node = `cmd:${id}:${index}`;
      registerXmppCommandNode({ accountId: account.accountId, node, commandText: it.command });
      for (const responseText of [String(index + 1), it.label, it.command]) {
        registerXmppCommandResponse({ accountId: account.accountId, jid, responseText, commandText: it.command });
      }
      return { jid: botFullJid, node, label: it.label };
    });

    await connection.send(
      buildQuickResponseStanza(title, "", controls, jid, type, id, { commandItems }),
    );
    return true;
  };

  const handleMessage = (jid: string, body: string, _stanza?: Element): boolean => {
    if (isResetOrClearCommandText(body)) clearPending();

    const responseEntry = consumeXmppCommandResponse(account.accountId, jid, body);
    if (responseEntry) {
      if (isResetOrClearCommandText(responseEntry.commandText)) clearPending();
      dispatchNativeCommandText({
        commandText: responseEntry.commandText,
        fromJid: jid,
        account,
        cfg,
        runtime,
      }).catch((err) => {
        runtime.error?.(`xmpp quick response dispatch failed: ${String(err)}`);
      });
      return true;
    }

    // `/models` (plural) -> inline provider/model menu. `/model` (singular,
    // the switch command) is intentionally NOT intercepted; it falls through
    // to the core dispatch. Gated on inline-buttons being enabled for this
    // account (same capability the rest of the button UI honors).
    const modelsMatch = body.trim().match(/^\/models(?:\s+(\S+))?\s*$/i);
    if (modelsMatch && resolveInlineButtonsScope(account.config.capabilities) !== "off") {
      sendModelsMenu(jid, modelsMatch[1]).then((handled) => {
        if (!handled) {
          // Fall back to the normal command flow (plain-text listing).
          dispatchNativeCommandText({ commandText: body.trim(), fromJid: jid, account, cfg, runtime }).catch(
            (err) => runtime.error?.(`xmpp /models fallback dispatch failed: ${String(err)}`),
          );
        }
      }).catch((err) => runtime.error?.(`xmpp /models menu failed: ${String(err)}`));
      return true;
    }

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
    clearPending,
    cleanup: () => {
      xep0050.cleanup();
      textual.cleanup();
    },
  };
}

export { buildCorrectionStanza, matchOptionReply };
