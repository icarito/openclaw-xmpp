-- Bridge XEP-0357 cloud_notify registrations to Expo Push Service.
-- Clients register with:
--   <enable xmlns="urn:xmpp:push:0" jid="expo-push.hablar.fuentelibre.org" node="ExpoPushToken[...]"/>

local http = require "net.http";
local json = require "util.json";
local st = require "util.stanza";

local service_jid = module:get_option_string("expo_push_service_jid", "expo-push." .. module.host);
local endpoint = module:get_option_string("expo_push_endpoint", "https://exp.host/--/api/v2/push/send");
local default_title = module:get_option_string("expo_push_title", "Nuevo mensaje XMPP");
local default_body = module:get_option_string("expo_push_body", "Tienes un mensaje nuevo");
local channel_id = module:get_option_string("expo_push_channel_id", "xmpp_messages");
-- Ventana de agrupamiento: varios pushes consecutivos del mismo remitente
-- (streaming con pausas, ráfaga de reconexión) se colapsan en uno solo en
-- vez de golpear al usuario con una notificación por mensaje. mod_cloud_notify
-- ya agrupa DENTRO de una ventana de 1s de smacks; esto agrupa a lo largo de
-- ráfagas más largas, del lado del puente Expo.
local coalesce_window = module:get_option_number("expo_push_coalesce_seconds", 8);

local function bare_jid(jid)
	if type(jid) ~= "string" then return nil; end
	return (jid:gsub("/.*$", ""));
end

-- El jid viaja DENTRO de una ruta de expo-router: sin escapar, el "@" (y el "/"
-- del recurso) rompen el match y al tocar la notificación la app cae a una ruta
-- no reconocida.
local function urlencode(s)
	return (tostring(s):gsub("[^%w%-%._~]", function (c)
		return string.format("%%%02X", string.byte(c));
	end));
end

-- Título legible: "rolando", no "rolando@hablar.fuentelibre.org/openclaw".
local function display_name(jid)
	local bare = bare_jid(jid);
	if not bare then return nil; end
	return (bare:gsub("@.*$", ""));
end

local function is_expo_token(token)
	return type(token) == "string"
		and (
			token:match("^ExpoPushToken%[[^%]]+%]$")
			or token:match("^ExponentPushToken%[[^%]]+%]$")
		);
end

local function send_expo_push(payload, username)
	http.request(endpoint, {
		method = "POST";
		headers = {
			["Content-Type"] = "application/json";
			["Accept"] = "application/json";
		};
		body = json.encode(payload);
	}, function (response_body, code)
		if code ~= 200 then
			module:log("warn", "Expo push failed for %s: HTTP %s %s", tostring(username), tostring(code), tostring(response_body));
		else
			module:log("debug", "Expo push accepted for %s", tostring(username));
		end
	end);
end

-- key: username .. "\0" .. sender_bare -> { timer, count, token, title, body, priority, channel_id, data, username }
local pending = {};

local function flush_pending(key)
	local p = pending[key];
	pending[key] = nil;
	if not p then return; end

	local payload = {
		to = p.token;
		sound = "default";
		title = p.title;
		priority = p.priority;
		channelId = p.channel_id;
		data = p.data;
	};
	if p.count > 1 then
		payload.body = ("Tienes %d mensajes nuevos"):format(p.count);
	else
		payload.body = p.body;
	end

	send_expo_push(payload, p.username);
end

module:hook("cloud_notify/registration", function (event)
	local push_info = event.push_info;
	if not push_info or push_info.jid ~= service_jid then
		return nil;
	end

	if not is_expo_token(push_info.node) then
		module:log("warn", "Rejected Expo push registration with invalid token node from %s", tostring(event.stanza.attr.from));
		event.origin.send(st.error_reply(event.stanza, "modify", "bad-request", "Invalid Expo push token"));
		return false;
	end

	module:log("info", "Accepted Expo push registration for %s", tostring(event.stanza.attr.from));
	return nil;
end, 100);

module:hook("cloud_notify/push", function (event)
	local push_info = event.push_info;
	if not push_info or push_info.jid ~= service_jid then
		return nil;
	end

	local token = push_info.node;
	if not is_expo_token(token) then
		module:log("warn", "Skipping Expo push with invalid token for user %s", tostring(event.username));
		return true;
	end

	local summary = event.push_summary or {};
	local sender = summary["last-message-sender"];
	local body = summary["last-message-body"];
	if not body or body == "New Message!" then
		body = default_body;
	end

	-- Los carbons de los mensajes que envía el propio usuario también pasan por
	-- aquí: notificárselos le hace flood con sus propias frases.
	local sender_bare = bare_jid(sender);
	local own_bare = event.username and (event.username .. "@" .. module.host) or nil;
	if sender_bare and own_bare and sender_bare == own_bare then
		module:log("debug", "Skipping Expo push for own carbon (%s)", tostring(sender));
		return true;
	end

	local data = {
		type = "xmpp_message";
		jid = sender_bare or sender;
		url = sender_bare and ("/xmpp-chat/" .. urlencode(sender_bare)) or nil;
	};

	if coalesce_window <= 0 then
		send_expo_push({
			to = token;
			sound = "default";
			title = display_name(sender) or default_title;
			body = body;
			priority = event.important and "high" or "normal";
			channelId = channel_id;
			data = data;
		}, event.username);
		return true;
	end

	local key = tostring(event.username) .. "\0" .. tostring(sender_bare or sender);
	local p = pending[key];
	if p then
		-- Ya hay una ventana abierta para este remitente: sumar y quedarnos
		-- con el mensaje más reciente como preview si termina siendo el único.
		p.count = p.count + 1;
		p.body = body;
		p.priority = event.important and "high" or p.priority;
		p.timer:reschedule(coalesce_window);
	else
		local entry = {
			count = 1;
			token = token;
			title = display_name(sender) or default_title;
			body = body;
			priority = event.important and "high" or "normal";
			channel_id = channel_id;
			data = data;
			username = event.username;
		};
		entry.timer = module:add_timer(coalesce_window, function ()
			flush_pending(key);
		end);
		pending[key] = entry;
	end

	return true;
end, 100);

module:log("info", "Expo push bridge loaded for %s (coalesce window: %ds)", service_jid, coalesce_window);
