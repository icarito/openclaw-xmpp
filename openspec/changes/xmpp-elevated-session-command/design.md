## Context

Tres mecanismos resuelven hoy "saltarse aprobaciones de exec" con distinto
alcance (ver proposal.md para el detalle de cada uno): `elevated` (core,
sin UI), `approval-bypass` (plugin, sesión+TTL, con UI en ambos clientes) y
`approval-mode` (plugin, agente-entero, persistente, requiere reinicio).

`SessionEntry.elevatedLevel` es de tipo `ElevatedLevel = "off" | "on" | "ask"
| "full"` (confirmado en `node_modules/openclaw/dist/thinking.shared-*.d.ts`),
opcional, string en el shape público de `SessionEntry`
(`plugin-sdk`/`index-*.d.ts`: `elevatedLevel?: string | null | undefined`).
El core resuelve el modo efectivo de exec leyendo este campo por sesión; el
bug corregido el 2026-07-25 confirmó en producción que, con
`exec-approvals.json` sin overrides de `security`/`ask` bloqueando, un
`elevatedLevel:"full"` ya alcanza para que `bypassApprovals` sea `true` en
el core — no hace falta ningún cambio en el core para esta Fase 3.

`approval-bypass.ts` ya resuelve, para el caso `execSecurity`/`execAsk`, el
mismo problema que este change necesita resolver para `elevatedLevel`: TTL
con temporizador en memoria (camino rápido) + registro persistido en
`SessionEntry.pluginExtensions.xmpp` (fuente de verdad ante reinicio,
barrido en `registerFull`). Ese patrón se reutiliza casi sin cambios,
sustituyendo qué campos de `SessionEntry` se leen/escriben y qué valor
"anterior" hay que restaurar al expirar.

## Goals / Non-Goals

**Goals:**
- Un solo comando XEP-0050 (`elevated`) que sea la única vía de sesión para
  saltarse aprobaciones de exec, con contrato estructurado y TTL.
- Migrar el botón "bypass" de ambos clientes al nuevo comando sin cambiar su
  UX visible (mismo botón, mismo texto probablemente, distinto nodo XEP-0050
  por debajo).
- Retirar `approval-bypass` y `approval-mode` sin dejar código muerto ni
  tests huérfanos.

**Non-Goals:**
- No se toca el core de OpenClaw ni `exec-approvals.json`/`openclaw.json`
  como mecanismo — ambos siguen existiendo como los alcances "permanente por
  comando" y "permanente por agente" respectivamente (ver tabla actualizada
  de OPERATIONS.md en tasks.md).
- No se expone en esta fase el resto de comandos candidatos del
  `deny-list.ts` de `xmpp-parity-baseline` (`whoami`, `session`, `models`,
  etc.) — eso sigue siendo trabajo separado del "command menu by tier".
- No se agrega un modo intermedio nuevo: los valores expuestos por el
  comando son exactamente `on|off|status`, igual que `approval-bypass` hoy;
  `on` mapea siempre a `elevatedLevel:"full"` (no a `"on"` ni `"ask"` del
  union del core) porque es el único valor que el core reconoce como bypass
  real de aprobaciones — exponer `ask`/`on` del core por este comando no
  resuelve ningún caso de uso nuevo y añadiría una superficie de confusión
  que el change entero busca eliminar.

## Decisions

### D1. Un módulo nuevo (`src/elevated-session.ts`), no editar `approval-bypass.ts` in-place

Se descartó renombrar/editar `approval-bypass.ts` en el lugar porque el
diff resultante sería difícil de revisar (mezcla "qué cambió de lógica" con
"qué es solo renombre"), y porque `approval-mode.ts` se elimina en el mismo
change — más claro tener un archivo nuevo, borrar los dos viejos, y que el
diff de git muestre la eliminación real de los módulos retirados.

### D2. `on` siempre activa `elevatedLevel:"full"`, no un parámetro de nivel

Alternativa considerada: exponer los cuatro valores del core (`off|on|ask|
full`) como opciones del formulario, análogo a como `approval-mode` exponía
`ask|auto|full|deny`. Se descarta: el objetivo de este change es tener UN
mecanismo de sesión con semántica binaria clara (bypasseado / no
bypasseado), igual que `approval-bypass` hoy (`on|off|status`, sin niveles
intermedios). Si en el futuro hace falta el matiz `ask` vs `on` del core
por sesión, es una extensión de parámetros de este mismo comando, no una
razón para no simplificar ahora.

### D3. Restaurar `elevatedLevel` previo al expirar/desactivar, igual que `approval-bypass` restaura `execSecurity`/`execAsk`

