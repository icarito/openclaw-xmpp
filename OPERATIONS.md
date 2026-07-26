# XMPP gateway operations

## Approval modes: one concept, three scopes

There is one question -- "let this agent/session/command run without asking
me" -- answered at three different scopes, not three competing mechanisms.
Pick the row that matches how much you want relaxed and for how long:

| Scope | Mechanism | Persistence | Restart needed? |
|---|---|---|---|
| This conversation, for N minutes | `elevated` (below) | session store + durable record, survives a gateway restart | No |
| Specific commands, permanently | `exec-approvals.json` allowlist (below) | file | Yes |
| This agent, permanently | direct edit of `exec-approvals.json`/`openclaw.json` | file | Yes |

Nothing here is a fallback for something broken -- each row solves a
genuinely different situation, and none of them starts an agent turn, so
changing approval policy can never itself trigger an approval loop.

This used to be four scopes across four mechanisms (`approval-bypass`,
`approval-mode`, the core-native `elevated`, and the allowlist), with the
first three overlapping in confusing ways -- `approval-bypass` and
`approval-mode` were plugin-invented duplicates of the session-scoped and
agent-wide cases the core-native `elevated` mechanism already covered.
`xmpp-elevated-session-command` consolidated on `elevated` as the only
session-scoped bypass exposed by this plugin, and retired the other two: the
agent-wide, permanent case is served just as well by editing
`exec-approvals.json`/`openclaw.json` directly (as already done for the
production fix on 2026-07-26), without a dedicated XMPP command that
required the same manual gateway restart anyway.

### `elevated`

The ad-hoc command node documented in detail below:

- `elevated`: session-scoped, temporary policy relaxation. Sets
  `elevatedLevel` to `"full"` directly on the invoking session's entry in
  the session store (in-process, via `getSessionEntry`/`patchSessionEntry`
  from `openclaw/plugin-sdk/session-store-runtime`) -- no config file write,
  no restart. This is the same `SessionEntry.elevatedLevel` the OpenClaw
  core already reads every turn to resolve `bypassApprovals`; this plugin
  does not invent a parallel exec-policy field. Auto-reverts after a
  configurable number of minutes (default 10, max 60) via an in-memory timer
  in the plugin process; can also be turned off early. The expiration and
  pre-bypass `elevatedLevel` are ALSO persisted in the session store
  (`pluginExtensions.xmpp.elevatedBypass`): if the gateway restarts while a
  bypass is active, a sweep on plugin load reverts any bypass whose
  expiration has already passed, restoring the recorded pre-bypass level --
  fail-closed, not fail-open.

**Prerequisite outside this plugin's control**: `elevatedLevel:"full"` only
actually bypasses approvals if the agent's `exec-approvals.json` does not
have `security`/`ask` explicitly set to something that blocks it (e.g.
`security:"allowlist"`, `ask:"on-miss"` win over the elevated override). If
`elevated on` reports success but exec commands still show an approval card,
check that file's `defaults` (or the agent's own override) before assuming
this command is broken -- this exact bug was found and fixed in production
on 2026-07-26.

`elevated status` returns both a human-readable note and a structured
XEP-0004 `type="result"` form (`active`, `mode`, `expires-at-ms`,
`remaining-seconds`) attached to the same XEP-0050 command result -- clients
that want to consume the state programmatically should read the form fields,
not parse the note text.

Available through XEP-0050 when the client targets the gateway's full
resource JID, and through the universal textual fallback:

```text
/oc elevated on 10
/oc elevated status
/oc elevated off
```

`elevated` supported `mode` values:

- `on`: activate the bypass for this session, for `minutes` (default 10, max
  60). Always sets `elevatedLevel:"full"` -- the core's other levels
  (`on`/`ask`) are not exposed as options here, since this command answers a
  binary "bypassed or not" question, not a level picker (see
  `xmpp-elevated-session-command` design.md D2 for the rationale).
- `off`: revert immediately and cancel the pending auto-reversion timer.
- `status`: report whether a bypass is active for this session and, if so,
  the remaining time.

The current server preset intentionally does not put file readers such as `cat`
into `safeBins`; those should go through the reviewer or human approval so
secret reads do not become a static allowlist bypass.

### Reducing cards with a per-agent read-only allowlist

An agent that frequently investigates code (greps/finds through a codebase,
reads files) will otherwise get one approval card per command under
`tools.exec.mode: "auto"`, because the reviewer only auto-approves
`risk:"low"` decisions and any `medium`/`high`/`unknown` falls back to a
human card. There is no configurable risk threshold on the reviewer itself
(its schema only accepts `model`/`timeoutMs`) -- the supported lever is a
permanent per-agent allowlist entry in `exec-approvals.json`:

```python
import json, time, uuid

CONFIG_PATH = "/opt/claudio-w/openclaw-home/exec-approvals.json"
AGENT_ID = "clawdio"  # replace with the target agent
READ_ONLY_BINS = ["/usr/bin/grep", "/usr/bin/find", "/usr/bin/cat", "/usr/bin/head", "/usr/bin/wc"]

with open(CONFIG_PATH) as f:
    data = json.load(f)

agents = data.setdefault("agents", {})
allowlist = agents.setdefault(AGENT_ID, {}).setdefault("allowlist", [])
existing = {e.get("pattern") for e in allowlist}
now_ms = int(time.time() * 1000)

for pattern in READ_ONLY_BINS:
    if pattern in existing:
        continue
    allowlist.append({
        "id": str(uuid.uuid4()),
        "pattern": pattern,
        "source": "allow-always",
        "lastUsedAt": now_ms,
    })

with open(CONFIG_PATH, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
```

Resolve binary paths with `which <bin>` on the target host first -- patterns
match the resolved path (or the basename, for patterns without a path
separator), not an unresolved command name. Back up `exec-approvals.json`
before editing (this is production state, not versioned config), and restart
`claudio-w-openclaw.service` afterward -- this file is read at process start,
same as `openclaw.json`. This scales to any agent on any OpenClaw deployment
that has its own `exec-approvals.json`, not only claudio-w's.

For a faster, temporary alternative that doesn't touch this file at all, use
`elevated` (above) for a short investigation window instead of permanently
widening the allowlist.

A direct edit of `exec-approvals.json`/`openclaw.json` (agent-wide,
permanent) requires restarting `claudio-w-openclaw.service` for the running
gateway process to pick it up. `elevated` never requires a restart.

## Approval cards

Approval cards are sent as XEP-0050 command items with `expires-at-ms`. Clients
must render command items as the sticky action surface, not duplicate them as
quick buttons inside the message bubble. Stale approval actions should disappear
from live UI and from restored local history.

## Agent avatars

Agents should use the gateway method `xmpp.avatar.set` instead of shelling out.
Parameters:

- `source`: local image path or HTTP(S) URL. PNG, JPEG, GIF, and WebP are
  accepted.
- `accountId`: optional XMPP account id, such as `clawdio`, `bob`, or `odiseo`.

If `source` is under `/agents/<id>/` or `/workspaces/<id>/`, the gateway infers
`accountId=<id>` automatically. `main` maps to `clawdio`.

The gateway publishes both XEP-0084 and XEP-0153 avatar data, then telemetry
presence re-announces the avatar hash so clients refresh their roster cache.
