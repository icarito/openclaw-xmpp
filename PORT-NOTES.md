# XMPP channel plugin — port notes

Forked from `extensions/irc/` (the real OpenClaw IRC channel plugin) and
retargeted from IRC's nickname/channel model to XMPP's JID/MUC model, with
the actual protocol logic ported from the working NanoClaw adapter
(`src/channels/xmpp.ts`, 1789 lines) and its control layer
(`src/channels/xmpp-control/*.ts`).

## What ported cleanly (fully working, same behavior as NanoClaw)

- **Connection lifecycle** (`src/client.ts`): `@xmpp/client` setup, exponential
  reconnect backoff (takes over `@xmpp/reconnect`'s fixed 1s delay via the
  `reconnecting` event, capped at 60s), XEP-0199 ping every 55s with a 15s
  timeout that forces a real disconnect on failure, and MUC room rejoin on
  every (re)connect. This is a behavior-preserving port of `xmpp.ts`'s
  connection setup — none of the hard-won reconnect/ping logic was simplified
  away.
- **Protocol helpers** (`src/protocol.ts`): `markdownToPlain`, `splitForLimit`
  (XMPP_MAX_BODY=4000 chunking), `isStaleDelayedStanza` (XEP-0203 replay
  guard), `messageMentionsBot` (XEP-0372 reference + text-nick fallback),
  `extractReply` (XEP-0461), `extractOobUrl` (XEP-0066/0363 inbound
  detection), `attachmentLabel`. All pure functions, ported near-verbatim.
- **Outbound send** (`src/send.ts`): text send with chunking, XEP-0308 last-
  message-correction edit path, and now a **real** XEP-0363 upload path
  (`sendFileXmpp`) — see "Deviation: media upload" below.
- **XEP-0363 upload** (`src/upload.ts`): disco-based upload-component
  discovery (cached per domain), slot request, PUT with returned headers.
  Ported from the file-attachment branch of `xmpp.ts`'s `deliver()`.
