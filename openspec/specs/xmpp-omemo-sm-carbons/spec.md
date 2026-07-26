# Spec: OMEMO + Stream Management + Message Carbons para openclaw-xmpp

## Objetivo

Portar tres capacidades XMPP críticas desde el plugin de referencia `elmafioso79/xmpp-channel` hacia `@openclaw/xmpp` (SDK 2026.7.1), integrándolas en la arquitectura moderna de scoped adapters que ya usa nuestro plugin.

Las tres features a portar son:

1. **OMEMO (XEP-0384)** — cifrado extremo a extremo
2. **Stream Management (XEP-0198)** — recuperación de mensajes tras desconexión
3. **Message Carbons (XEP-0280)** — sincronización multi-dispositivo

## Estado actual de nuestro plugin

- **41 archivos TypeScript, ~8,644 líneas**
- Librería XMPP: `@xmpp/client` v0.13
- `src/client.ts` (241 líneas): maneja conexión, reconexión con backoff exponencial, XEP-0199 ping, MUC join. No tiene OMEMO, no tiene XEP-0198, no tiene XEP-0280.
- `src/send.ts` (779 líneas): `sendMessageXmpp`, `sendFileXmpp`. Envía stanzas `<message>` planas sin cifrar, no maneja carbons ni stream management.
- `src/monitor.ts` (443 líneas): `monitorXmppProvider` — ciclo de vida de la conexión, inbound routing, dedup. No toca OMEMO ni carbons.
- `src/channel.ts` (714 líneas): plugin definition con `createChatChannelPlugin`, scoped adapters. Capabilities declara `chatTypes: ["direct", "group"], media: true`. Sin referencia a OMEMO.
- `src/types.ts`: tipos CoreConfig, XmppInboundMessage. Sin campos para OMEMO ni SM.
- `src/config-schema.ts`: Zod schema. Sin campos `omemo` ni `streamManagement`.
- **package.json**: dependencias `@xmpp/client`, `@xmpp/xml`, `zod`. Sin libsignal.

## Feature 1: OMEMO (XEP-0384)

### Qué hace

Cifrado extremo a extremo para mensajes 1:1 y grupales usando el protocolo Signal (Double Ratchet / X3DH). El bot publica su device ID y key bundle vía PEP, encripta mensajes salientes con las claves de cada dispositivo receptor, y desencripta mensajes entrantes.

### Cambios concretos

#### 1.1 Nueva dependencia: `@privacyresearch/libsignal-protocol-typescript`

Agregar a `package.json` en `dependencies`. Esta es la librería que usa la implementación de referencia para el protocolo Signal.

#### 1.2 Nuevo módulo: `src/omemo/`

Crear la estructura de archivos:

```
src/omemo/
  types.ts          — NS_OMEMO, NS_OMEMO_DEVICES, NS_OMEMO_BUNDLES, OMEMO_NAMESPACES, OmemoDevice, OmemoBundle, OmemoEncryptedMessage, OmemoStoreData
  store.ts          — OmemoStore: genera/almacena identity key, pre-keys, signed pre-keys, session state. Usa libsignal.
  device.ts         — publishDeviceId (PEP), fetchDeviceList (PEP), parseDeviceListEvent
  device-cache.ts   — caché en memoria de device lists por JID (getDeviceList, handleDeviceListPepEvent, clearDeviceCache)
  bundle.ts         — publishBundle (PEP), fetchBundle (PEP), buildBundleFromStore
  session.ts        — SessionBuilder + SessionCipher de libsignal para encriptar/desencriptar por dispositivo
  persistence.ts    — loadOmemoStoreData / saveOmemoStoreData: serializa el estado OMEMO a un archivo JSON en OPENCLAW_STATE_DIR/channel-cache/xmpp/omemo-<accountId>.json
  encrypt.ts        — encryptOmemoMessage: orquesta la encriptación para todos los dispositivos del destinatario
  muc-occupants.ts  — tracking de occupants MUC para OMEMO grupal (handleMucPresence, getRoomOccupantJids, isRoomOmemoCapable)
  index.ts          — initializeOmemo, shutdownOmemo, isOmemoEnabled, getOmemoStore, decryptOmemoMessage, isOmemoEncrypted, getOmemoEncrypted, re-exports
```

