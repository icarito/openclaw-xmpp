# XMPP inline buttons

## Purpose

Provide optional interactive controls over XMPP without weakening the portable
text response or the existing ad-hoc command path.

## Requirements

### Requirement: Configurable inline-button scope

The plugin MUST accept `off`, `dm`, `group`, `all`, and `allowlist` for
`capabilities.inlineButtons`, defaulting to `off`.

#### Scenario: Direct-message scope

- **WHEN** scope is `dm` and an interactive direct response is sent
- **THEN** the message includes Cheogram query controls and a text fallback

#### Scenario: Disabled scope

- **WHEN** scope is `off`
- **THEN** the response contains only its text fallback

### Requirement: Scope-aware routing

The plugin MUST distinguish direct and MUC targets and MUST evaluate
`allowFrom` when the configured scope is `allowlist`.

#### Scenario: Disallowed recipient

- **WHEN** scope is `allowlist` and the target is not allowed
- **THEN** interactive controls are omitted without suppressing response text

### Requirement: XEP-0050 compatibility

Existing XEP-0050 commands MUST remain usable independently of inline buttons,
and a selected button MUST route as the equivalent explicit answer or command.

#### Scenario: Client without query rendering

- **WHEN** a client ignores Cheogram query controls
- **THEN** the user can still understand the response and use XEP-0050 or text

Implementation background remains in `SPEC-inline-buttons.md`; deployment and
porting constraints remain in `OPERATIONS.md` and `PORT-NOTES.md`.
