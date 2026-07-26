## REMOVED Requirements

### Requirement: Temporary session-scoped exec bypass

**Reason**: Replaced by `xmpp-elevated-session`'s "Temporary session-scoped
elevated bypass". Both resolved the same operator need (relax exec approval
for the current session, temporarily, without editing config or
restarting the gateway) via two independently-invented mechanisms with
confusingly similar names — `approval-bypass` patched `execSecurity`/
`execAsk` directly, while the core-native `elevated` command (via
`SessionEntry.elevatedLevel`) already existed for the same purpose without
this plugin exposing it. This change consolidates on the core-native
mechanism instead of maintaining a parallel, plugin-owned one.

**Migration**: Callers (gtk-llm-chat, gtk-llm-chat-android) invoke the new
`elevated` command with the same `mode`/`minutes` parameters instead of
`approval-bypass`. The result contract (`<note>` + structured result form
with `active`, `mode`, `expires-at-ms`, `remaining-seconds`) is unchanged in
shape, so client-side parsing code needs only the node name updated, not the
field-reading logic.

### Requirement: Bypass state survives gateway restart

**Reason**: Same as above — the fail-closed persistence mechanism
(temporizer + `pluginExtensions` record + startup sweep) is reimplemented
for `elevatedLevel` under `xmpp-elevated-session`'s "Elevated bypass state
survives gateway restart", rather than duplicated for two parallel bypass
mechanisms.

**Migration**: No client-visible migration needed; this requirement governed
server-side persistence only.

### Requirement: Structured bypass status via XEP-0004 result form

**Reason**: Same consolidation — `xmpp-elevated-session`'s "Structured
elevated status via XEP-0004 result form" provides the identical field
contract under the new command name.

**Migration**: Clients read the same fields (`active`, `mode`,
`expires-at-ms`, `remaining-seconds`) from the `elevated` command's result
form instead of `approval-bypass`'s.
