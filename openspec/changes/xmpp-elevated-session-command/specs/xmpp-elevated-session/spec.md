## ADDED Requirements

### Requirement: Temporary session-scoped elevated bypass

The plugin SHALL expose an ad-hoc command `elevated`, discoverable via
XEP-0050 disco#items like other native commands, that relaxes exec approval
policy for the invoking session only, for a bounded duration, by setting the
session's `elevatedLevel` (the core-native override mechanism backed by
`SessionEntry.elevatedLevel`) to `"full"`, without editing `openclaw.json`
and without requiring a gateway restart.

This is the only session-scoped bypass mechanism exposed by this plugin.
`execSecurity`/`execAsk` are not patched directly by this command; the core
already resolves `bypassApprovals` from `elevatedLevel:"full"` provided the
host's `exec-approvals.json` does not have `security`/`ask` explicitly
blocking it (a prerequisite outside this plugin's control, documented in
OPERATIONS.md).

#### Scenario: Activating elevated bypass for N minutes

- **WHEN** an authorized sender invokes `elevated` with `mode=on` and
  `minutes=10`
- **THEN** the plugin patches the current session's `elevatedLevel` to
  `"full"` via the gateway's session-patch mechanism, and confirms the new
  state and expiration time to the sender

#### Scenario: Auto-reversion after expiration

- **WHEN** the configured duration elapses since activation
- **THEN** the plugin reverts the session's `elevatedLevel` to the value it
  had immediately before activation, without any client needing to be
  connected or to send another command

#### Scenario: Manual early deactivation

- **WHEN** an authorized sender invokes `elevated` with `mode=off` while a
  bypass is active for that session
- **THEN** the plugin immediately reverts the session's `elevatedLevel` to
  its pre-bypass value and cancels the pending auto-reversion timer

#### Scenario: Status query

- **WHEN** an authorized sender invokes `elevated` with `mode=status`
- **THEN** the plugin reports whether a bypass is currently active for that
  session and, if so, the remaining time before auto-reversion

#### Scenario: Duration exceeds configured maximum

- **WHEN** `elevated` is invoked with `minutes` greater than the configured
  maximum
- **THEN** the plugin clamps the duration to the maximum and informs the
  sender of the clamped value, rather than silently using the requested
  value or rejecting the command

#### Scenario: Unauthorized sender

- **WHEN** a sender not present in the account's `allowFrom` list invokes
  `elevated` with `mode` other than `status`
- **THEN** the plugin rejects the request without changing any session's
  `elevatedLevel`

#### Scenario: Pre-existing non-default elevatedLevel is preserved on revert

- **WHEN** a session already has `elevatedLevel` set to a value other than
  `"full"` (e.g. `"ask"`) via some other mechanism before `elevated on` is
  invoked
- **THEN** the plugin captures that value as the pre-bypass state and
  restores it exactly (not `"off"`) when the bypass expires or is manually
  deactivated

### Requirement: Elevated bypass state survives gateway restart

The plugin SHALL persist the active bypass's expiration timestamp and
pre-bypass `elevatedLevel` in the session store, namespaced under the
plugin's own `pluginExtensions` entry, so that a gateway restart during an
active bypass does not leave the session permanently elevated.

On plugin load, the plugin SHALL sweep all session entries for a persisted
elevated-bypass whose expiration has already passed, and revert each one to
its recorded pre-bypass `elevatedLevel`, clearing the persisted entry
afterward.

#### Scenario: Restart during active bypass, past expiration

- **WHEN** the gateway process restarts, and a session has a persisted
  elevated-bypass whose `expiresAtMs` is in the past
- **THEN** the plugin reverts that session's `elevatedLevel` to its recorded
  pre-bypass value on load, without requiring any client to reconnect or
  send a command

#### Scenario: Restart during active bypass, not yet expired

- **WHEN** the gateway process restarts, and a session has a persisted
  elevated-bypass whose `expiresAtMs` is still in the future
- **THEN** the plugin leaves that session's elevated state in place (the
  bypass is still legitimately active) and does not attempt to revert it
  during the startup sweep

#### Scenario: Startup sweep with no expired bypasses

- **WHEN** the plugin loads and no session has a persisted elevated-bypass
  past its expiration
- **THEN** the sweep completes without reverting any session and without
  emitting any correction or notification

### Requirement: Structured elevated status via XEP-0004 result form

When an `elevated` command completes, the plugin SHALL attach a
`jabber:x:data` form of `type="result"` to the XEP-0050 command result,
alongside the existing human-readable `<note>`, containing at minimum the
fields `active`, `mode`, and (when active) `expires-at-ms` and
`remaining-seconds`.

The plugin SHALL NOT remove or alter the existing `<note>` text as part of
adding this form; the form is additive.

#### Scenario: Status query while a bypass is active

- **WHEN** `elevated` is invoked with `mode=status` and a bypass is
  currently active for the session
- **THEN** the command result includes both the existing `<note>` text and a
  result form with `active=true`, the expiration timestamp, and the
  remaining seconds

#### Scenario: Status query while no bypass is active

- **WHEN** `elevated` is invoked with `mode=status` and no bypass is active
  for the session
- **THEN** the command result includes both the existing `<note>` text and a
  result form with `active=false`

#### Scenario: A client that does not parse the result form

- **WHEN** a client that only reads the `<note>` (any generic XEP-0050
  client, e.g. Gajim's "Execute Command") invokes `elevated status`
- **THEN** the client continues to display the human-readable note text
  unaffected by the presence of the additional result form
