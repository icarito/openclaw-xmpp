# XMPP approval bypass

## Purpose

Let an authorized sender temporarily relax a single session's exec approval
policy, without editing config or restarting the gateway, so a burst of
diagnostic commands doesn't produce one approval card per command.

## Requirements

### Requirement: Temporary session-scoped exec bypass

The plugin SHALL expose an ad-hoc command `approval-bypass`, discoverable
via XEP-0050 disco#items like other native commands, that relaxes exec
approval policy (`execSecurity`/`execAsk`) for the invoking session only, for
a bounded duration, without editing `openclaw.json` and without requiring a
gateway restart.

#### Scenario: Activating bypass for N minutes

- **WHEN** an authorized sender invokes `approval-bypass` with `mode=on` and
  `minutes=10`
- **THEN** the plugin patches the current session's exec policy to a relaxed
  state via the gateway's session-patch mechanism, and confirms the new
  policy and expiration time to the sender

#### Scenario: Auto-reversion after expiration

- **WHEN** the configured duration elapses since activation
- **THEN** the plugin reverts the session's exec policy to the value it had
  immediately before the bypass was activated, without any client needing to
  be connected or to send another command

#### Scenario: Manual early deactivation

- **WHEN** an authorized sender invokes `approval-bypass` with `mode=off`
  while a bypass is active for that session
- **THEN** the plugin immediately reverts the session's exec policy to its
  pre-bypass value and cancels the pending auto-reversion timer

#### Scenario: Status query

- **WHEN** an authorized sender invokes `approval-bypass` with `mode=status`
- **THEN** the plugin reports whether a bypass is currently active for that
  session and, if so, the remaining time before auto-reversion

#### Scenario: Duration exceeds configured maximum

- **WHEN** `approval-bypass` is invoked with `minutes` greater than the
  configured maximum
- **THEN** the plugin clamps the duration to the maximum and informs the
  sender of the clamped value, rather than silently using the requested
  value or rejecting the command

#### Scenario: Unauthorized sender

- **WHEN** a sender not present in the account's `allowFrom` list invokes
  `approval-bypass` with `mode` other than `status`
- **THEN** the plugin rejects the request without changing any session's
  exec policy, consistent with the authorization check already applied to
  `approval-mode`

### Requirement: Bypass state survives gateway restart

The plugin SHALL persist the active bypass's expiration timestamp and
pre-bypass exec policy in the session store, namespaced under the plugin's
own `pluginExtensions` entry, so that a gateway restart during an active
bypass does not leave the session permanently relaxed.

On plugin load, the plugin SHALL sweep all session entries for a persisted
bypass whose expiration has already passed, and revert each one to its
recorded pre-bypass exec policy, clearing the persisted entry afterward.

This replaces the previous requirement ("Bypass state does not survive
gateway restart"), which accepted the fail-open behavior as a documented
risk. The in-memory timer remains the fast path when the process does not
restart; the persisted record is the source of truth for when it does.

#### Scenario: Restart during active bypass, past expiration

- **WHEN** the gateway process restarts, and a session has a persisted
  bypass whose `expiresAtMs` is in the past
- **THEN** the plugin reverts that session's exec policy to its recorded
  pre-bypass value on load, without requiring any client to reconnect or
  send a command

#### Scenario: Restart during active bypass, not yet expired

- **WHEN** the gateway process restarts, and a session has a persisted
  bypass whose `expiresAtMs` is still in the future
- **THEN** the plugin leaves that session's relaxed policy in place (the
  bypass is still legitimately active) and does not attempt to revert it
  during the startup sweep

#### Scenario: Startup sweep with no expired bypasses

- **WHEN** the plugin loads and no session has a persisted bypass past its
  expiration
- **THEN** the sweep completes without reverting any session and without
  emitting any correction or notification

### Requirement: Structured bypass status via XEP-0004 result form

When an `approval-bypass` command completes, the plugin SHALL attach a
`jabber:x:data` form of `type="result"` to the XEP-0050 command result,
alongside the existing human-readable `<note>`, containing at minimum the
fields `active`, `mode`, and (when active) `expires-at-ms` and
`remaining-seconds`.

The plugin SHALL NOT remove or alter the existing `<note>` text as part of
adding this form; the form is additive.

#### Scenario: Status query while a bypass is active

- **WHEN** `approval-bypass` is invoked with `mode=status` and a bypass is
  currently active for the session
- **THEN** the command result includes both the existing `<note>` text and a
  result form with `active=true`, the expiration timestamp, and the
  remaining seconds

#### Scenario: Status query while no bypass is active

- **WHEN** `approval-bypass` is invoked with `mode=status` and no bypass is
  active for the session
- **THEN** the command result includes both the existing `<note>` text and a
  result form with `active=false`

#### Scenario: A client that does not parse the result form

- **WHEN** a client that only reads the `<note>` (any generic XEP-0050
  client, e.g. Gajim's "Execute Command") invokes `approval-bypass
  status`
- **THEN** the client continues to display the human-readable note text
  unaffected by the presence of the additional result form
