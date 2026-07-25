## Context

`tools.exec.mode: "auto"` resuelve a `security: "allowlist", ask: "on-miss",
autoReview: true`. El reviewer (modelo `kilo/deepseek-v4-flash`, prompt fijo
no configurable — schema `.strict()` en `zod-schema.agent-runtime`, solo
acepta `model`/`timeoutMs`) solo auto-aprueba cuando `decision:"allow"` **y**
`risk:"low"` simultáneamente; cualquier `medium/high/unknown` cae a `ask`
(card humana). Esto es más estricto de lo documentado en memoria previa del
proyecto — no hay tres niveles de auto-aprobación, hay uno.

El único mecanismo existente para reducir cards es la allowlist permanente
(`exec-approvals.json`, patrones glob de ruta/basename + regex opcional de
argumentos vía `argPattern`) o el comando manual `approval-mode`
(`src/approval-mode.ts`), que **edita `openclaw.json` en disco y exige
reiniciar `claudio-w-openclaw.service`** para tomar efecto — confirmado en
`setExecPreset`/`writeConfigFile` (approval-mode.ts:78-110) y el mensaje que
el propio comando devuelve al usuario ("Requiere reiniciar... para aplicar").
Dos reinicios por ventana de bypass (activar + expirar) matarían cualquier
sesión de agente en curso — inaceptable para un mecanismo pensado para uso
frecuente y de baja fricción.

Investigación del core vendorizado (`extensions/xmpp/node_modules/openclaw/dist/`)
confirmó que la policy de exec **se reevalúa en cada turno**, no se cachea al
boot (`resolveExecDefaults`, `exec-defaults-sbRJBGUd.js:53-97`, invocada desde
`createOpenClawCodingTools` en cada intento de turno vía
`runEmbeddedAttempt`). Existen dos capas de override runtime ya soportadas
por el core, sin tocar `openclaw.json` ni reiniciar:

1. **Estado de sesión** (`sessionEntry.execSecurity/execAsk/execHost/execNode`),
   persistido en el store de sesiones (JSON en disco separado de
   `openclaw.json`), aplicado por `applySessionLegacyExecPolicyLayer` /
   `applyExecPolicyLayer`, mutable vía el método de gateway RPC
   `sessions.patch` (ya expuesto, `session-create-service-DPoSQaN2.js`,
   handler en `sessions-Cs087TE0.js:1260-1357`). Requiere scope
   `operator.admin` (no `operator.write`) para esos campos específicos —
   `method-scopes-CwW_Szsp.js:37-49`, fail-closed intencional del core.
2. **`execOverrides`** por directiva de texto en el mensaje entrante
   (`extractExecDirective`, formato `exec host=full`), mayor precedencia que
   el estado de sesión, pero por-turno y no persistente — no sirve como base
   de un bypass con TTL propio.

No existe un hook `resolve_exec_policy` ni un "policy provider" instalable
por plugin — el plugin no puede inyectar una función que el core consulte.
Lo que sí puede hacer, dentro del mismo proceso Node (el plugin importa
`openclaw/plugin-sdk/*` directamente, no hay aislamiento IPC), es escribir
esos mismos campos de sesión **directamente**, sin pasar por el RPC
`sessions.patch` en absoluto: `openclaw/plugin-sdk/session-store-runtime`
expone `getSessionEntry`/`patchSessionEntry`, funciones in-process que leen
y escriben el store de sesiones (mismo store que `sessions.patch` termina
tocando del lado servidor). Como es una llamada de función normal dentro del
mismo proceso, no hereda el requisito de scope `operator.admin` que aplica a
invocaciones *externas* del método RPC — ese scope gatea el control-plane
del gateway contra clientes remotos, no las funciones que el propio proceso
del gateway (y los plugins que corren dentro de él) ya puede llamar
directamente. Esto revierte la preocupación de scope que originalmente
motivó D1 (ver versión anterior de esta sección); confirmado investigando
el bundle vendorizado, `patchSessionEntry({agentId, sessionKey, update})`
no pasa por ningún chequeo de `method-scopes`.

