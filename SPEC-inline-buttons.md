# Spec: XMPP Inline Buttons (`capabilities.inlineButtons`)

## Contexto

Telegram expone `channels.telegram.capabilities.inlineButtons` (`"off" | "dm" | "group" | "all" | "allowlist"`), lo que permite que comandos nativos (`/status`, `/model`, `/context`, etc.) y respuestas interactivas (`ask_question`, `cards`) muestren botones inline en el chat en lugar de solo texto plano.

El plugin XMPP ya tiene:
- **XEP-0050 ad-hoc commands** funcionando (`native-commands.ts`) — expone `/context`, `/compact`, `/clear`, `/model` como comandos de sesión
- **Renderizado interactivo** (`outbound-render.ts`) — renderiza `ask_question`/`cards` usando el protocolo de queries de Cheogram (XEP-0004 + XEP-0050)
- **`capabilities.nativeCommands: true`** declarado en `channel.ts`

Pero **no tiene** `capabilities.inlineButtons` — los comandos nativos solo funcionan vía XEP-0050 (ad-hoc commands), no como botones inline en el mensaje de respuesta.

## Objetivo

Agregar soporte para `channels.xmpp.capabilities.inlineButtons` en el plugin XMPP, siguiendo el mismo patrón que Telegram:

### Valores soportados
- `"off"` — sin botones (default, comportamiento actual)
- `"dm"` — botones solo en DMs
- `"group"` — botones solo en grupos/MUCs
- `"all"` — botones en DMs y grupos
- `"allowlist"` — botones solo para JIDs en `allowFrom`

### Comportamiento esperado
Cuando `inlineButtons` está habilitado, los mensajes de respuesta que incluyen `interactive` payload (de `ask_question`, comandos nativos con opciones, etc.) deben renderizar botones inline a través del protocolo de queries de Cheogram que ya existe en `outbound-render.ts`.

## Archivos a modificar

### 1. `src/config-schema.ts`
Agregar `capabilities` al schema de configuración XMPP:

```typescript
// En XmppAccountSchemaBase, agregar:
capabilities: z.object({
  inlineButtons: z.enum(["off", "dm", "group", "all", "allowlist"]).optional().default("off"),
}).optional(),
```

### 2. `src/types.ts`
Agregar el tipo `XmppCapabilities`:

```typescript
export type XmppCapabilities = {
  inlineButtons?: "off" | "dm" | "group" | "all" | "allowlist";
};
```

Y agregar `capabilities` a `XmppAccountConfig`:

```typescript
capabilities?: XmppCapabilities;
```

### 3. `src/channel.ts`
Agregar `inlineButtons` a las capabilities del plugin:

```typescript
capabilities: {
  chatTypes: ["direct", "group"],
  media: true,
  blockStreaming: true,
  nativeCommands: true,
  inlineButtons: true,  // ← NUEVO
},
```

### 4. `src/config-ui-hints.ts`
Agregar hint de UI:

```typescript
"capabilities.inlineButtons": {
  label: "XMPP Inline Buttons",
  help: 'Enable interactive inline buttons on messages. "dm" = DMs only, "group" = rooms only, "all" = everywhere, "allowlist" = allowFrom only.',
},
```

### 5. `src/outbound-render.ts`
El archivo ya tiene `renderQueryCommandStanza` y `renderAskQuestionStanza` que usan el protocolo de Cheogram. La modificación principal es:

- Agregar una función `resolveInlineButtonsScope()` que lea la config y retorne el scope
- En `renderAskQuestionStanza()` y `renderCardStanza()`, condicionar el renderizado de botones al scope
- Para comandos nativos con opciones (ej: `/model` con lista de modelos), usar el mismo mecanismo de queries

### 6. `src/native-commands.ts`
Opcionalmente, extender para que comandos como `/model` y `/context` envíen respuestas con botones inline (usando el protocolo de queries) en lugar de solo texto plano, cuando `inlineButtons` está habilitado.

### 7. `src/message-adapter.ts`
Asegurar que el `interactive` payload del core de OpenClaw se pase correctamente al renderizador de outbound.

## Cómo funciona el renderizado de botones en XMPP

El protocolo de Cheogram (usado por Cheogram Android) extiende XEP-0004/XEP-0050:
- Cada mensaje con opciones interactivas incluye un `<query>` stanza con `<item>` elements
- Cada `<item>` tiene un `id` y se renderiza como botón en Cheogram
- Al presionar un botón, Cheogram envía un IQ `set` con el `id` del item seleccionado
- El plugin ya maneja esto en `outbound-render.ts` y `commands.ts`

Para comandos nativos, el flujo sería:
1. Usuario ejecuta `/model` (vía texto o XEP-0050)
2. OpenClaw responde con la lista de modelos
3. Si `inlineButtons` está habilitado, la respuesta incluye un `<query>` con cada modelo como `<item>` (botón)
4. El usuario presiona un botón → Cheogram envía un IQ con el item id
5. El plugin recibe el IQ y lo procesa como si el usuario hubiera escrito `/model deepseek-v4-pro`

## Scope gating

El gating de scope (`dm`/`group`/`all`/`allowlist`) debe aplicarse en:
- `outbound-render.ts`: antes de adjuntar el `<query>` stanza al mensaje
- `outbound-base.ts` o `message-adapter.ts`: al decidir si pasar el `interactive` payload al renderizador

Para `allowlist`, verificar que el `target` JID esté en `account.config.allowFrom`.

## Testing

1. Configurar `channels.xmpp.capabilities.inlineButtons: "dm"` 
2. Enviar `/model` desde un DM → verificar que aparecen botones
3. Enviar `/model` desde un MUC → verificar que NO aparecen botones (solo texto)
4. Cambiar a `"all"` → verificar botones en ambos
5. Cambiar a `"allowlist"` → verificar que solo JIDs en allowFrom reciben botones

## Notas

- El protocolo de queries de Cheogram solo funciona en **Cheogram Android**. Otros clientes XMPP (Gajim, Conversations, Dino) no renderizan los botones — solo verán el texto fallback que ya se incluye.
- No se requiere migrar el schema de BD ni cambiar el formato de mensajes existente.
- Los comandos XEP-0050 existentes (`/context`, `/compact`, `/clear`, `/model`) siguen funcionando igual — esto es una capa adicional, no un reemplazo.