**Regla de implementación**: portar la lógica de `elmafioso79/xmpp-channel/src/omemo/*` adaptando las firmas para que encajen con nuestros tipos (`ResolvedXmppAccount`, `RuntimeEnv`, etc.). No reimplementar el protocolo Signal desde cero.

**Namespaces OMEMO a soportar**:
- `eu.siacs.conversations.axolotl` (legacy, máxima compatibilidad con Conversations, Gajim)
- `urn:xmpp:omemo:2` (OMEMO 2.0)

#### 1.3 Integración en `src/client.ts`

Agregar a `XmppClientOptions`:
```typescript
omemoEnabled?: boolean;
omemoStore?: OmemoStore;
```

En `connectXmppClient`:
- Si `omemoEnabled`, después de `xmpp.start()` y del envío de presencia inicial, llamar a `initializeOmemo()` que publica device ID + bundle vía PEP.
- Enviar presencia después de publicar el bundle.

En el handler de stanzas entrantes (`onStanza`):
- Detectar si el mensaje tiene `<encrypted>` (namespace OMEMO). Si es así, desencriptar con `decryptOmemoMessage` y reemplazar el body del mensaje con el texto plano antes de pasarlo al pipeline inbound.

#### 1.4 Integración en `src/send.ts`

Modificar `sendMessageXmpp` para que, si la cuenta tiene OMEMO habilitado:
1. Obtener la device list del destinatario (cacheada + fallback a fetch)
2. Si hay devices, encriptar el body con `encryptOmemoMessage`
3. Construir el elemento `<encrypted>` con header, keys por dispositivo, IV y payload
4. Enviar `<message>` con el elemento `<encrypted>` en lugar de `<body>`
5. Si no hay devices, hacer fallback a texto plano con un warning log

Para grupos MUC:
- Si la sala es non-anonymous y OMEMO-capable, encriptar para todos los occupants conocidos vía `getRoomOccupantJids`.

#### 1.5 Integración en `src/monitor.ts`

En `monitorXmppProvider`, pasar `omemoEnabled` y la store a `connectXmppClient`. Cerrar OMEMO en el cleanup (`shutdownOmemo`).

#### 1.6 Configuración (`src/config-schema.ts`)

Agregar al schema de cuenta:
```typescript
omemo: z.object({
  enabled: z.boolean().optional(),
  deviceLabel: z.string().optional(),
}).optional()
```

#### 1.7 Tipos (`src/types.ts`)

Agregar campos a `XmppInboundMessage` y tipos de cuenta:
```typescript
// En account config
omemoEnabled?: boolean;
omemoDeviceLabel?: string;

// En inbound message  
wasEncrypted?: boolean;
encryptionNamespace?: string;
```

### Plan de tests

- **Unitario**: `src/omemo/store.test.ts` — generar claves, serializar/deserializar estado
- **Unitario**: `src/omemo/encrypt.test.ts` — encriptar/desencriptar round-trip con store mock
- **Integración**: test manual contra un servidor XMPP real con OMEMO (Conversations o Gajim como peer)
- **Contract**: verificar que el plugin compila con `npx tsc --noEmit`

### Supuestos

- NO implementamos verificación de identity keys (always-trust policy), igual que la referencia.
- Las claves se persisten en JSON en `OPENCLAW_STATE_DIR/channel-cache/xmpp/omemo-<accountId>.json`. No usamos KMS ni encrypt-at-rest por ahora.
- OMEMO en grupos requiere salas non-anonymous. Si la sala es semi-anonymous, se hace fallback a texto plano con warning.
- El `@xmpp/client` ya maneja el envío de stanzas vía PEP — solo hay que construir los elementos XML correctos.

---

## Feature 2: Stream Management (XEP-0198)

### Qué hace

Permite que el servidor XMPP almacene mensajes en cola mientras el cliente está desconectado y los entregue al reconectar sin pérdida. También permite resumir una sesión anterior (mismo stream id) en lugar de crear una nueva.

### Cambios concretos

#### 2.1 Integración en `src/client.ts`

`@xmpp/client` v0.13 incluye soporte para stream management vía `xmpp.streamManagement`.

En `connectXmppClient`, después de `xmpp.start()`:
1. Suscribirse a eventos de stream management:
   - `resumed`: loguear y actualizar estado
   - `failed`: loguear stanza que no se pudo enviar
   - `ack`: contar stanzas acknowledged (debug)
