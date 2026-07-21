-- Honors urn:xmpp:hints (<no-store/>, <no-permanent-store/>) for offline
-- delivery and push, the same way mod_mam already does for archiving.
--
-- mod_offline and mod_cloud_notify (stock Prosody modules) never look at
-- urn:xmpp:hints — a stanza tagged <no-store/> (the gateway sends this on
-- every XEP-0308 streaming edit, see openclaw-xmpp src/progress.ts) still
-- gets archived offline and still fires a push if the recipient is
-- disconnected at that instant. Only mod_mam respects the hint, so
-- streaming avoids MAM but not the push burst.
--
-- Both message/offline/handle and smacks-hibernation-stanza-queued use
-- Prosody's generic "first handler to return non-nil wins" event dispatch
-- (util/events.lua fire_event), so a same-named hook registered with higher
-- priority than the stock modules' default (0) runs first and can short-
-- circuit them by returning true — without patching mod_offline or
-- mod_cloud_notify themselves.
--
-- Deploy: copy into a plugin path Prosody loads modules from (this server
-- uses /usr/local/lib/prosody/modules, see plugin_paths in prosody.cfg.lua),
-- add "push_hints_filter" to modules_enabled in prosody.cfg.lua. A module
-- new to modules_enabled did NOT get picked up by `systemctl reload`
-- (SIGHUP) on this server/Prosody version in practice — it only reloaded
-- vhost TLS certs. Needed `systemctl restart prosody` to actually load it;
-- confirmed by the "push_hints_filter loaded" log line at startup.

local function has_no_store_hint(stanza)
	return stanza:get_child("no-store", "urn:xmpp:hints") ~= nil
		or stanza:get_child("no-permanent-store", "urn:xmpp:hints") ~= nil;
end

module:hook("message/offline/handle", function(event)
	local stanza = event.stanza;
	if stanza and has_no_store_hint(stanza) then
		module:log("debug", "Skipping offline store/push for %s (no-store hint)", tostring(stanza.attr.id));
		return true; -- consumed: neither mod_offline nor mod_cloud_notify run
	end
	return nil; -- fall through to the stock handlers
end, 100);

module:hook("smacks-hibernation-stanza-queued", function(event)
	local stanza = event.stanza;
	if stanza and has_no_store_hint(stanza) then
		module:log("debug", "Skipping smacks-queued push for %s (no-store hint)", tostring(stanza.attr.id));
		return true; -- consumed: mod_cloud_notify's process_smacks_stanza never runs
	end
	return nil;
end, 100);

module:log("info", "push_hints_filter loaded: urn:xmpp:hints now suppresses offline-store push");
