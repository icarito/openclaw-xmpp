# XMPP gateway operations

## Approval modes

The XMPP extension exposes two ad-hoc command nodes:

- `approval-mode`: explicit policy command.
- `approval-bypass`: compatibility alias used by clients.

Both commands are host-side config edits. They do not start an agent turn, so
changing approval policy cannot itself create an approval loop.

Supported `mode` values:

- `status`: report the current exec policy.
- `ask`: restore human approval for exec misses.
- `auto` or `on`: use conservative allowlist mode with `ask=on-miss` and the
  flash reviewer (`kilo/deepseek-v4-flash`). Trivial commands may pass through
  the allowlist; command misses are reviewed and fall back to human approval on
  risk, timeout, or uncertainty.
- `full`: broad bypass for short emergency windows only.
- `deny`: block exec through core policy.
- `off`: compatibility value that maps back to `ask`.

The current server preset intentionally does not put file readers such as `cat`
into `safeBins`; those should go through the reviewer or human approval so
secret reads do not become a static allowlist bypass.

After a mutating command, restart `claudio-w-openclaw.service` for the running
gateway process to pick up the edited `openclaw.json`.

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
