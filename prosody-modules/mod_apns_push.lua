-- Puente entre XEP-0357 (cloud_notify) y Apple Push Notification service
-- (APNs) para clientes iOS que registran un token APNs (hex).
--   <enable xmlns="urn:xmpp:push:0" jid="apns-push.<host>" node="<hex>"/>
--
-- Igual que mod_fcm_push: forwardea por HTTP al push-sender, que es quien habla
-- APNs (auth por token .p8). La política anti-ruido es compartida
-- (xat_push_policy.lua).

local policy_dir = (module.path and module.path:match("^(.*[/\\])")) or "/usr/local/lib/prosody/modules/";
local policy = dofile(policy_dir .. "xat_push_policy.lua");

local service_jid = module:get_option_string("apns_push_service_jid", "apns-push." .. module.host);
local endpoint = module:get_option_string("apns_push_endpoint");
local auth = module:get_option_string("apns_push_auth");

-- Token APNs: hex (64 chars típico; toleramos 32..512).
local function is_apns_token(token)
	if type(token) ~= "string" then return false; end
	if not token:match("^%x+$") then return false; end
	local len = #token;
	return len >= 32 and len <= 512;
end

policy.install(module, {
	service_jid = service_jid;
	-- APNs: el payload siempre lleva `aps` (ver push-sender).
	send = policy.http_sender(module, endpoint, auth, function (payload)
		payload.aps = { sound = "default" };
	end);
	is_token = is_apns_token;
	default_title = module:get_option_string("apns_push_title", "Nuevo mensaje");
	default_body = module:get_option_string("apns_push_body", "Tienes un mensaje nuevo");
	channel_id = module:get_option_string("apns_push_channel_id", "xmpp_messages");
	coalesce_seconds = module:get_option_number("apns_push_coalesce_seconds", 60);
	quiet = {
		enabled = module:get_option_boolean("apns_push_quiet_enabled", false);
		start_hour = module:get_option_number("apns_push_quiet_start", 23);
		end_hour = module:get_option_number("apns_push_quiet_end", 8);
	};
});

if not endpoint then
	module:log("warn", "APNs push bridge loaded for %s but apns_push_endpoint is not set; no pushes will be sent", service_jid);
else
	module:log("info", "APNs push bridge loaded for %s (endpoint: %s)", service_jid, endpoint);
end
