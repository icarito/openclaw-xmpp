# OpenClaw XMPP plugin — agent guide

This repository owns the `@openclaw/xmpp` channel plugin for OpenClaw 2026.6.9
or newer. Feature work follows OpenSpec: explore or propose under `openspec/`,
apply the checklist, verify, review, then archive with the `opsx:*` commands.

## Verification

Install dependencies with `npm install` and run `npx tsc --noEmit`. Keep SDK
compatibility failures separate from regressions introduced by the change and
record any pre-existing blocker explicitly.

## Deployment trap

This checkout is not the running service. Production loads
`/opt/claudio-w/repos/openclaw-xmpp` (a Git clone pinned at a release tag,
registered via `plugins.load.paths`), not this working tree. Never claim a
deployment from a local build and never touch production from a delegated
change. Installing this transport on a *standard* OpenClaw is documented in
`INSTALL.md`.

Operational details are in `OPERATIONS.md`; upstream-port notes are in
`PORT-NOTES.md`.

