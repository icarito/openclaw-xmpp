## MODIFIED Requirements

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

## ADDED Requirements

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
