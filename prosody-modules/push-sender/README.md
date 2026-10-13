# push-sender

Servicio HTTP **de referencia** que hace el envío real de notificaciones push
para los bridges de Prosody:

- `mod_fcm_push.lua` → Android (Firebase Cloud Messaging v1)
- `mod_apns_push.lua` → iOS (Apple Push Notification service)

Los módulos Lua **no hablan con FCM/APNs directo**: solo reciben el registro
XEP-0357 del cliente y forwardean el payload por HTTP a este servicio (mismo
patrón que `mod_expo_push.lua` posteando a `exp.host`). Así las credenciales de
proveedor (service account de FCM, clave `.p8` de APNs) viven en un solo
proceso Node, no en el servidor Prosody.

## Rutas

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Liveness. Responde `{"ok":true}`. |
| `POST` | `/push/fcm` | Envía a FCM v1 (`firebase-admin`). |
| `POST` | `/push/apns` | Envía a APNs (`@parse/node-apn`). |

Todas las rutas `POST` exigen el header
`Authorization: Bearer <PUSH_SECRET>`. Si `PUSH_SECRET` no está seteado, el
servicio responde `500` y no atiende envíos.

### Body de `/push/fcm`

Es exactamente lo que arma `mod_fcm_push.lua`:

```json
{
  "token": "<token FCM>",
  "title": "rolando",
  "body": "hola",
  "priority": "high",
  "channelId": "xmpp_messages",
  "data": {
    "type": "xmpp_message",
    "jid": "rolando@hablar.fuentelibre.org",
    "url": "/xmpp-chat/rolando%40hablar.fuentelibre.org"
  }
}
```

Se envía como `notification` + `data` (los valores de `data` se stringifican,
requisito de FCM) con `android.priority` y `android.notification.channelId`.

### Body de `/push/apns`

Igual, más el bloque `aps`:

```json
{
  "token": "a1b2c3...  (hex)",
  "title": "rolando",
  "body": "hola",
  "priority": "high",
  "channelId": "xmpp_messages",
  "data": { "type": "xmpp_message", "jid": "...", "url": "..." },
  "aps": { "sound": "default" }
}
```

Se mapea a una `Notification` de `@parse/node-apn`: `alert` (title/body),
`sound`, `topic` (bundle id), `pushType: "alert"`, `priority` 10/5 y el resto en
`payload` (custom data).

Respuestas: `200 {"ok":true,...}` en éxito, `400` body/token inválido o rechazo
del proveedor, `401` sin/erróneo bearer, `500` error interno o configuración
faltante.

## Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `PORT` | no | Puerto HTTP. Default `8787`. |
| `PUSH_SECRET` | sí | Secreto del header `Authorization: Bearer ...`. |
| `FCM_SERVICE_ACCOUNT` | FCM | Ruta al JSON de service account de Firebase. Si falta, se usan Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS` o metadata server de GCP). |
| `APNS_KEY_FILE` | APNs | Ruta al archivo `.p8` (Auth Key) de APNs. |
| `APNS_KEY_ID` | APNs | Key ID de la Auth Key. |
| `APNS_TEAM_ID` | APNs | Team ID de Apple. |
| `APNS_TOPIC` | APNs | Bundle ID de la app iOS. |
| `APNS_PRODUCTION` | no | Si es `"false"`, usa el APNs sandbox. Default producción. |

Solo se inicializan las credenciales del proveedor que realmente se usa: se
puede correr el servicio atendiendo únicamente FCM o únicamente APNs.

## Correr

```bash
cd prosody-modules/push-sender
npm install          # instala firebase-admin y @parse/node-apn
PUSH_SECRET="cambiame" \
FCM_SERVICE_ACCOUNT=/etc/xat-push/fcm-service-account.json \
APNS_KEY_FILE=/etc/xat-push/apns-key.p8 \
APNS_KEY_ID=ABCDE12345 \
APNS_TEAM_ID=TEAM123456 \
APNS_TOPIC=org.fuentelibre.xat \
PORT=8787 \
npm start
```

Prueba rápida:

```bash
curl -s http://127.0.0.1:8787/health
curl -s -X POST http://127.0.0.1:8787/push/fcm \
  -H "Authorization: Bearer cambiame" \
  -H "Content-Type: application/json" \
  -d '{"token":"<token fcm>","title":"t","body":"b","priority":"high","data":{"type":"xmpp_message"}}'
```

## Apuntar Prosody a este servicio

En el `VirtualHost "hablar.fuentelibre.org"` (o global) de
`/etc/prosody/prosody.cfg.lua`:

```lua
modules_enabled = {
  -- ...
  "cloud_notify";
  "fcm_push";
  "apns_push";
}

-- Endpoints del push-sender. Sin esto, cada módulo loguea warn y no envía.
fcm_push_endpoint = "http://127.0.0.1:8787/push/fcm"
apns_push_endpoint = "http://127.0.0.1:8787/push/apns"
-- Si PUSH_SECRET está seteado, repetilo acá para que el bridge lo mande:
fcm_push_auth = "cambiame"
apns_push_auth = "cambiame"
```

Ajustá los JIDs de registro si no querés los defaults
(`fcm-push.<dominio>` / `apns-push.<dominio>`) con
`fcm_push_service_jid` / `apns_push_service_jid`. Para que los clientes que
registran estos JIDs realmente se conecten y puedan publicar, agregá en
`modules_enabled` también los módulos correspondientes y, en despliegues con
componentes externos, definí los `Component` de esos JIDs.

Verificación en `/var/log/prosody/prosody.log` tras reiniciar Prosody:

```
FCM push bridge loaded for fcm-push.hablar.fuentelibre.org (endpoint: ..., coalesce window: 8s)
APNs push bridge loaded for apns-push.hablar.fuentelibre.org (endpoint: ..., coalesce window: 8s)
```
