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
