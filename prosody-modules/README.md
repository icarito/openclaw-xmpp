# Módulos Prosody

Módulos Lua que corren dentro del propio servidor Prosody
(`hablar.fuentelibre.org`), no en el proceso Node del plugin. Se despliegan
manualmente por SSH — no hay pipeline de build ni CI que los sincronice; este
directorio es el registro versionado de lo que corre en producción, la copia
real vive en `/usr/local/lib/prosody/modules/` del servidor.

- **`mod_expo_push.lua`**: puente entre XEP-0357 (cloud_notify) y Expo Push
  Service, usado por el cliente Android. Incluye una ventana de coalescing
  (`expo_push_coalesce_seconds`, default 8s) que agrupa varios push
  consecutivos del mismo remitente en una sola notificación.
- **`xat_push_policy.lua`**: helper compartido (NO es un módulo: no va en
  `modules_enabled`). Concentra la política anti-ruido de los bridges: agrupa
  por conversación en una ventana, usa un **id estable** (el bare del remitente)
  para que el SO reemplace la notificación en vez de apilar, descarta ruido de
  progreso/recibos, y notifica de inmediato las acciones/aprobaciones. Los
  bridges lo cargan con `dofile` relativo a su propio `module.path`, así que
  **debe estar en el mismo directorio** que `mod_fcm_push.lua`/`mod_apns_push.lua`.
- **`mod_fcm_push.lua`**: puente entre XEP-0357 (cloud_notify) y Firebase
  Cloud Messaging, para clientes Android que registran un token **FCM** en
  lugar de uno Expo. No habla con FCM directo: forwardea por HTTP al
  `push-sender` (ver abajo). JID por defecto `fcm-push.<dominio>`. La política
  (agrupamiento, id estable, ruido, prioridad) sale de `xat_push_policy.lua`.
- **`mod_apns_push.lua`**: puente entre XEP-0357 (cloud_notify) y Apple Push
  Notification service, para clientes iOS que registran un token **APNs**.
  Forwardea por HTTP al `push-sender`. JID por defecto
  `apns-push.<dominio>`.
- **`mod_push_hints_filter.lua`**: hace que `urn:xmpp:hints` (`<no-store/>`,
  `<no-permanent-store/>`) también suprima push/almacenamiento offline, no
  solo el archivado MAM (que ya lo respeta vía `mod_mam` stock). El gateway
  marca cada edición intermedia de streaming XEP-0308 con este hint — sin
  este módulo, esas ediciones igual disparaban push si el destinatario
  estaba desconectado en ese instante.

### Notificaciones inteligentes (anti-ruido)

El cliente anterior notificaba de más, repetitivo y poco informativo. Además del
agrupamiento y el id estable, para que los push sean **informativos** el
VirtualHost debe tener:

```lua
push_notification_with_body = true;     -- cuerpo real del mensaje (default false)
push_notification_with_sender = true;   -- remitente real (default false)
```

Y el **cliente** activa los filtros del servidor en su `<enable>` (los módulos
`mod_cloud_notify_filters` / `mod_cloud_notify_priority_tag` ya están instalados
en el gateway): `ignore-unknown` (no push de desconocidos), `muted`
(conversaciones silenciadas) y `groupchat` (salas: sólo si te mencionan).

Todos los puentes requieren `mod_cloud_notify` habilitado (XEP-0357). El
cliente se registra con
`<enable xmlns='urn:xmpp:push:0' jid='<service_jid>' node='<token>'/>`; el
`jid` elegido decide qué bridge atiende el push:

| Cliente | `jid` (default) | `node` |
|---|---|---|
| Android (Expo) | `expo-push.<dominio>` | `ExpoPushToken[...]` |
| Android (FCM) | `fcm-push.<dominio>` | token FCM |
| iOS (APNs) | `apns-push.<dominio>` | token APNs (hex) |

## Options

`mod_fcm_push.lua`:

| Option | Default | Descripción |
|---|---|---|
| `fcm_push_service_jid` | `"fcm-push." .. module.host` | JID que el cliente usa en `<enable/>`. |
| `fcm_push_endpoint` | — (sin default) | URL del `push-sender` (`.../push/fcm`). Si falta, warn y no envía. |
| `fcm_push_auth` | — | Secreto; si está seteado se manda `Authorization: Bearer <secreto>`. |
| `fcm_push_title` | `"Nuevo mensaje"` | Título por defecto si no hay remitente reconocible. |
| `fcm_push_body` | `"Tienes un mensaje nuevo"` | Cuerpo por defecto. |
| `fcm_push_channel_id` | `"xmpp_messages"` | Canal Android. |
| `fcm_push_coalesce_seconds` | `60` | Ventana de agrupamiento por conversación (0 la desactiva). |
| `fcm_push_quiet_enabled` | `false` | Silencio nocturno para lo no-accionable. |
| `fcm_push_quiet_start` / `_end` | `23` / `8` | Horas locales del servidor (ventana que puede cruzar medianoche). |

