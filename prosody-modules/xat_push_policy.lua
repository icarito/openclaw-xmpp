-- Política de notificaciones anti-ruido, compartida por los bridges de push
-- de xat (FCM/APNs). El problema que resuelve: el cliente Android anterior
-- notificaba de más, repetitivo y poco informativo (un aviso por mensaje,
-- incluyendo progreso de herramientas y ediciones intermedias).
--
-- Objetivo: poco volumen, agrupado y útil. Reglas:
--   1. Sólo contenido sustantivo: se descarta "ruido" (progreso de
--      herramienta, recibos, estados de comando). Las ediciones intermedias
--      de streaming ya no llegan acá: mod_push_hints_filter corta el push de
--      los stanzas con <no-store/> antes de mod_cloud_notify.
--   2. Agrupar por conversación en una ventana (default 60 s), con un id
--      ESTABLE (el bare del remitente) para que el sistema RECHACE en vez de
--      apilar: una sola notificación por conversación que se actualiza con el
--      contador y el último preview.
--   3. Prioridad según contenido: un pedido de aprobación/acción se notifica
--      de inmediato (sin esperar la ventana) y con prioridad alta.
--   4. Silencio nocturno opcional para lo no-accionable.
--
-- Los pushes del servidor sólo llegan cuando no hay un cliente conectado
-- (mod_cloud_notify); con la app abierta avisa la UI in-app.

-- Los `require` de Prosody se hacen lazy (dentro de las funciones que los usan)
-- para que la política pura sea cargable/testeable fuera de Prosody.

local M = {};

local function urlencode(s)
	return (tostring(s):gsub("[^%w%-%._~]", function (c)
		return string.format("%%%02X", string.byte(c));
	end));
end

-- --- Política pura (testeable) ---

-- No es contenido del usuario. Patrones ASCII (Lua patterns son byte-based:
-- no se matchean emojis con clases). El prefijo de herramienta (🔧/🛠) se
-- chequea aparte con find literal.
local NOISE = {
	"^Exec failed",
	"^Using tool",
	"^Herramienta:",
	"^Command submitted",
	"^Command expired",
	"^Recibido[%s·%.%-]*preparando",
	"^%.%.%.%s*$",
};

function M.is_noise(body)
	if type(body) ~= "string" or body:match("^%s*$") then
		return true;
	end
	if body:find("🔧", 1, true) or body:find("🛠", 1, true) then
		return true;
	end
	for _, p in ipairs(NOISE) do
		if body:match(p) then
			return true;
		end
	end
	return false;
end

-- Requiere al usuario (aprobación/autorización): se notifica ya.
local ACTIONABLE = { "aprob", "approval", "/approve", "necesita tu", "autoriz", "authorize", "requiere tu" };

function M.is_actionable(body)
	if type(body) ~= "string" then
		return false;
	end
	local low = body:lower();
	for _, p in ipairs(ACTIONABLE) do
		if low:match(p) then
			return true;
		end
	end
	return false;
end

-- Preview de una línea, acotado.
function M.preview(body, max_len)
	if type(body) ~= "string" then
		return "";
	end
	local one = body:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "");
	max_len = max_len or 120;
	if #one > max_len then
		one = one:sub(1, max_len - 1) .. "…";
	end
	return one;
end

-- Silencio nocturno (horas locales del servidor). `quiet` es
-- { enabled=bool, start_hour=23, end_hour=8 }.
function M.in_quiet(quiet, now_hour)
	if not quiet or not quiet.enabled then
		return false;
	end
	local h = now_hour;
	if h == nil then
		if not os or not os.date then
			return false;
		end
		h = tonumber(os.date("%H"));
	end
	if h == nil then
		return false;
	end
	local s = quiet.start_hour or 23;
	local e = quiet.end_hour or 8;
	if s == e then
		return false;
	end
	if s < e then
		return h >= s and h < e;
	end
	return h >= s or h < e; -- ventana que cruza medianoche
end