Falta resolver `agentId`/`sessionKey` a partir de lo que un handler de
comando ad-hoc realmente tiene (`ActionContext = {fromJid, accountId}` — ver
`actions.ts`, sin `sessionKey` ni `agentId`). La solución encontrada es
`resolveAgentRoute({cfg, channel: "xmpp", accountId, peer: {kind: "direct",
id: fromJid}})` de `openclaw/plugin-sdk/routing` (ya importado en este
mismo plugin en `setup-surface.ts`/`setup-core.ts`), que devuelve
`{agentId, sessionKey, mainSessionKey, ...}` en una sola llamada pura, sin
generar turno de agente ni tocar la cola de sesión — es el mismo cálculo de
bindings que usa `inbound.ts` internamente (vía
`resolveInboundRouteEnvelopeBuilderWithRuntime` → `runtime.routing.resolveAgentRoute`),
expuesto de forma standalone.

## Goals / Non-Goals

**Goals:**
- Bypass temporal (minutos, con máximo configurable) que relaja
  `execSecurity`/`execAsk` de la sesión activa sin editar `openclaw.json` ni
  reiniciar el gateway.
- Auto-reversión fiable aunque el cliente que lo activó se desconecte —
  el temporizador vive en el proceso del gateway (dentro del plugin XMPP),
  no en el cliente.
- Comando descubierto dinámicamente vía XEP-0050 (`approval-bypass`), igual
  que el resto de comandos ad-hoc del plugin — ningún cliente hardcodea el
  nodo salvo para poder etiquetar el botón antes de la primera respuesta
  disco#items (ver sección Clientes más abajo).
- Corregir la asimetría de texto entre la ruta de entrega nativa y la
  forwarder de approval cards, y reforzar el filtro de fences vacíos como
  red de seguridad.
- Documentar el patrón de allowlist de lectura por agente como guía operativa
  reutilizable (no requiere cambio de código en este repo).

**Non-Goals:**
- No se modifica el reviewer (prompt fijo, sin umbral configurable) — está
  fuera del alcance de un plugin de canal; requeriría cambio en el core.
- No se agrega una cuarta opción de decisión dentro de las cards de
  aprobación puntuales existentes (`allow-once|allow-always|deny`) — el
  bypass es un comando de sesión aparte, no una respuesta a una card
  específica.
- No se implementa persistencia del bypass a través de reinicios del
  gateway — un restart durante un bypass activo simplemente lo pierde,
  volviendo a la policy normal (comportamiento seguro por defecto: fail
  hacia más aprobación, no menos).
- No se decide en este change el trabajo de los clientes Android/GTK —
  se documenta el contrato que deben cumplir, pero la implementación en
  esos repos es tasks propias, fuera de `allowedEditRoots` de este change.

## Decisions

### D1: `patchSessionEntry` in-process sobre estado de sesión, no `approval-mode`/`openclaw.json`

El bypass usa la capa 1 descrita en Contexto (`execSecurity`/`execAsk` de
sesión), escribiéndola directamente vía `getSessionEntry`/`patchSessionEntry`
del plugin-sdk (in-process, mismo store que usa el core), no el archivo de
config ni el RPC `sessions.patch`. Alternativa descartada: extender
`approval-mode` para aceptar una duración — se descartó porque el mecanismo
de fondo (edición de `openclaw.json` + restart) es incompatible con un
bypass rápido y frecuente por diseño, no por un detalle implementable;
cambiarlo habría significado reescribir `approval-mode.ts` desde cero,
momento en el que ya no comparte nada con el original salvo el nombre.

Descartada también la vía RPC `sessions.patch` explorada inicialmente: exige
scope `operator.admin` para esos campos porque es la puerta de entrada para
clientes *externos* al proceso del gateway. El plugin XMPP corre dentro del
mismo proceso Node que el core (importa `openclaw/plugin-sdk/*`
directamente), así que puede llamar `patchSessionEntry` como función normal,
sin pasar por esa capa de autorización de RPC en absoluto — no hay scope que
verificar ni conceder.

### D2: Bypass por sesión, no global de agente

`approval-mode` cambia la policy para *todo* el agente (todas sus sesiones,
todos los canales). El bypass nuevo relaja solo la sesión desde la que se
invocó (`sessionEntry` es por-sesión). Esto es intencionalmente más acotado:
el caso de uso ("Sebastián investigando con Clawdio por XMPP ahora mismo")
no necesita relajar sesiones cron o de otros canales del mismo agente. Si en
el futuro hace falta un bypass de agente completo, es una extensión aparte
(iterar sobre todas las sesiones activas del agente), no parte de este
change.