`mod_apns_push.lua`:

| Option | Default | Descripción |
|---|---|---|
| `apns_push_service_jid` | `"apns-push." .. module.host` | JID que el cliente usa en `<enable/>`. |
| `apns_push_endpoint` | — (sin default) | URL del `push-sender` (`.../push/apns`). Si falta, warn y no envía. |
| `apns_push_auth` | — | Secreto del header `Authorization: Bearer ...`. |
| `apns_push_title` | `"Nuevo mensaje"` | Título por defecto. |
| `apns_push_body` | `"Tienes un mensaje nuevo"` | Cuerpo por defecto. |
| `apns_push_channel_id` | `"xmpp_messages"` | Canal (se reenvía como metadata). |
| `apns_push_coalesce_seconds` | `60` | Ventana de agrupamiento por conversación (0 la desactiva). |
| `apns_push_quiet_enabled` | `false` | Silencio nocturno para lo no-accionable. |
| `apns_push_quiet_start` / `_end` | `23` / `8` | Horas locales del servidor. |

## push-sender (servicio HTTP de referencia)

`push-sender/` es un servicio Node (sin framework) que hace el envío real a
FCM (`firebase-admin`) y APNs (`@parse/node-apn`). Los módulos Lua forwardean
el payload por HTTP a `fcm_push_endpoint` / `apns_push_endpoint`; sin ese
servicio corriendo, los módulos loguean warn y no entregan nada.

Contrato del POST (JSON), contra el endpoint del proveedor:

```
{ "token": "...", "title": "...", "body": "...", "priority": "high"|"normal",
  "channelId": "xmpp_messages", "collapse": "<bare del remitente>", "count": 1,
  "data": { "type": "xmpp_message", "jid": "<bare>", "url": "/xmpp-chat/<bare urlencoded>" } }
```

`collapse` es el id estable de la conversación (el push-sender lo mapea a
`tag`/`collapseKey` en FCM y a `threadId`/`collapseId` en APNs para reemplazar,
no apilar). APNs agrega además `"aps": { "sound": "default" }`. El header
`Authorization: Bearer <secreto>` se incluye si `*_push_auth` está seteado.
Ver `push-sender/README.md` para variables de entorno, cómo correrlo y las
credenciales de cada proveedor (`FCM_SERVICE_ACCOUNT`, `APNS_KEY_FILE`, etc.).

## Deploy

```bash
scp prosody-modules/*.lua icarito@187.127.47.38:/tmp/
ssh icarito@187.127.47.38
# OJO: xat_push_policy.lua NO empieza con "mod_": copialo explícitamente.
sudo cp /tmp/mod_*.lua /tmp/xat_push_policy.lua /usr/local/lib/prosody/modules/
sudo chown root:root /usr/local/lib/prosody/modules/mod_*.lua /usr/local/lib/prosody/modules/xat_push_policy.lua
sudo chmod 644 /usr/local/lib/prosody/modules/mod_*.lua /usr/local/lib/prosody/modules/xat_push_policy.lua
# agregar "push_hints_filter" (y "fcm_push"/"apns_push" si usás esos
# proveedores) a modules_enabled en /etc/prosody/prosody.cfg.lua
# si es la primera vez que se carga cada módulo.
# NO agregues xat_push_policy: es un helper, no un módulo.
sudo prosodyctl check config
sudo systemctl restart prosody   # reload (SIGHUP) NO carga módulos nuevos de forma confiable
```

Verificar en `/var/log/prosody/prosody.log` tras el restart: debe aparecer
`Expo push bridge loaded ... (coalesce window: Ns)`,
`FCM push bridge loaded ...` / `APNs push bridge loaded ...` (o el warn de
`*_push_endpoint is not set` si faltó configurar el endpoint) y
`push_hints_filter loaded`. Si `xat_push_policy.lua` no está en el directorio de
los bridges, el módulo falla al cargar con un error de `dofile`.

El `push-sender` corre aparte (proceso Node). Ver `push-sender/README.md` para
instalarlo, setear credenciales y apuntar `fcm_push_endpoint` /
`apns_push_endpoint` hacia él.
