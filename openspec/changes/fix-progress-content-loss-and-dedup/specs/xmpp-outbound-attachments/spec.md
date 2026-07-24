## ADDED Requirements

### Requirement: Outbound file attachment via HTTP Upload
The xmpp channel SHALL support the `upload-file` message action by
uploading the given local file to the account's discovered XEP-0363 HTTP
Upload service and sending the resulting URL as a message to the target
JID, instead of rejecting the action as unsupported.

#### Scenario: Agent sends a local file to a contact
- **WHEN** an agent invokes the `upload-file` action with a local file path
  and a target XMPP JID
- **THEN** the file is uploaded via the account's HTTP Upload service and a
  message containing the resulting URL is delivered to the target, and the
  action does not fail with "Message action upload-file not supported for
  channel xmpp"

#### Scenario: HTTP Upload service unavailable for the account's domain
- **WHEN** an agent invokes `upload-file` and the account's domain has no
  discoverable XEP-0363 upload service
- **THEN** the action fails with an explicit error identifying the missing
  upload service, rather than the generic "not supported for channel xmpp"
  error
