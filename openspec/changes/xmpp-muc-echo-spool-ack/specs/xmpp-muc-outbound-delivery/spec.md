## ADDED Requirements

### Requirement: MUC echo confirms an outbound message

When a MUC reflects a message from the account's own nickname, the channel SHALL remove a matching pending outbound spool entry when its `origin-id` and room JID both match the reflected stanza. The reflected stanza SHALL NOT start an inbound agent turn.

#### Scenario: Confirmed room message survives restart without replay

- **WHEN** a pending groupchat message is reflected by its destination MUC from the account's own nickname with the same `origin-id`
- **THEN** the spool marks that message delivered and does not resend it after reconnect or process restart.

#### Scenario: Unrelated room does not confirm delivery

- **WHEN** a stanza carries the same `origin-id` but originates from a different MUC or nickname
- **THEN** the pending entry remains unconfirmed.
