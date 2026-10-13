-- Puente entre XEP-0357 (cloud_notify) y Firebase Cloud Messaging (FCM), para
-- clientes Android que registran un token FCM.
--   <enable xmlns="urn:xmpp:push:0" jid="fcm-push.<host>" node="<token FCM>">
--     <ignore-unknown xmlns="tigase:push:filter:ignore-unknown:0"/>
--     ...
--   </enable>
--
-- No habla FCM directo (no hay SDK en Lua): forwardea por HTTP al push-sender
-- (ver prosody-modules/push-sender/README.md). La política anti-ruido
-- (agrupamiento por conversación, id estable para reemplazar en vez de apilar,
-- prioridad de acciones, silencio) vive en xat_push_policy.lua.

-- Helper hermano: se resuelve relativo al propio módulo (module.path), así no
-- depende de package.path ni de que plugin_paths esté en él.
local policy_dir = (module.path and module.path:match("^(.*[/\\])")) or "/usr/local/lib/prosody/modules/";
local policy = dofile(policy_dir .. "xat_push_policy.lua");

local service_jid = module:get_option_string("fcm_push_service_jid", "fcm-push." .. module.host);
-- Sin default a propósito: apuntarlo al push-sender desplegado. Si no está
-- configurado, el módulo loguea warn y no envía nada.
local endpoint = module:get_option_string("fcm_push_endpoint");
local auth = module:get_option_string("fcm_push_auth");

-- Un token FCM es una cadena opaca (típicamente ~163 chars). Rechazamos
-- cualquier cosa con espacios o de longitud absurda antes de mandarla al
-- endpoint: un node vacío o con basura solo genera 400s del proveedor.
local function is_fcm_token(token)
	if type(token) ~= "string" then return false; end
	if token:match("%s") then return false; end
	local len = #token;
	return len >= 20 and len <= 4096;
end

policy.install(module, {
	service_jid = service_jid;
	send = policy.http_sender(module, endpoint, auth);
	is_token = is_fcm_token;
	default_title = module:get_option_string("fcm_push_title", "Nuevo mensaje");
	default_body = module:get_option_string("fcm_push_body", "Tienes un mensaje nuevo");
	channel_id = module:get_option_string("fcm_push_channel_id", "xmpp_messages");
	coalesce_seconds = module:get_option_number("fcm_push_coalesce_seconds", 60);
	quiet = {
		enabled = module:get_option_boolean("fcm_push_quiet_enabled", false);
		start_hour = module:get_option_number("fcm_push_quiet_start", 23);
		end_hour = module:get_option_number("fcm_push_quiet_end", 8);
	};
});

if not endpoint then
	module:log("warn", "FCM push bridge loaded for %s but fcm_push_endpoint is not set; no pushes will be sent", service_jid);
else
	module:log("info", "FCM push bridge loaded for %s (endpoint: %s)", service_jid, endpoint);
end
