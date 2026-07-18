# @openclaw/xmpp

XMPP channel plugin for OpenClaw. The source repository is
`icarito/openclaw-xmpp`; `claudio-w` pins it as the submodule
`extensions/xmpp`.

## Repository and server mapping

The production service does **not** execute this checkout or the submodule
directly. It currently loads a separately synchronized tree at
`/opt/claudio-w/extensions-xmpp-src/`. Migrating that directory to a Git
checkout of this repository is tracked as a follow-up in
`claudio-w/openspec/ROADMAP.md`; it is deliberately not part of repository
setup or ordinary feature changes.