### D3: Estado de expiración en memoria del plugin, no en el store de sesión

El plugin mantiene su propio `Map<sessionKey, {previousExecSecurity,
previousExecAsk, expiresAtMs, timer}>` en memoria de proceso. Al expirar (o
al recibir `approval-bypass off` manual), revierte llamando `sessions.patch`
con los valores previos guardados, y limpia la entrada. No se persiste este
mapa a disco: si el gateway se reinicia con un bypass activo, se pierde el
timer pero la sesión queda con el `execSecurity`/`execAsk` relajado que
tenía al momento del restart (el store de sesión sí persiste esos campos,
solo el timer de reversión vive en el plugin). Ver Riesgos.

Alternativa considerada: persistir el timer/expiración también en el store
de sesión para sobrevivir restarts. Descartada por ahora — añade
complejidad (revivir timers al boot, iterar sesiones con bypass pendiente) para
un caso borde (restart durante una ventana de minutos) que ya tiene mitigación
razonable (ver Riesgos). Puede revisitarse si en la práctica los restarts
durante bypass activo resultan frecuentes.

### D4: Comando ad-hoc separado (`approval-bypass`), no parámetro nuevo de `approval-mode`

Mantiene `approval-mode` sin cambios (modo persistente, requiere restart,
alcance de agente) y agrega `approval-bypass` (modo runtime, sin restart,
alcance de sesión, con TTL) como concepto distinto y explícito. Evita
sobrecargar un comando existente con dos semánticas de persistencia
distintas bajo el mismo nombre, lo cual sería confuso para quien lea el
código o la ayuda del comando.

Parámetros del comando: `minutes` (entero, default a definir en
implementación — ej. 10 — clamped a un máximo configurable, ej. 60) y
`mode` opcional (`on`/`off`/`status`), simétrico a `approval-mode` para
familiaridad.

### D5: Fix del fallback de texto — unificar rutas, no elegir una

`approval-handler.runtime.ts` (ruta nativa) pasa a construir su `text` con
`buildCompactExecApprovalText`, igual que `channel.ts` (ruta forwarder), en
vez de usar `payload.text` crudo del core. Adicionalmente,
`compactApprovalFallbackText` en `send.ts` gana un paso de limpieza de
bloques de fence vacíos (regex sobre fences triples sin contenido entre
ellas) como red de seguridad — cubre el caso en que el texto de entrada
venga de una tercera fuente futura que ninguna de las dos rutas actuales
anticipa.

### D6: Allowlist de lectura — documentación, no código

`exec-approvals.json` ya soporta lo necesario (glob de rutas/binarios +
`argPattern` regex). No hace falta código nuevo: se documenta en este
design.md el patrón ya aplicado manualmente a Clawdio (grep/find/cat/head/wc
con `source: "allow-always"`) como snippet reusable para cualquier agente
nuevo, incluyendo desde otros despliegues (ej. Mateo en prj451/Railway, que
tiene su propio problema de exec approvals — ver nota al final, fuera de
alcance de este change).

## Clientes (contrato, fuera de `allowedEditRoots` de este change)

Los clientes descubren `approval-bypass` como cualquier otro comando ad-hoc:
vía disco#items del servidor, igual que hacen hoy con `approval-mode` y el
resto. **No deben hardcodear el nodo** salvo, opcionalmente, para poder
mostrar el switch antes de que llegue la primera respuesta disco#items de la
sesión — en ese caso, el string `"approval-bypass"` usado para *etiquetar*
la UI debe considerarse un identificador de protocolo estable (documentado
acá), no una suposición sobre su disponibilidad: si el servidor no lo
anuncia (versión vieja del plugin), el intento de invocarlo debe fallar de
forma visible ("Comando no disponible"), nunca silenciosa.