Mismo patrón: capturar `currentEntry?.elevatedLevel` antes de escribir
`"full"`, persistir ese valor previo (`null` si no había ninguno) en el
registro de `pluginExtensions`, y restaurarlo exacto al expirar/`off`/sweep
de arranque. Evita que una sesión que ya tenía `elevatedLevel:"ask"` por
alguna otra vía quede en `"off"` (valor sorpresa) al terminar el bypass
temporal.

### D4. Retiro de `approval-mode` sin mecanismo de reemplazo

Se consideró mantener `approval-mode` documentado como "caso raro,
requiere restart" en vez de eliminarlo. Se descarta a pedido explícito del
usuario: la fricción de reinicio no se justifica frente a
`elevated`+TTL cubriendo el caso real de uso, y un mecanismo persistente de
agente-entero puede seguir operándose editando `exec-approvals.json`/
`openclaw.json` directamente (vía SSH, como ya se hizo el 2026-07-26 para
el fix de `defaults.security`/`ask`) sin necesidad de un comando XMPP
dedicado que además requiere el mismo reinicio manual.

### D5. Migración de tests: adaptar cobertura, no descartar casos

`src/tests/approval-bypass.test.ts` y `approval-bypass-sweep.test.ts` cubren
casos genéricos de TTL/persistencia/sweep que siguen siendo válidos para el
nuevo mecanismo (activación, expiración, revert al `off`, sweep de arranque
tras reinicio con bypass ya vencido). Se migran renombrando el módulo bajo
prueba y ajustando las aserciones de `execSecurity`/`execAsk` a
`elevatedLevel`, en vez de escribir tests nuevos desde cero — preserva la
cobertura de regresión de la lógica de temporizador que ya fue endurecida
en la Fase 2.

## Risks / Trade-offs

- **[Riesgo] Ventana de despliegue descoordinado**: si el plugin se
  actualiza en el servidor antes que los clientes, el botón "bypass" de GTK/
  Android fallará con "comando no encontrado" (nodo `approval-bypass` ya no
  existe) → **Mitigación**: mismo criterio que la Fase 2 — desplegar los
  tres repos en la misma ventana operativa; documentar en tasks.md el orden
  de despliegue (plugin primero es seguro si los clientes toleran el nodo
  ausente con un mensaje de error legible, no un crash — verificar esto
  como parte de los tasks).
- **[Riesgo] Un agente con `elevatedLevel` seteado por otra vía (no este
  comando) al momento de activar el bypass** → **Mitigación**: D3 ya cubre
  esto capturando y restaurando el valor previo real, no asumiendo que
  siempre era `undefined`/`"off"`.
- **[Trade-off] Se pierde la granularidad de `approval-mode` (ask/auto/full/
  deny) como comando XMPP** → aceptado por decisión de producto (D4); sigue
  disponible por edición directa de archivo para el caso de uso raro.

## Migration Plan

1. Implementar `src/elevated-session.ts` (comando + sweep) en este repo,
   con tests migrados.
2. Actualizar `index.ts` (registro del nuevo comando, retiro del registro de
   `approval-bypass`/`approval-mode`, invocar el nuevo sweep en
   `registerFull` en vez del viejo).
3. Actualizar `OPERATIONS.md`.
4. Coordinar el cambio de call-sites en `gtk-llm-chat` y
   `gtk-llm-chat-android` (repos externos a este change) para que el botón
   "bypass" invoque el nuevo nodo `elevated` con el mismo contrato de
   campos (`active`, `mode`, `expires-at-ms`, `remaining-seconds`).
5. Desplegar los tres artefactos en la misma ventana (mismo mecanismo de
   deploy que `xmpp-parity-deployment`: checkout git pinneado por tag en el
   servidor).
6. Verificar en vivo: activar `elevated on`, confirmar auto-aprobación real
   de un comando exec, confirmar expiración automática, confirmar que un
   reinicio del gateway durante un bypass activo no lo deja fail-open.

Rollback: revertir el tag del checkout en el servidor (mismo mecanismo ya
verificado en `xmpp-parity-deployment`); los clientes con la UI vieja
seguirían funcionando contra el nodo `approval-bypass` solo si ese commit
específico del plugin todavía lo expone — por eso el rollback debe ser del
conjunto de los tres repos a una combinación consistente anterior, no solo
del plugin.

## Open Questions

- ¿El nombre del nodo XEP-0050 es literalmente `elevated` (coincide con el
  nombre del comando nativo del core, podría confundirse en documentación
  externa) o algo más específico como `elevated-session`? A definir en
  tasks.md al implementar — no bloquea el resto del diseño.
- ¿Default/máximo de minutos del TTL igual que `approval-bypass` hoy (10/60)
  o se ajusta? Sin señal de que el valor actual haya sido un problema —
  mantener por defecto salvo que tasks.md encuentre una razón para cambiarlo.
