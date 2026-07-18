# OpenClaw XMPP plugin — agent guide

This repository owns the `@openclaw/xmpp` channel plugin for OpenClaw 2026.6.9
or newer. Feature work follows OpenSpec: explore or propose under `openspec/`,
apply the checklist, verify, review, then archive with the `opsx:*` commands.

## Verification

Install dependencies with `npm install` and run `npx tsc --noEmit`. Keep SDK
compatibility failures separate from regressions introduced by the change and
record any pre-existing blocker explicitly.

## Deployment trap

This checkout is not the running service. Production currently loads
`/opt/claudio-w/extensions-xmpp-src/`; never claim a deployment from a local
build and never touch production from a delegated change. `claudio-w` consumes
this repository as the `extensions/xmpp` submodule.

Operational details are in `OPERATIONS.md`; upstream-port notes are in
`PORT-NOTES.md`.

