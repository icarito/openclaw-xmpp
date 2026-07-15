// Xmpp plugin module implements textual fallback for XMPP control commands.
//
// Ported near-verbatim from src/channels/xmpp-control/textual-fallback.ts
// (NanoClaw). Works in ANY XMPP client by rendering commands as plain text
// with numbered options -- the universal safety net for clients that don't
// support XEP-0004 forms.
import type { ActionDispatcher, XmppAction } from "./actions.js";

const OC_PREFIXES = ["/oc", "!oc"];

interface PendingTextualCommand {
  node: string;
  jid: string;
  collected: Map<string, string>;
  remaining: {
    name: string;
    label: string;
    type: string;
    options?: { label: string; value: string }[];
    required: boolean;
  }[];
  currentParamIdx: number;
}

export interface TextualFallbackOptions {
  dispatcher: ActionDispatcher;
  sendPlain: (to: string, text: string) => void;
}

export class TextualFallback {
  private dispatcher: ActionDispatcher;
  private sendPlain: (to: string, text: string) => void;
  private pending: Map<string, PendingTextualCommand> = new Map();

  constructor(options: TextualFallbackOptions) {
    this.dispatcher = options.dispatcher;
    this.sendPlain = options.sendPlain;
  }

  handleMessage(jid: string, body: string): boolean {
    const trimmed = body.trim();

    let matchedPrefix: string | null = null;
    for (const prefix of OC_PREFIXES) {
      if (trimmed === prefix || trimmed.startsWith(prefix + " ")) {
        matchedPrefix = prefix;
        break;
      }
    }

    if (!matchedPrefix) {
      return this.handleParamReply(jid, trimmed);
    }

    const arg = trimmed.slice(matchedPrefix.length).trim();

    if (arg === "" || arg === "help") {
      this.showHelp(jid);
      return true;
    }

    const action = this.dispatcher.getAction(arg);
    if (!action) {
      this.sendPlain(jid, `Command "${arg}" not found.\n\nUse /oc or !oc to see available commands.`);
      return true;
    }

    if (action.params.length === 0) {
      try {
        const result = action.handler({});
        this.sendPlain(jid, `${action.name}:\n${result}`);
      } catch (err) {
        this.sendPlain(jid, `Error in ${action.name}: ${String(err)}`);
      }
      return true;
    }

    this.startCommand(jid, action);
    return true;
  }

  private showHelp(jid: string): void {
    const actions = this.dispatcher.listActions();
    if (actions.length === 0) {
      this.sendPlain(jid, "OpenClaw: no control commands available.");
      return;
    }

    const lines = actions.map((a) => {
      const params =
        a.params.length > 0
          ? ` [${a.params.map((p) => (p.required ? `<${p.label}>` : `[${p.label}]`)).join(" ")}]`
          : "";
      return `• /oc ${a.node}${params} — ${a.description}`;
    });

    this.sendPlain(
      jid,
      `OpenClaw commands:\n\n${lines.join("\n")}\n\n` +
        "Use /oc <command> or !oc <command> to run it. If the command has parameters, they'll be prompted one at a time.",
    );
  }

  private startCommand(jid: string, action: XmppAction): void {
    const remaining = action.params.map((p) => ({
      name: p.name,
      label: p.label,
      type: p.type,
      options: p.options,
      required: p.required,
    }));

    const session: PendingTextualCommand = {
      node: action.node,
      jid,
      collected: new Map(),
      remaining,
      currentParamIdx: 0,
    };

    const key = this.commandKey(jid);
    this.pending.set(key, session);

    this.promptCurrentParam(jid, session);
  }

  private commandKey(jid: string): string {
    return `txt:${jid}`;
  }

  private promptCurrentParam(jid: string, session: PendingTextualCommand): void {
    if (session.currentParamIdx >= session.remaining.length) {
      const params: Record<string, string> = {};
      for (const [k, v] of session.collected) params[k] = v;
      const action = this.dispatcher.getAction(session.node);
      if (action) {
        try {
          const result = action.handler(params);
          this.sendPlain(jid, `${action.name} completed:\n${result}`);
        } catch (err) {
          this.sendPlain(jid, `Error in ${action.name}: ${String(err)}`);
        }
      }
      this.pending.delete(this.commandKey(jid));
      return;
    }

    const param = session.remaining[session.currentParamIdx]!;

    let prompt = `${param.label}`;
    if (param.type === "boolean") {
      prompt += "\n(Options: yes / no)";
    } else if (param.options && param.options.length > 0) {
      const opts = param.options.map((o, i) => `${i + 1}) ${o.label}`).join("\n");
      prompt += `\n${opts}`;
    }
    if (!param.required) {
      prompt += '\n(Reply "-" to skip)';
    }
    prompt += '\n(Reply "cancel" to cancel the command)';

    this.sendPlain(jid, prompt);
  }

  private handleParamReply(jid: string, body: string): boolean {
    const key = this.commandKey(jid);
    const session = this.pending.get(key);
    if (!session) return false;

    const trimmed = body.trim();

    if (trimmed.toLowerCase() === "cancel") {
      this.pending.delete(key);
      this.sendPlain(jid, "Command canceled.");
      return true;
    }

    const param = session.remaining[session.currentParamIdx]!;

    if (trimmed === "-" && !param.required) {
      session.collected.set(param.name, "");
      session.currentParamIdx++;
      this.promptCurrentParam(jid, session);
      return true;
    }

    if (param.type === "boolean") {
      const lc = trimmed.toLowerCase();
      if (lc === "yes" || lc === "y" || lc === "true" || lc === "1") {
        session.collected.set(param.name, "true");
      } else if (lc === "no" || lc === "n" || lc === "false" || lc === "0") {
        session.collected.set(param.name, "false");
      } else {
        this.sendPlain(jid, 'Reply "yes" or "no".');
        return true;
      }
      session.currentParamIdx++;
      this.promptCurrentParam(jid, session);
      return true;
    }

    if (param.options && param.options.length > 0) {
      const num = Number(trimmed);
      if (Number.isInteger(num) && num >= 1 && num <= param.options.length) {
        session.collected.set(param.name, param.options[num - 1]!.value);
      } else {
        const lc = trimmed.toLowerCase();
        const match = param.options.find((o) => o.label.toLowerCase() === lc || o.value.toLowerCase() === lc);
        if (match) {
          session.collected.set(param.name, match.value);
        } else {
          this.sendPlain(jid, "Option not recognized. Reply with the number or name of the option.");
          return true;
        }
      }
      session.currentParamIdx++;
      this.promptCurrentParam(jid, session);
      return true;
    }

    if (!trimmed && param.required) {
      this.sendPlain(jid, `${param.label} is required. Provide a value.`);
      return true;
    }

    session.collected.set(param.name, trimmed);
    session.currentParamIdx++;
    this.promptCurrentParam(jid, session);
    return true;
  }

  hasPending(jid: string): boolean {
    return this.pending.has(this.commandKey(jid));
  }

  cancelPending(jid: string): void {
    this.pending.delete(this.commandKey(jid));
  }

  cleanup(_maxAgeMs: number = 300_000): void {
    // Textual sessions don't embed timestamps; a no-op until timestamps are
    // added. Sessions auto-cleanup on completion or explicit cancel.
  }
}