- **XEP-0050/XEP-0004 ad-hoc command protocol** (`src/xep-0050.ts`,
  `src/xep-0004.ts`, `src/actions.ts`, `src/textual-fallback.ts`,
  `src/outbound-render.ts`, `src/ask-question.ts`): the entire IQ-stanza
  protocol machinery (disco#items/disco#info, execute→form→submit→completed
  flow, `/oc` textual fallback for clients without form support, inline
  disco#items buttons for Cheogram) is a faithful, dependency-free port. No
  NanoClaw internals in these files — they're pure XMPP protocol code, so
  they ported 1:1 modulo cosmetic renames (`nc-` → `oc-` ids, `/nc` → `/oc`
  prefix, Spanish strings → English to match OpenClaw's convention).
- **Inbound dispatch** (`src/inbound.ts`): follows IRC's
  `core.channel.inbound.dispatchReply` pattern exactly (ingress resolver →
  pairing → route/envelope → dispatchReply), not reconstructed from the
  Matrix fragment in the task brief. Only the identity model differs from
  IRC: XMPP has one stable identity per message (a sealed bare JID), so there
  is no nick/user/host alias tri-state to reconcile the way IRC's
  `ircIngressIdentity` aliases do — `xmppIngressIdentity` has zero aliases.
- **Config/accounts/setup** (`accounts.ts`, `config-schema.ts`, `policy.ts`,
  `normalize.ts`, `setup-core.ts`, `setup-surface.ts`): full per-account
  config resolution (jid/password/service/resource/mucDomain/mucRooms),
  group policy/tool-policy scoping, and an onboarding wizard — same shape as
  IRC's, fields swapped for XMPP's.

## What's stubbed (clearly marked with `TODO(xmpp-migration):` comments)

All of these depended on NanoClaw internals (SQLite tables, `ncl` CLI, Docker
container lifecycle) that don't exist under OpenClaw's process model (one
gateway process, agents are config entries, not Docker containers). Rather
than fake a plausible-looking call into a nonexistent OpenClaw API, each is
left as an inert action with an explanatory `TODO(xmpp-migration):` comment
in `src/commands.ts`:

- **`context`/`compact`/`clear`** (was `xmpp-control/session-commands.ts`):
  NanoClaw injected the literal slash-command text into its own session
  store via `writeSessionMessage()` + `wakeContainer()`, gated by
  `gateCommand()` against a `user_roles` table. **Blocking question for
  Sebastián / next implementer**: is there an OpenClaw plugin-SDK primitive
  that lets a channel plugin inject a synthetic inbound text message into
  `core.channel.inbound` the same way a real message would flow, or an
  admin-role check outside the config's own `allowFrom` lists? I did not find
  one in the IRC or Matrix reference plugins — both only ever call
  `core.channel.commands.shouldHandleTextCommands` /
  `core.channel.text.hasControlCommand` to gate whether a message BODY looks
  like a command, never to synthesize one.
- **`model`** (was `xmpp-control/model-action.ts`): required NanoClaw's
  `container_configs` table + `restartAgentGroupContainers()`. Needs an
  `api.runtime.agent.config.*` setter, if one exists — not found.
- **Agent lifecycle** (`agent-list`/`agent-info`/`agent-logs`/`agent-disable`/
  `agent-enable`/`agent-archive`, was `xmpp-control/agent-lifecycle.ts`):
  required the `ncl` CLI + `docker` + a central sqlite DB. Not ported at all
  (not even stubbed as a menu entry) — OpenClaw's agent model is
  fundamentally different (no per-agent Docker container to list/stop/
  archive), so this needs a design decision, not a mechanical port.
- **Skill commands** (`xmpp-control/skill-scan.ts` + `skill-commands.ts`):
  discovered `SKILL.md` frontmatter from a NanoClaw-specific
  `.claude-shared/skills/` symlink layout and injected prompts via
  `notifyAgent()`. Not ported — would need an OpenClaw-native skills
  registry and a way to inject a prompt into a running agent session
  out-of-band, neither of which I found a primitive for.
- **Approval bypass** (`xmpp.ts`'s `buildApprovalBypassAction`): reads/writes
  `modules/approvals/bypass.ts`, a NanoClaw-only module. Not ported.
- **Telemetry read side** (`src/telemetry.ts`): the PEP **publish** mechanics
  (pubsub IQ building, presence caps, the "did the number move enough to
  bother publishing" thresholding) are fully ported and live. The **read**
  side (`readTelemetryStub()`) always returns "no session" — NanoClaw read
  token/context counts directly from a per-session `opencode.db` SQLite file
  that OpenClaw's single-process gateway does not produce. TODO comment left
  for whoever finds (or adds) the equivalent `api.runtime.agent.session.*`
  read path.

## Deviations from IRC's pattern, and why

1. **No `api.registerCommand` primitive exists.** The task brief speculated
   XEP-0050 might wire in via "OpenClaw's custom command bypassing the LLM
   primitive." I checked: no such primitive exists in either the IRC or
   Matrix reference plugins — both only expose
   `core.channel.commands.shouldHandleTextCommands` /
   `core.channel.text.hasControlCommand`, which gate whether a message BODY
   parses as a control command, not a protocol-level UI mechanism. XEP-0050
   is therefore implemented **entirely inside this plugin's own IQ-handling
   layer** (`src/commands.ts`, wired through `src/client.ts`'s `handleIq`
   hook into `@xmpp/client`'s `iqCallee`), bypassing OpenClaw's
   command/dispatch APIs altogether — exactly as XMPP's protocol-level
   ad-hoc commands have no text-command equivalent to hook into.

2. **Persistent connection registry instead of IRC's transient-connect
   pattern** (`src/connection-registry.ts`). IRC's `send.ts` opens a
   short-lived connection when no persistent client is passed (cheap and
   correct for IRC: connect → JOIN → PRIVMSG → QUIT works fine per-message).
   XMPP cannot do this safely: MUC delivery generally requires an established
   occupant presence in the room (many servers reject/drop groupchat messages
   from a JID that hasn't joined), and a full stream negotiation (SASL,
   resource bind, roster fetch) per outbound message is far more expensive
   than IRC's raw-socket PRIVMSG. `monitor.ts` registers the live,
   monitor-owned connection in a small per-account map; `send.ts`/`upload.ts`
   read from it. If no connection is registered, `sendMessageXmpp` throws
   rather than dialing a wasteful transient one.

3. **Real XEP-0363 media upload, not a text-append.** IRC's (and Matrix's
   channel-adapter surface's) `sendMedia` handler only ever receives a
   `mediaUrl` string — I verified this by reading both IRC's
   `message-adapter.ts` and Matrix's actual upload call site
   (`extensions/matrix/src/matrix/send.ts`). Matrix does a real upload by
   calling the SDK's `loadOutboundMediaFromUrl` (from
   `openclaw/plugin-sdk/outbound-media`) to fetch the bytes, then PUTs them
   to its own content repository. This plugin does the equivalent for XMPP:
   `sendFileXmpp` in `src/send.ts` calls `loadOutboundMediaFromUrl`, then
   `uploadFileXmpp` (XEP-0363 slot request + PUT), then sends the download
   URL as an XEP-0066 OOB link with a caption — falling back to a plain-text
   link only if no XEP-0363 upload component is discoverable via disco (some
   servers don't run one). Verified `loadOutboundMediaFromUrl`'s return shape
   (`.buffer`, `.fileName`, `.contentType`) against Matrix's actual
   destructuring rather than guessing.

4. **English strings instead of Spanish.** NanoClaw's xmpp-control layer was
   written for a Spanish-speaking operator (Sebastián); this port uses
   English for all user-facing command/error text to match OpenClaw's own
   convention (visible in IRC's error messages). Command prefix changed from
   `/nc`/`!nc` to `/oc`/`!oc` and stanza id prefixes from `nc-`/`nc-cmd-` to
   `oc-`/`oc-cmd-` for the same reason. The XEP-0115 caps node changed from
   `https://github.com/nanocoai/nanoclaw` to
   `https://github.com/openclaw/openclaw`.

5. **`markdownCapable: false` in channel meta**, unlike IRC's `true`. XMPP's
   `<body>` is genuinely plain text (no client-side markdown rendering to
   rely on); the plugin always renders through `markdownToPlain()` before
   sending, same as `xmpp.ts` did.

## What to review/test first

1. **`src/client.ts` + `src/monitor.ts`** — the reconnect backoff and
   XEP-0199 ping timers are the most behaviorally load-bearing part of this
   port (see the "hard-won fixes" callout in the task brief) and the hardest
   to verify without a live server. Confirm against a real Prosody instance
   that: (a) a killed connection actually reconnects with growing backoff,
   not a hot loop; (b) the ping timeout really forces `xmpp.disconnect()`
   rather than hanging.
2. **`src/commands.ts`'s stub list** — decide whether `context`/`compact`/
   `clear`/`model`/agent-lifecycle/skill-commands should block shipping XMPP
   as a Telegram-parity channel, or ship without them and backfill once the
   missing OpenClaw primitives (see "blocking question" above) are
   confirmed or added.
3. **`src/send.ts`'s `sendFileXmpp`** — untested against a real XEP-0363
   component; the disco-discovery caching (`uploadServiceHostCache` in
   `upload.ts`) is process-lifetime, so a component added to the server
   after the gateway starts won't be found until restart (same caching
   trade-off `xmpp.ts` made).
4. **`extensions/xmpp/package.json`'s `@xmpp/client`/`@xmpp/xml` version
   pins** — copied as reasonable current majors, not verified against what
   NanoClaw's `package.json` actually locked; confirm before `npm install`.

## 2026-07 update: remaining XEPs, real native-command wiring, nanoclaw cleanup

Three follow-up tasks against the state above: port the remaining XEPs,
replace the command-system stub with a real wire-up aligned to how
Telegram's native commands actually work, and remove stray NanoClaw
references (plugin source + agent workspace directives).

### XEPs

- **XEP-0085 (chat states) — now LIVE.** Ported `xmpp.ts`'s `setTyping()`
  (`<composing/>`) into `src/send.ts` as `sendTypingXmpp`/`clearTypingXmpp`,
  and wired them into `src/channel.ts`'s new `base.heartbeat.sendTyping` /
  `clearTyping` block — the exact plugin-SDK hook Matrix uses for the same
  purpose (`extensions/matrix/src/channel.ts`'s `heartbeat` block calling its
  own `sendTypingMatrix`). Confirmed via the installed SDK's
  `types.adapters-*.d.ts`: `ChannelHeartbeatAdapter.sendTyping`/`clearTyping`
  take `{cfg, to, accountId?, threadId?, deps?}` and return
  `Promise<void> | void` — no streaming/turn-lifecycle hook exists beyond
  this, so (same as `xmpp.ts` did) `sendMessageXmpp`'s existing `<active/>`
  clear at the end of a real reply remains the primary "stop typing" signal;
  `clearTyping` covers the heartbeat-driven case (e.g. a turn that ends with
  no outbound message). Both are best-effort (swallow send errors), matching
  `xmpp.ts`'s own `try {} catch { log.debug(...) }`.
- **XEP-0115 (caps) — confirmed already correct, no changes needed.** Old
  `xmpp.ts` uses the identical sha-1 verification-string algorithm and has
  no features beyond the 3 (`COMMAND_NS`/`DISCO_INFO_NS`/`DISCO_ITEMS_NS`)
  already in `xep-0050.ts`'s `CAPS_NODE`/`CAPS_IDENTITY`/`CAPS_FEATURES` +
  `telemetry.ts`'s `capsVerHash`/`buildCapsPresence`.
- **XEP-0439 (quick response) — confirmed dead code in the reference,
  intentionally NOT ported.** Read the full 83-line
  `src/channels/xmpp-control/xep-0439.ts`: none of its exports are called
  from any live path in `xmpp.ts`, and its sibling `buildQuickResponseStanza`
  in the old `outbound-render.ts` is likewise defined but never invoked. The
  ACTUAL working quick-reply-button mechanism NanoClaw used (and that this
  plugin already ported) is the XEP-0050 `q:`-prefixed disco#items command
  flow — `buildQueryCommandStanza` in `src/outbound-render.ts` plus the
  `q:`-node interception in `src/commands.ts`'s `handleIq`. Porting the dead
  XEP-0439 scaffolding on top would add a second, unused button mechanism;
  skipped as explicitly out of scope unless a future client is found that
  needs real XEP-0439 (jabber:x:data quick-response) instead of the disco
  flow.
- **XEP-0428 (fallback) — already ported**, in `src/protocol.ts`'s
  `extractReply()` (inbound-only, same as `xmpp.ts`; no outbound
  `<fallback/>` construction exists in either codebase to port).
- **XEP-0444 (reactions) — confirmed unused in the reference** (a one-line
  no-op guard with an explanatory comment, no send/receive logic at all).
  Nothing to port; not added.

### Command system: the real Telegram mechanism, and how XMPP now uses it

The previous PORT-NOTES entry framed this as blocked on an open question:
"is there an OpenClaw plugin-SDK primitive that lets a channel plugin inject
a synthetic inbound text message into the same dispatch pipeline a real
message would flow through?" **Yes — and this plugin's own `src/inbound.ts`
was already using it**, just not from the command layer. `inbound.ts`
computes `hasControlCommand`/`allowTextCommands` via
`core.channel.commands.shouldHandleTextCommands` /
`core.channel.text.hasControlCommand` and always runs the message body
(control command or not) through `core.channel.inbound.dispatchReply` — the
SAME pipeline for a normal chat message and for a typed `/compact`. There is
no separate "native command dispatch" API; native commands are just messages
whose body happens to parse as a command.

Reading Telegram's real source (`extensions/telegram/src/bot-native-commands.ts`,
1970 lines) confirms this at the architecture level: after resolving a
`/command` invocation, it builds synthetic prompt text via
`buildCommandTextFromArgs()` from `openclaw/plugin-sdk/command-auth-native`,
then feeds that string into `finalizeInboundContext()` +
`dispatchReplyWithBufferedBlockDispatcher()` — the identical reply pipeline
used for a normal conversational turn, tagged with `CommandSource: "native"`
/ `CommandTurn: {kind: "native", ...}` metadata. IRC and Matrix, by contrast,
never wire native commands at all (confirmed: zero references to
`command-auth-native`, `listNativeCommandSpecs`, or `finalizeInboundContext`
`CommandTurn` anywhere in either plugin's source) — they rely purely on the
text-command path, exactly like this plugin's `inbound.ts` already does.

The installed SDK (`/opt/claudio-w/npm-global/lib/node_modules/openclaw/dist/plugin-sdk/command-auth-native.d.ts`)
confirms a real, rich, provider-agnostic native command registry exists:
`listNativeCommandSpecs(params?)` / `listNativeCommandSpecsForConfig(cfg, params?)`,
`findCommandByNativeName(name, provider?)`, `buildCommandTextFromArgs(command, args?)`,
`resolveNativeCommandSessionTargets(params)`, `resolveCommandAuthorization(params)`.
Checked the registry data
(`commands-registry.data-*.js`) directly: only ONE command in the entire
registry (`login`, Codex device-code auth) is restricted to
`nativeProviders: ["telegram"]` — `context`/`compact`/`clear`/`model` (and
everything else) have no provider restriction, so calling
`listNativeCommandSpecsForConfig(cfg, {provider: "xmpp"})` is valid and
correctly returns them.

**What was built** (`src/native-commands.ts`, new file):
`buildNativeCommandActions()` looks up the `context`/`compact`/`clear`/
`model` specs via the registry, builds one `XmppAction` per command (a
single optional `text-single` XEP-0004 param when the command definition has
one positional arg — `compact`'s instructions, `model`'s model id — zero
params otherwise), and on invocation:
1. builds the exact synthetic slash-command text `buildCommandTextFromArgs`
   would build for Telegram (e.g. `/model deepseek/deepseek-v4-pro`);
2. constructs a synthetic `XmppInboundMessage` (`wasMentioned: true`, DM
   target = the requesting JID) and calls this plugin's own
   `handleXmppInbound()` (`src/inbound.ts`) with it, **without awaiting** —
   this reuses ingress resolution, pairing/allowlist gating, group policy,
   session routing, and `dispatchReply` unchanged, so an unauthorized JID is
   gated identically whether it types `/compact` or taps the ad-hoc command
   menu entry for it;
3. returns an immediate "submitted" acknowledgement as the XEP-0050 IQ
   result — the actual agent reply arrives afterward as a normal XMPP chat
   message via `handleXmppInbound`'s own delivery path (`sendMessageXmpp`),
   same as if the JID had typed `/compact` directly. This avoids blocking
   the ad-hoc-command IQ (which real clients like Gajim/Cheogram time out)
   on a full agent turn that may involve tool calls.

`src/commands.ts` now calls `buildNativeCommandActions()` instead of
returning canned "not implemented" strings for these four nodes. Also fixed
two related bugs in `src/textual-fallback.ts` (the `/oc <command>` typed
fallback) uncovered while wiring this: its two `action.handler(...)` call
sites neither `await`ed the result nor passed an `ActionContext`, which
worked for the old synchronous stub handlers but would have silently
stringified a `Promise` object and left `ctx.fromJid` undefined for the new
async native-command handlers. Fixed both call sites to resolve the promise
(fire-and-forget, consistent with the IQ path's "ack now, reply arrives as a
chat message" design) and pass `{fromJid: jid, accountId}` — `TextualFallback`
now takes `accountId` in its constructor options (threaded from
`commands.ts`).

**Not ported (documented, not guessed at):**

- **Agent lifecycle** (`list`/`info`/`logs`/`disable`/`enable`/`archive`,
  was `xmpp-control/agent-lifecycle.ts`) — genuinely has no OpenClaw-native
  concept to map to. OpenClaw is one gateway process per deployment; agents
  are config entries (`agents.<id>` in the config file), not Docker
  containers with their own lifecycle, logs, or restart semantics. Telegram
  has no equivalent either (confirmed: no container/agent-lifecycle command
  in `bot-native-commands.ts`). Left unported rather than inventing a fake
  mapping (e.g. "disable" could theoretically toggle `agents.<id>.enabled`
  in config, but that's a config-mutation operation, a different trust tier
  than a chat command, and no existing channel plugin does this — would need
  an explicit design decision, not a mechanical port).
- **Skill commands** (`skill-scan.ts`/`skill-commands.ts`) — OpenClaw DOES
  have a native, generic skills-as-commands system:
  `openclaw/plugin-sdk/command-auth-native` exports
  `listSkillCommandsForAgents({cfg, agentIds})` (returns `SkillCommandSpec[]`)
  and `resolveSkillCommandInvocation({commandBodyNormalized, skillCommands})`
  (resolves whether a text body invokes one). This is confirmed to be the
  right replacement for NanoClaw's `.claude-shared/skills/` scanning — but
  wiring it fully requires passing a resolved `skillCommands` list into
  `inbound.ts`'s `core.channel.text.hasControlCommand`/
  `core.channel.commands.shouldHandleTextCommands` call sites (neither
  currently receives `skillCommands`, so skill-invoked text commands
  wouldn't currently be detected as control commands at all — this needs
  verification against how IRC/Matrix's own `inbound.ts` equivalents pass
  `skillCommands`, which I did not find either doing explicitly). Left as a
  documented gap rather than a partial, silently-broken wire-up. Exposing
  skill commands via the XEP-0050 menu (analogous to
  `buildNativeCommandActions`) is comparatively straightforward once the
  text-command-detection gap above is resolved — `native-commands.ts`'s
  pattern would extend directly.
- **Approval bypass** (`xmpp.ts`'s `buildApprovalBypassAction`) — reads/writes
  `modules/approvals/bypass.ts`, a NanoClaw-only module with no OpenClaw
  equivalent found. Not ported.

### Nanoclaw string cleanup

Grepped `extensions/xmpp/src/*.ts` for `nanoclaw`/`NanoClaw` (case-insensitive)
across the 11 files the task brief flagged. Kept provenance comments
("ported from NanoClaw's xmpp.ts...") since those are genuinely useful
maintainer context and never render to a chat user. No user-facing string
(error message, command description, help text) referencing "nanoclaw" was
found remaining after the earlier pass that already renamed
`CAPS_NODE`/`TELEMETRY_NODE`/command prefixes to `openclaw`/`oc-` — this
pass only added the `native-commands.ts` file (new, no nanoclaw references)
and touched `send.ts`/`channel.ts`/`channel-runtime.ts`/`commands.ts`/
`textual-fallback.ts`, none of which introduced new nanoclaw references.

Agent workspace directive files on the server
(`/opt/claudio-w/openclaw-home/workspaces/{main,bob,odisea-consultant,rolando,hiori}/*.md`)
were reviewed read-only over SSH and cleaned up separately (not part of this
repo) — see the task's own summary message for what was found/changed
there, since those files live outside `extensions/xmpp/` and outside this
git repository entirely.

### Uncertain / needs live verification

- `src/native-commands.ts`'s registry calls
  (`listNativeCommandSpecsForConfig`, `findCommandByNativeName`,
  `buildCommandTextFromArgs`) were verified against the INSTALLED SDK's
  `.d.ts` and minified `.js` on the server
  (`/opt/claudio-w/npm-global/lib/node_modules/openclaw/dist/`), not just
  the git-source Telegram plugin, specifically to avoid the previous agent's
  git-source-ahead-of-npm-release skew problem. Signatures match. Still
  unverified: whether `listNativeCommandSpecsForConfig` respects any
  per-channel command-visibility config XMPP hasn't set yet (Telegram passes
  extra filtering for its own menu-building that this plugin does not
  replicate) — if some commands unexpectedly appear/disappear from the
  XEP-0050 menu, check `listNativeCommandSpecsForConfig`'s config-driven
  enable/disable path (`isCommandEnabled` in the same module).
- The fire-and-forget dispatch in `native-commands.ts` means a failed native
  command (e.g. bad model id) surfaces as a normal chat-message error reply
  via the usual `dispatchReply` error path, NOT as an XEP-0050 IQ error —
  this is a deliberate design choice (consistent with typed `/compact`
  behavior) but worth confirming feels right in practice; the IQ always
  reports "submitted" even if the underlying command later fails.
- `sendTypingXmpp`/`clearTypingXmpp` in `send.ts` were not tested against a
  live server (no local `tsc`/`node_modules/openclaw` available in this
  worktree to typecheck against); verified only by reading the exact
  `ChannelHeartbeatAdapter` type from the installed SDK's
  `types.adapters-sK5EFxPJ.d.ts` and matching Matrix's real call-site shape.
