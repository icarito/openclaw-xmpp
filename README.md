# @openclaw/xmpp

XMPP channel plugin for OpenClaw (2026.6.9+). The source repository is
`icarito/openclaw-xmpp`.

**To install this transport on a standard OpenClaw with your own Prosody
server, start here: [`INSTALL.md`](./INSTALL.md)** — it contains a copy-paste
prompt for an implementing agent, the Prosody requirements, how to connect
existing agents, and sane defaults that mirror the native Telegram transport.

## Repository and server mapping

The production service (the `claudio-w` gateway) loads this repository as a
Git clone at `/opt/claudio-w/repos/openclaw-xmpp` (detached at a release tag),
registered via `plugins.load.paths`. The older tree at
`/opt/claudio-w/extensions-xmpp-src/` is retired and no longer referenced.

The gateway applies a set of patches to the OpenClaw core bundle that the
inline exec-approval path depends on; those patches live only on the server
(`/opt/claudio-w/scripts/apply-openclaw-patches.py`) and are **not** versioned
here. See `INSTALL.md` §6.

Operational details are in `OPERATIONS.md`; upstream-port notes are in
`PORT-NOTES.md`; the client contract for ad-hoc clients is in `HOOKS.md`.

