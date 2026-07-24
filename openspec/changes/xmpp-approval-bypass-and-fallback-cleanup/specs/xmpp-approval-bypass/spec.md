## ADDED Requirements

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

### Requirement: Bypass state does not survive gateway restart

The plugin SHALL keep bypass expiration state (previous policy, expiry
timestamp, timer) in process memory only, not persisted to disk, so that a
gateway restart during an active bypass clears the auto-reversion timer.

#### Scenario: Restart during active bypass

- **WHEN** the gateway process restarts while a session has an active
  bypass
- **THEN** the in-memory timer is lost and the session's exec policy remains
  at whatever relaxed value was last patched into the session store — no
  automatic reversion occurs from this session, and no error is raised