2. Exponer el stream id resumible para reconexión

#### 2.2 Integración en `src/monitor.ts`

En el ciclo de reconexión (`scheduleReconnect`):
- Si tenemos un stream id previo, intentar `xmpp.resume(previousStreamId)` en lugar de `xmpp.start()`.
- Si el resume falla (servidor no soporta o sesión expiró), hacer start normal.

#### 2.3 Configuración (`src/config-schema.ts`)

Agregar:
```typescript
streamManagement: z.object({
  enabled: z.boolean().optional(),
  resumptionMaxSeconds: z.number().optional(),
}).optional()
```

- `enabled` default `true` si el servidor lo soporta.
- `resumptionMaxSeconds` default `300`.

### Plan de tests

- **Integración**: desconectar el cliente forzosamente (matar proceso), verificar que al reconectar no se pierden mensajes.

### Supuestos

- El soporte de `@xmpp/client` para XEP-0198 es suficiente — no necesitamos implementar el protocolo a mano. Solo hay que suscribirse a los eventos correctos.
- Si el servidor no soporta XEP-0198, el resume falla silenciosamente y se hace start normal.

---

## Feature 3: Message Carbons (XEP-0280)

### Qué hace

Cuando un usuario tiene múltiples dispositivos conectados al mismo JID, el servidor envía copias (carbons) de todos los mensajes entrantes y salientes a todos los dispositivos. Esto mantiene el historial sincronizado.

### Cambios concretos

#### 3.1 Integración en `src/client.ts`

En `connectXmppClient`, inmediatamente después de que la conexión esté online y la presencia inicial enviada:

```typescript
// XEP-0280: Enable Message Carbons
const enableCarbons = xml(
  "iq", { type: "set", id: `carbons-${Date.now()}` },
  xml("enable", { xmlns: "urn:xmpp:carbons:2" })
);
await xmpp.send(enableCarbons);
```

Manejar stanzas de carbon entrantes:
- `<received>` carbon: tratar como mensaje inbound normal (reenviar al pipeline)
- `<sent>` carbon: registrar para dedup pero no reenviar (evitar loops)

#### 3.2 Integración en `src/monitor.ts`

Agregar filtro en el handler de stanzas: detectar si un `<message>` viene wrapped en un carbon. Si es `<received xmlns="urn:xmpp:carbons:2">`, extraer el mensaje interno y pasarlo al pipeline inbound normalmente. Si es `<sent>`, ignorarlo (es nuestro propio mensaje reflejado).

#### 3.3 Tipos (`src/types.ts`)

Agregar a `XmppInboundMessage`:
```typescript
isCarbonCopy?: boolean;
```

### Plan de tests

- **Integración**: conectar dos dispositivos al mismo JID. Enviar mensaje desde uno, verificar que el bot recibe el carbon en el otro.

### Supuestos

- Solo habilitamos carbons, no los deshabilitamos. Si el servidor no soporta XEP-0280, el `<iq>` de enable simplemente devuelve un error que se ignora (degradación elegante).

---

## Orden de implementación

1. **OMEMO**: es la feature más grande y tiene más dependencias internas. Implementar `src/omemo/*` completo primero.
2. **Stream Management**: integrar en `src/client.ts` y `src/monitor.ts`. Tiene baja fricción con OMEMO.
3. **Message Carbons**: la más simple de las tres. Un `<iq>` y un filtro de stanzas.

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|-----------|
| `libsignal` tiene bugs de compilación en Node 22 | Probar `npx tsc --noEmit` antes de cualquier otra cosa; si falla, buscar fork compatible |
| OMEMO en grupos semi-anonymous no funciona | Hacer fallback explícito a texto plano; documentar que requiere non-anonymous |
| XEP-0198 resume rompe el flujo de presencia/MUC | Reenviar presencia y rejoinear MUCs después de cada resume exitoso |
| Carbons causan loops de mensajes | Usar el mismo mecanismo de dedup de `monitor.ts` aplicado al message ID del carbon |

## Verificación final

- `npx tsc --noEmit` pasa sin errores
- `npm test` (si hay tests) pasa
- El plugin carga en OpenClaw sin errores de runtime
- Prueba manual: enviar mensaje OMEMO desde Conversations → el bot lo recibe y responde cifrado
- Prueba manual: matar proceso OpenClaw → reconectar → no se pierden mensajes
