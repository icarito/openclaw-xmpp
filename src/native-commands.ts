// Xmpp plugin module: wires XEP-0050 ad-hoc command nodes to OpenClaw's
// REAL native command registry/dispatch pipeline, the same mechanism
// Telegram's bot-native-commands.ts uses for its /context, /compact,
// /clear, /model slash commands.
//
// How this was found (see PORT-NOTES.md "2026-07 update" for the full
// writeup): the previous agent's "blocking question" -- whether a primitive
// exists to inject a synthetic command into OpenClaw's dispatch pipeline --
// is already answered by this plugin's OWN inbound.ts. inbound.ts computes
// `hasControlCommand`/`allowTextCommands` via
// core.channel.commands.shouldHandleTextCommands / core.channel.text.hasControlCommand
// and then runs the message body through the SAME core.channel.inbound.dispatchReply
// pipeline used for ordinary chat -- there is no separate "native command"
// dispatch API distinct from normal inbound dispatch. Telegram's
// bot-native-commands.ts (extensions/telegram/src/bot-native-commands.ts)
// confirms this: after building a synthetic prompt string via
// buildCommandTextFromArgs(), it feeds that string into
// finalizeInboundContext()+dispatchReplyWithBufferedBlockDispatcher() --
// literally the same reply pipeline as a normal turn, just with
// CommandSource: "native" metadata attached. Telegram's own registry lookup
// (listNativeCommandSpecsForConfig / findCommandByNativeName /
// buildCommandTextFromArgs, all from openclaw/plugin-sdk/command-auth-native)
// is provider-agnostic -- confirmed against the installed SDK's
// commands-registry.data-*.js: only ONE command (`login`) is restricted to
// `nativeProviders: ["telegram"]` (Codex device-code auth, meaningless for
// XMPP); context/compact/clear/model/etc. have no nativeProviders
// restriction at all, so they're valid to expose from any channel.
//
// This module's job is therefore much smaller than Telegram's 1970-line
// bot-native-commands.ts (which also handles Telegram-specific inline
// keyboards, forum topics, and a Codex login flow -- none of which apply to
// XMPP): build the synthetic slash-command text via the same registry
// helpers Telegram uses, then hand it to this plugin's OWN
// handleXmppInbound() (inbound.ts) exactly as if the requesting JID had
// typed it as a chat message. That reuses 100% of the already-live
// ingress/pairing/gating/session/reply machinery instead of reimplementing
// any of it.
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listNativeCommandSpecsForConfig,
} from "openclaw/plugin-sdk/command-auth-native";
import type { ResolvedXmppAccount } from "./accounts.js";
import type { ActionContext, XmppAction } from "./actions.js";
import { handleXmppInbound } from "./inbound.js";
import { makeXmppMessageId } from "./protocol.js";
import type { RuntimeEnv } from "./runtime-api.js";
import type { CoreConfig, XmppInboundMessage } from "./types.js";

const NATIVE_COMMAND_PROVIDER = "xmpp";

/**
 * Session-style commands to expose via XEP-0050, by registry `key`. Kept to
 * an explicit allowlist (rather than dumping every "essential"/"standard"
 * tier command into the ad-hoc menu) because many registry commands assume
 * a richer UI (inline keyboards, argument menus) this plugin doesn't render
 * -- context/compact/clear/model are the ones the user explicitly asked to
 * align with Telegram, and they all degrade fine to "one XEP-0004 text-single
 * field, or zero fields for a no-arg invocation".
 */
const EXPOSED_NATIVE_COMMAND_KEYS = ["context", "compact", "clear", "model"];

/**
 * Build one XmppAction per exposed native command, keyed by the registry's
 * own `key` (not renamed) so the node in disco#items and the slash text
 * OpenClaw's core dispatch expects stay in lockstep.
 */