- **Android**: el string que ya manda (`"approval-bypass"`) coincide con el
  nombre del comando nuevo — el bug no es el nombre, es el *mecanismo* de
  invocación: `setApprovalBypass` hoy manda un mensaje de texto plano
  (`/oc approval-bypass on|off`) en vez de resolver y ejecutar el comando
  ad-hoc real (XEP-0050) que el servidor anuncia vía disco#items, que es lo
  que otros comandos del cliente ya hacen correctamente. El fix es cambiar
  `setApprovalBypass` para seguir el mismo camino de ejecución de comando
  ad-hoc que usa el resto de acciones del cliente, y agregar el parámetro de
  minutos al payload en vez del `_minutes = 15` actualmente descartado
  (`XmppService.ts:2753`, el parámetro existe pero nunca se usa).
- **GTK**: agregar el switch equivalente en el panel expandido de la sticky
  card (`chat_window.py`, área de `_action_panel_detail`/sticky card), que
  hoy no existe — invocando el mismo comando ad-hoc descubierto
  dinámicamente, sin agregar el string `approval-bypass` como categoría
  muerta como ya ocurre en `agent_commands_sidebar.py:34` (ese dead code
  puede quedar, ahora sí matcheará un nodo real).
- Ambos clientes deben reflejar el estado (`status`) y el tiempo restante que
  el comando ya expone, para que el switch en la UI no quede "prendido" tras
  expirar solo en el servidor sin que el cliente se entere — esto requiere
  que el cliente vuelva a consultar `status` periódicamente mientras el
  switch está activo, o que el servidor empuje un aviso al expirar (decisión
  de implementación de cliente, no de este change).

## Risks / Trade-offs

- **[Riesgo] Restart del gateway durante bypass activo deja la sesión
  relajada sin timer de reversión** → Mitigación: el estado persistido en el
  store de sesión (`execSecurity`/`execAsk`) sigue siendo el valor relajado,
  pero es indistinguible de un cambio manual permanente hasta que algo lo
  revierta. Mitigación operativa: documentar en el runbook que tras
  cualquier restart del gateway conviene revisar sesiones con
  `execSecurity` no-default; considerar en iteración futura un chequeo de
  arranque que audite y reporte (no revierta automáticamente, para no
  sorprender) sesiones con override activo.
- **[Riesgo, ya no aplica]** ~~`operator.admin` scope más amplio que el
  resto de comandos del plugin~~ — descartado junto con la vía RPC en D1: al
  escribir el store de sesión in-process (`patchSessionEntry`), no hay scope
  de gateway que verificar.
- **[Riesgo] Bypass por sesión puede confundir a un usuario que espera que
  "bypass" cubra todas sus conversaciones con el agente** → Mitigación:
  nombre del comando y texto de ayuda dejan explícito el alcance ("bypass
  para esta conversación, no para todo el agente"); si se necesita alcance
  de agente completo, usar `approval-mode full` (existente, ya documentado
  como bypass amplio y manual).
- **[Trade-off] No hay forma de que el core "empuje" un evento al plugin
  cuando el bypass expira más allá del propio timer del plugin** → Aceptado:
  el timer vive enteramente en el plugin (`setTimeout`/similar), no depende
  de que el core notifique nada.

## Migration Plan

Sin migración de datos — comando nuevo, sin cambios de schema persistente
más allá del uso ya soportado de `sessions.patch`. Despliegue:
1. Merge en `openclaw-xmpp` (este repo, fuente de verdad).
2. Actualizar gitlink del submodule en `claudio-w` (`extensions/xmpp`).
3. Redeploy del servicio (`claudio-w-openclaw.service`) — necesario porque
   el propio código del plugin cambió, no por el mecanismo de bypass en sí.
4. Verificación end-to-end: activar bypass desde un cliente de prueba,
   confirmar vía `status` que el TTL corre, confirmar que expira solo sin
   restart, confirmar reversión correcta de `execSecurity`/`execAsk`.
Rollback: revertir el gitlink al commit anterior + redeploy: no hay estado
persistente nuevo que requiera limpieza (el bypass activo, si lo hay, se
resuelve solo al perder el timer en el restart del rollback).

## Open Questions

- ¿Default y máximo de minutos? Propuesta a validar con el usuario en
  `tasks.md`/implementación: default 10 min, máximo 60 min, configurable por
  variable de entorno o por cuenta.
- El caso Mateo (prj451, Railway, `OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1`
  con binario desactualizado) es un problema de versión/flag distinto a este
  change — no se resuelve acá, solo se menciona para no perderlo de vista
  como trabajo futuro relacionado (actualizar imagen del template de
  Railway).
