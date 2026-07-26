## Why

Hoy conviven tres mecanismos de "saltarse aprobaciones de exec" que resuelven
alcances parecidos con nombres parecidos: `elevated` (comando nativo del
core de OpenClaw, respaldado por `SessionEntry.elevatedLevel`, sin UI ni
comando expuesto por este plugin), `approval-bypass` (comando propio del
plugin, sesión + TTL, es el botón "bypass" que hoy usan gtk-llm-chat y
gtk-llm-chat-android) y `approval-mode` (comando propio del plugin, agente
entero, persistente en `openclaw.json`, requiere reiniciar
`claudio-w-openclaw.service` para aplicar).

La Fase 2 del programa de paridad XMPP↔Telegram
(`archive/2026-07-25-xmpp-approval-unified-contract`) documentó estos tres
como un modelo conceptual de alcances distintos, pero dejó pendiente para
esta Fase 3 la decisión real: exponer `elevated` por XEP-0050 y decidir qué
hacer con los otros dos. Se confirmó en producción (2026-07-26) que la causa
de que `/elevated full` no auto-aprobara de verdad estaba en
`exec-approvals.json` (`defaults.security`/`ask` explícitos ganando sobre el
override de elevated), ya corregido — la mecánica base de `elevated`
funciona; lo que falta es un comando/UI usable con TTL, y decidir el
destino de los otros dos mecanismos.

Decisión de producto: unificar en un solo mecanismo de sesión. `elevated`
pasa a ser el único bypass expuesto por este plugin, con TTL (que hoy no
tiene nativamente) agregado a nivel de plugin siguiendo el mismo patrón que
ya usa `approval-bypass` (temporizador en memoria + registro persistido para
fail-closed ante reinicio). `approval-bypass` y `approval-mode` se retiran:
el primero porque queda subsumido exactamente por `elevated`+TTL; el segundo
porque su fricción operativa (requiere reiniciar el gateway para una
política que además es agente-entero, no sesión) no aporta nada que
`elevated` no cubra para el caso real de uso — si hace falta cambiar la
política default persistente de un agente, se edita `exec-approvals.json`/
`openclaw.json` directamente, sin necesidad de un comando XMPP dedicado.

## What Changes

- **Nuevo comando XEP-0050 `elevated`** en el plugin, modos `on|off|status`
  (mismo shape que `approval-bypass` hoy) más un parámetro `minutes`
  (default y máximo a definir en design.md). Opera sobre
  `SessionEntry.elevatedLevel` (vía el mismo `getSessionEntry`/
  `patchSessionEntry` del SDK que ya usa `approval-bypass.ts`), no sobre
  `execSecurity`/`execAsk` directo.
- **TTL con persistencia fail-closed**, reusando el patrón de
  `approval-bypass.ts`: temporizador en memoria para el camino rápido +
  registro en `SessionEntry.pluginExtensions.xmpp` para sobrevivir un
  reinicio del gateway sin quedar fail-open.
- **Contrato de estado estructurado** vía XEP-0004 `type="result"` para
  `status` (mismo patrón que ya adoptó `approval-bypass` en la Fase 2:
  campos `active`, `mode`, `expires-at-ms`, `remaining-seconds`), para que
  los clientes no vuelvan a parsear prosa.
- **BREAKING: se retira `approval-bypass`** (`src/approval-bypass.ts`,
  comando, sweep de arranque, tests). El botón "bypass" en gtk-llm-chat y
  gtk-llm-chat-android pasa a invocar el nuevo comando `elevated`.
- **BREAKING: se retira `approval-mode`** (`src/approval-mode.ts`, comando).
  No tiene call-sites de UI en ningún cliente (solo se invocaba como texto
  `/oc approval-mode ...`), así que el impacto de cliente es nulo, pero es
  una eliminación de superficie pública del plugin.
- **`OPERATIONS.md` reescrito**: la tabla de "cuatro alcances" pasa a "tres
  alcances" (elevated de sesión con TTL, allowlist de exec-approvals.json
  permanente por comando, y edición directa de config para agente-entero
  permanente) — sin dos filas separadas para bypass/elevated que hoy
  confunden.

## Capabilities

### New Capabilities

- `xmpp-elevated-session`: comando XEP-0050 `elevated` con modos on/off/
  status, TTL configurable, contrato de resultado estructurado, y
  persistencia fail-closed de la expiración ante reinicio del gateway.

### Modified Capabilities

(ninguna — `xmpp-approval-bypass` no se modifica, se retira completamente;
ver Removed Capabilities)

### Removed Capabilities

- `xmpp-approval-bypass`: reemplazada íntegramente por `xmpp-elevated-session`.
  El comando `approval-bypass`, su sweep de arranque y sus tests se eliminan.

## Impact

- **Este repo** (`openclaw-xmpp`): nuevo `src/elevated-session.ts` (o
  nombre a definir en design.md) reemplazando `src/approval-bypass.ts`;
  eliminación de `src/approval-mode.ts`; `index.ts` (registro de comandos y
  sweep de arranque); `OPERATIONS.md`; `src/tests/approval-bypass.test.ts` y
  `approval-bypass-sweep.test.ts` migran su cobertura al nuevo módulo.
- **Cliente Android** (`gtk-llm-chat-android`, fuera de `allowedEditRoots`
  de este repo — cambio coordinado, no implementado acá):
  `src/xmpp/XmppService.ts` — `setApprovalBypass`/`getApprovalBypassStatus`
  (líneas ~2778-2802) pasan a invocar el comando `elevated` en vez de
  `approval-bypass`.
- **Cliente GTK** (`gtk-llm-chat`, fuera de `allowedEditRoots` — ídem):
  `gtk_llm_chat/chat_window.py` — `_set_approval_bypass`/
  `_query_approval_bypass_status` (líneas ~2306-2413) y las referencias al
  nodo `'approval-bypass'` en los mapeos de botones/comandos (líneas
  ~2480-2706) pasan a invocar/reconocer `elevated`; `agent_commands_sidebar.py`
  línea 34 (`('agent-', 'approval-bypass')`) actualiza el filtro de menú.
- **Despliegue coordinado, sin fallback contractual**: los tres repos deben
  quedar publicados/instalables en la misma ventana — mismo criterio que
  usó la Fase 2 (corte limpio, no ventana de compatibilidad, al controlar
  los tres repos).
- **No requiere cambio upstream en `openclaw`**: `SessionEntry.elevatedLevel`,
  `pluginExtensions` y `getSessionEntry`/`patchSessionEntry` ya existen en el
  SDK instalado (`openclaw@2026.7.1`).