-- --- Instalador de los hooks XEP-0357 ---

-- conf:
--   service_jid      jid que registra el cliente
--   send(payload, username)  entrega real (por HTTP al push-sender)
--   is_token(token)  valida el token del proveedor
--   default_title, default_body, channel_id
--   coalesce_seconds ventana de agrupamiento (default 60)
--   quiet            { enabled, start_hour, end_hour }
function M.install(module, conf)
	local st = require "util.stanza";
	local coalesce_window = conf.coalesce_seconds or 60;
	-- key: username .. "\0" .. sender_bare -> { timer, count, token, title,
	--      body, priority, channel_id, data, collapse, username }
	local pending = {};

	local function flush(key)
		local p = pending[key];
		pending[key] = nil;
		if not p then
			return;
		end
		local body = p.body;
		if p.count > 1 then
			-- Agrupa sin perder el remitente: título = remitente, cuerpo =
			-- preview del último + cuántos más.
			body = ("%s (+%d)"):format(p.body, p.count - 1);
		end
		conf.send({
			token = p.token;
			title = p.title;
			body = body;
			priority = p.priority;
			channelId = p.channel_id;
			data = p.data;
			collapse = p.collapse; -- id estable: reemplaza, no apila
			count = p.count;
		}, p.username);
	end

	local function queue(username, sender_bare, token, title, body, priority, data)
		local key = tostring(username) .. "\0" .. tostring(sender_bare);
		local collapse = sender_bare or tostring(username);
		local p = pending[key];
		if p then
			p.count = p.count + 1;
			p.body = body; -- preview más reciente
			if priority == "high" then
				p.priority = "high";
			end
			p.data = data;
			p.timer:reschedule(coalesce_window);
		else
			local entry = {
				count = 1;
				token = token;
				title = title;
				body = body;
				priority = priority;
				channel_id = conf.channel_id or "xmpp_messages";
				data = data;
				collapse = collapse;
				username = username;
			};
			entry.timer = module:add_timer(coalesce_window, function ()
				flush(key);
			end);
			pending[key] = entry;
		end
	end

	module:hook("cloud_notify/registration", function (event)
		local push_info = event.push_info;
		if not push_info or push_info.jid ~= conf.service_jid then
			return nil;
		end
		if not conf.is_token(push_info.node) then
			module:log("warn", "Rejected push registration with invalid token node from %s", tostring(event.stanza.attr.from));
			event.origin.send(st.error_reply(event.stanza, "modify", "bad-request", "Invalid push token"));
			return false;
		end
		module:log("info", "Accepted push registration for %s", tostring(event.stanza.attr.from));
		return nil;
	end, 100);

	module:hook("cloud_notify/push", function (event)
		local push_info = event.push_info;
		if not push_info or push_info.jid ~= conf.service_jid then
			return nil;
		end
		local token = push_info.node;
		if not conf.is_token(token) then
			module:log("warn", "Skipping push with invalid token for %s", tostring(event.username));
			return true;
		end

		-- SÓLO mensajes nuevos con contenido. Antes cualquier stanza sin <body>
		-- caía al texto genérico "Tienes un mensaje nuevo", así que los eventos
		-- PEP de los agentes (pubsub) y los chat states/recibos despertaban el
		-- teléfono a cualquier hora. Filtramos por tipo y por contenido real.
		local stanza = event.stanza;
		local has_body = false;
		local has_content = false; -- cifrado (OMEMO) o adjunto OOB: contenido sin <body>
		if stanza and stanza.attr then
			local st_type = stanza.attr.type;
			if st_type == "headline" or st_type == "error" then
				module:log("debug", "Suppressing non-chat push (type=%s)", tostring(st_type));
				return true;
			end
			if stanza:get_child("event", "http://jabber.org/protocol/pubsub#event") then
				module:log("debug", "Suppressing PEP/pubsub push for %s", tostring(event.username));
				return true;
			end
			has_body = stanza:get_child("body") ~= nil;
			has_content = stanza:get_child("encrypted") ~= nil
				or stanza:get_child("x", "jabber:x:oob") ~= nil;
			if not event.important and not has_body and not has_content then
				module:log("debug", "Suppressing push without body for %s", tostring(event.username));
				return true;
			end
		end

		local summary = event.push_summary or {};
		local sender = summary["last-message-sender"];
		local sender_bare = sender and (sender:gsub("/.*$", "")) or nil;
		-- Carbons propios: notificarse las frases propias es flood.
		local own_bare = event.username and (event.username .. "@" .. module.host) or nil;
		if sender_bare and own_bare and sender_bare == own_bare then
			return true;
		end

		local raw = summary["last-message-body"];
		if not raw or raw == "New Message!" then
			-- Sin cuerpo en claro: si es cifrado/adjunto sigue siendo un mensaje
			-- nuevo; si no, no inventamos el texto genérico (salvo acciones).
			if event.important then
				raw = conf.default_body or "Tienes un mensaje nuevo";
			elseif has_content then
				raw = conf.encrypted_body or "Mensaje cifrado";
			elseif has_body then
				raw = conf.default_body or "Tienes un mensaje nuevo";
			else
				module:log("debug", "Suppressing bodyless push for %s", tostring(event.username));
				return true;
			end
		end
		-- 1. Ruido: nunca.
		if M.is_noise(raw) then
			module:log("debug", "Suppressing noisy push for %s", tostring(sender_bare));
			return true;
		end

		local actionable = event.important or M.is_actionable(raw);
		-- 4. Silencio nocturno (excepto acciones).
		if not actionable and M.in_quiet(conf.quiet) then
			module:log("debug", "Suppressing push in quiet hours for %s", tostring(sender_bare));
			return true;
		end

		local name = sender_bare and (sender_bare:gsub("@.*$", "")) or (conf.default_title or "Nuevo mensaje");
		local data = {
			type = "xmpp_message";
			jid = sender_bare or sender;
			url = sender_bare and ("/xmpp-chat/" .. urlencode(sender_bare)) or nil;
		};

		-- 3. Acción pendiente: inmediata, alta prioridad (sin esperar la ventana).
		if actionable and coalesce_window > 0 then
			queue(event.username, sender_bare, token, name, M.preview(raw), "high", data);
			local key = tostring(event.username) .. "\0" .. tostring(sender_bare);
			if pending[key] then
				pending[key].timer:reschedule(0);
			end
			return true;
		end

		local priority = actionable and "high" or "normal";
		if coalesce_window <= 0 then
			conf.send({
				token = token; title = name; body = M.preview(raw); priority = priority;
				channelId = conf.channel_id or "xmpp_messages"; data = data;
				collapse = sender_bare or tostring(event.username); count = 1;
			}, event.username);
			return true;
		end

		queue(event.username, sender_bare, token, name, M.preview(raw), priority, data);
		return true;
	end, 100);

	return {
		coalesce_window = coalesce_window;
	};
end

-- Fábrica del `send` por HTTP hacia el push-sender (contrato común).
function M.http_sender(module, endpoint, auth, extra)
	local http = require "net.http";
	local json = require "util.json";
	return function (payload, username)
		if not endpoint then
			module:log("warn", "push skipped for %s: endpoint no configurado", tostring(username));
			return;
		end
		if extra then
			extra(payload);
		end
		local headers = {
			["Content-Type"] = "application/json";
			["Accept"] = "application/json";
		};
		if auth then
			headers["Authorization"] = "Bearer " .. auth;
		end
		http.request(endpoint, {
			method = "POST";
			headers = headers;
			body = json.encode(payload);
		}, function (response_body, code)
			if code ~= 200 then
				module:log("warn", "push failed for %s: HTTP %s %s", tostring(username), tostring(code), tostring(response_body));
			else
				module:log("debug", "push accepted for %s", tostring(username));
			end
		end);
	end;
end

return M;
