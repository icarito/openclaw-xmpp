## ADDED Requirements

### Requirement: No content overwrite on turn close without delivery
When a turn ends without `dispatchReply` ever invoking `deliver()` (for
example, because a stuck tool-call approval was force-aborted by session
recovery), the system SHALL NOT overwrite a progress bubble that already
contains substantive agent-generated content (non-empty `compositorText` or
`partialText`) with a generic "no reply" placeholder.

#### Scenario: Turn aborted mid-response with visible partial text
- **WHEN** a turn's progress bubble already shows agent-generated text
  (`partialText` non-empty) and the turn closes via `finishWithoutReply`
  because `deliveredVisibleReply` was never set to `true`
- **THEN** the bubble is left showing the existing content instead of being
  replaced by "Turno completado sin respuesta visible."

#### Scenario: Turn genuinely produces no visible output
- **WHEN** a turn closes via `finishWithoutReply` and the progress bubble
  has no substantive content (tool-only turn, no text ever composed)
- **THEN** the bubble is finalized with the existing generic "no reply"
  placeholder text, unchanged from current behavior

### Requirement: No duplicate bubble for a reprocessed turn
While a progress bubble is live for a turn in flight (a `progressMessageId`
already exists for that turn), a reprocessing of the same inbound message
SHALL NOT create a second, separate bubble via `sendMessageXmpp`.

#### Scenario: Same inbound message reprocessed while a bubble is live
- **WHEN** the inbound handler is invoked again for what is identifiably
  the same turn (same message id) while a progress bubble for that turn is
  still live
- **THEN** the existing bubble is reused/edited rather than a new bubble
  being sent

#### Scenario: Genuinely new turn after previous one finalized
- **WHEN** a new inbound message starts a new turn after the previous
  turn's bubble was finalized (consumed via `finalizeWithFinalText` or
  `finishWithoutReply`)
- **THEN** a new bubble is created normally, unchanged from current behavior