export function buildNativeCommandActions(params: {
  account: ResolvedXmppAccount;
  cfg: CoreConfig;
  runtime: RuntimeEnv;
}): XmppAction[] {
  const { account, cfg, runtime } = params;

  const specs = listNativeCommandSpecsForConfig(cfg, { provider: NATIVE_COMMAND_PROVIDER });
  const actions: XmppAction[] = [];

  for (const key of EXPOSED_NATIVE_COMMAND_KEYS) {
    const spec = specs.find((s) => s.name === key);
    if (!spec) continue; // command disabled via config feature flags, or not registered

    const definition = findCommandByNativeName(spec.name, NATIVE_COMMAND_PROVIDER);
    const argDef = definition?.args?.[0];

    actions.push({
      node: spec.name,
      name: `Session: ${spec.name}`,
      description: spec.description,
      // A single free-text param when the command accepts one (compact's
      // optional instructions, model's optional model id); no params for a
      // bare invocation like /clear. XEP-0004 forms + the /oc textual
      // fallback both already handle zero-param actions as immediate
      // (no-prompt) execution -- see actions.ts's ActionParam.required.
      params: argDef
        ? [
            {
              name: argDef.name,
              label: argDef.description || argDef.name,
              type: "text-single",
              required: false,
            },
          ]
        : [],
      mutating: spec.name !== "context", // context is read-only; compact/clear/model change session state
      handler: async (formParams, ctx?: ActionContext) => {
        if (!ctx?.fromJid) {
          return "Cannot run this command: no requesting JID available.";
        }
        const rawArg = argDef ? formParams[argDef.name]?.trim() : undefined;
        const commandText = definition
          ? buildCommandTextFromArgs(definition, rawArg ? { raw: rawArg } : undefined)
          : rawArg
            ? `/${spec.name} ${rawArg}`
            : `/${spec.name}`;

        // XEP-0050 ad-hoc commands are a request/response IQ; OpenClaw's
        // reply pipeline can stream/take a while (an agent turn, possibly
        // spanning tool calls). Rather than block the IQ result on that
        // (Gajim/Cheogram both apply their own IQ timeouts), fire the
        // dispatch WITHOUT awaiting it and acknowledge submission
        // immediately -- the real reply arrives as a normal chat message via
        // handleXmppInbound's own delivery path, same as a typed "/compact"
        // already behaves for this plugin, just triggered from the ad-hoc
        // command menu instead of typed text. Errors are logged, not
        // returned in the (already-sent) IQ result.
        dispatchNativeCommandText({
          commandText,
          fromJid: ctx.fromJid,
          account,
          cfg,
          runtime,
        }).catch((err) => {
          runtime.error?.(`xmpp native command "${spec.name}" dispatch failed: ${String(err)}`);
        });

        return `${spec.name} submitted (${commandText}). Reply will arrive as a chat message.`;
      },
    });
  }

  return actions;
}

/**
 * Feed synthetic command text through the SAME inbound pipeline a typed
 * chat message uses (handleXmppInbound in inbound.ts): ingress resolution,
 * pairing/allowlist gating, group policy, session routing, and
 * dispatchReply all run identically to a real message. This is
 * intentionally NOT a bespoke "call the agent directly" shortcut -- an
 * unauthorized JID must be gated exactly the same way whether it types
 * "/compact" or taps the XEP-0050 menu entry for it.
 */
async function dispatchNativeCommandText(params: {
  commandText: string;
  fromJid: string;
  account: ResolvedXmppAccount;
  cfg: CoreConfig;
  runtime: RuntimeEnv;
}): Promise<void> {
  const { commandText, fromJid, account, cfg, runtime } = params;

  const message: XmppInboundMessage = {
    messageId: makeXmppMessageId(),
    target: fromJid,
    rawFrom: fromJid,
    senderJid: fromJid,
    text: commandText,
    timestamp: Date.now(),
    isGroup: false,
    // Explicit ad-hoc command invocation via an authenticated IQ from this
    // JID counts as intentional engagement -- no mention-gate applies (DMs
    // never require a mention anyway; this only matters if a future variant
    // exposes ad-hoc commands from a MUC occupant JID).
    wasMentioned: true,
  };

  await handleXmppInbound({
    message,
    account,
    config: cfg,
    runtime,
  });
}
