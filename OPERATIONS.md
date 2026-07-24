# XMPP gateway operations

## Approval modes

The XMPP extension exposes two distinct ad-hoc command nodes. They are NOT
aliases of each other -- they have different scope, persistence, and
mechanics:

- `approval-mode`: agent-wide, persistent policy change. Edits
  `openclaw.json` on disk (`tools.exec`); requires restarting
  `claudio-w-openclaw.service` for the running gateway process to pick it
  up. Affects every session of the agent, on every channel.
- `approval-bypass`: session-scoped, temporary policy relaxation. Patches
  `execSecurity`/`execAsk` directly on the invoking session's entry in the
  session store (in-process, via `getSessionEntry`/`patchSessionEntry` from
  `openclaw/plugin-sdk/session-store-runtime`) -- no config file write, no
  restart. Auto-reverts after a configurable number of minutes (default 10,
  max 60) via an in-memory timer in the plugin process; can also be turned
  off early. If the gateway restarts while a bypass is active, the timer is
  lost and the relaxed session state persists until manually reverted (see
  openspec change `xmpp-approval-bypass-and-fallback-cleanup` design.md for
  the full rationale).

Neither command starts an agent turn, so changing approval policy cannot
itself create an approval loop.

Both are available through XEP-0050 when the client targets the gateway's
full resource JID, and through the universal textual fallback:

```text
/oc approval-mode status
/oc approval-mode auto
/oc approval-bypass on 10
/oc approval-bypass status
/oc approval-bypass off
```

`approval-mode` supported `mode` values:

- `status`: report the current exec policy.
- `ask`: restore human approval for exec misses.
- `auto` or `on`: use conservative allowlist mode with `ask=on-miss` and the
  flash reviewer (`kilo/deepseek-v4-flash`). Trivial commands may pass through
  the allowlist; command misses are reviewed and fall back to human approval on
  risk, timeout, or uncertainty.
- `full`: broad bypass for short emergency windows only, manual revert.
- `deny`: block exec through core policy.
- `off`: compatibility value that maps back to `ask`.

`approval-bypass` supported `mode` values:

- `on`: activate the bypass for this session, for `minutes` (default 10, max
  60).
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
`approval-bypass` (above) for a short investigation window instead of
permanently widening the allowlist.

After a mutating `approval-mode` command, restart `claudio-w-openclaw.service`
for the running gateway process to pick up the edited `openclaw.json`.
`approval-bypass` never requires a restart.

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
