## ADDED Requirements

### Requirement: Consistent compact text across approval delivery routes

The plugin SHALL render the same compact fallback text for an exec approval
card regardless of which delivery route (native or forwarder-based) sends
it, using the shared compaction logic in all routes.

#### Scenario: Native delivery route

- **WHEN** an approval card is delivered through the native XMPP delivery
  path (`XMPP_NATIVE_APPROVAL_DELIVERY=1`)
- **THEN** the fallback text sent to the client is produced by the same
  compaction function used by the forwarder-based delivery path, not the raw
  core-generated text

#### Scenario: Forwarder delivery route

- **WHEN** an approval card is delivered through the forwarder-based
  delivery path
- **THEN** the fallback text sent to the client is produced by the same
  compaction function used by the native delivery path

### Requirement: No empty fenced code blocks in approval fallback text

The plugin SHALL strip fenced code blocks that contain no content (or only
whitespace) from approval fallback text before sending it, regardless of
which upstream source produced the text.

#### Scenario: Command field empty upstream

- **WHEN** the upstream approval payload's command/warning text is empty and
  the core wraps it in a fenced code block
- **THEN** the compacted fallback text sent to the client omits that empty
  fenced block entirely rather than showing empty triple backticks

#### Scenario: Non-empty fenced blocks are preserved

- **WHEN** the upstream approval payload includes a fenced code block with
  actual command content
- **THEN** the compacted fallback text preserves that block unchanged
