# Tasks: comando `elevated` de sesión, retiro de approval-bypass/approval-mode

> Repo objetivo: `openclaw-xmpp`. Cambios en clientes (gtk-llm-chat,
> gtk-llm-chat-android) están fuera de `allowedEditRoots` de este change —
> se documentan como impacto coordinado, no se implementan aquí.

## 1. Nuevo módulo `src/elevated-session.ts`

- [x] 1.1 Crear `src/elevated-session.ts` adaptando el patrón de
      `src/approval-bypass.ts` (TTL en memoria + persistencia fail-closed +
      sweep): mismo `DEFAULT_BYPASS_MINUTES`/`MAX_BYPASS_MINUTES`, mismo
      `activeBypasses: Map<string, BypassEntry>`, misma estructura
      `PersistedBypass`.
- [x] 1.2 Cambiar el campo objetivo de `execSecurity`/`execAsk` a
      `elevatedLevel`: `revertBypass` restaura `elevatedLevel: previousLevel`
      (no `execSecurity`/`execAsk`); la activación escribe
      `elevatedLevel: "full"` (constante, no parametrizable — ver D2 en
      design.md).
- [x] 1.3 `PersistedBypass` pasa a `{ expiresAtMs, previousElevatedLevel:
      string | null }` (un solo campo previo, no dos como
      `previousExecSecurity`/`previousExecAsk`).
- [x] 1.4 Namespace de persistencia: reusar `pluginExtensions.xmpp`, con una
      key distinta (p.ej. `elevatedBypass`) para no colisionar si algún
      registro viejo de `approvalBypass` sobrevive sin limpiar (ver tarea
      3.3).
- [x] 1.5 `buildElevatedSessionAction()` (reemplaza
      `buildApprovalBypassAction`): mismo shape de params (`mode`:
      on/off/status, `minutes`: text-single), node `elevated`, nombre y
      descripción actualizados para reflejar que opera sobre el nivel
      elevado nativo del core, no sobre `execSecurity`/`execAsk` directo.
- [x] 1.6 `sweepExpiredElevatedBypasses()` (reemplaza
      `sweepExpiredApprovalBypasses`): misma lógica de barrido, leyendo la
      nueva key de `pluginExtensions`.
- [x] 1.7 Mantener el mismo contrato de resultado estructurado (XEP-0004
      `type="result"`, campos `active`, `scope`, `mode`, `expires-at-ms`,
      `remaining-seconds`) que ya implementa `approval-bypass` hoy.

## 2. Retiro de `approval-bypass.ts` y `approval-mode.ts`

- [x] 2.1 Eliminar `src/approval-bypass.ts`.
- [x] 2.2 Eliminar `src/approval-mode.ts`.
- [x] 2.3 `src/commands.ts:44-45` — quitar los imports
      `buildApprovalModeAction`/`buildApprovalBypassAction`, agregar import
      de `buildElevatedSessionAction` desde `./elevated-session.js`.
- [x] 2.4 `src/commands.ts:131-132` — reemplazar las dos líneas
      `buildApprovalModeAction({...})`/`buildApprovalBypassAction({...})`
      por una sola `buildElevatedSessionAction({ account, cfg })`.
- [x] 2.5 `index.ts:58-69` — actualizar el comentario y el `import` dinámico
      de `./src/approval-bypass.js` a `./src/elevated-session.js`, llamando
      `sweepExpiredElevatedBypasses` en vez de
      `sweepExpiredApprovalBypasses`.

## 3. Tests

- [x] 3.1 Renombrar/adaptar `src/tests/approval-bypass.test.ts` →
      `elevated-session.test.ts`: mismos casos (activar, status, off
      manual, clamp de minutos máximos, sender no autorizado), aserciones
      sobre `elevatedLevel` en vez de `execSecurity`/`execAsk`.
- [x] 3.2 Renombrar/adaptar `src/tests/approval-bypass-sweep.test.ts` →
      `elevated-session-sweep.test.ts`: mismos casos (revert de expirado en
      sweep, no-touch de no-expirado, sweep sin nada que revertir),
      apuntando a la nueva key de `pluginExtensions`.
- [x] 3.3 Agregar un caso nuevo (no existía en `approval-bypass`, ver D3 en
      design.md): sesión con `elevatedLevel` no-default preexistente antes
      de activar el bypass — verificar que se restaura ese valor exacto al
      expirar, no `"off"`.
- [x] 3.4 `tsc --noEmit` sale 0, `vitest run` pasa con la suite completa
      renombrada (sin dejar los archivos viejos de test huérfanos).

## 4. Documentación

- [x] 4.1 `OPERATIONS.md` — reescribir la tabla de alcances (hoy "cuatro
      filas": bypass de sesión / elevated de sesión / approval-mode de
      agente / allowlist permanente) a tres filas: `elevated` (sesión, TTL,
      único mecanismo temporal), allowlist de `exec-approvals.json`
      (permanente por comando), edición directa de config (permanente por
      agente, sin comando XMPP dedicado).
- [x] 4.2 `OPERATIONS.md` — quitar la sección "`approval-mode` and
      `approval-bypass`" (líneas ~20-41 al momento de escribir este plan) y
      reemplazar por una sección "`elevated`" con el mismo nivel de detalle
      (mecanismo, ejemplos de invocación, valores de `mode`).
- [x] 4.3 `OPERATIONS.md` — actualizar los ejemplos de invocación (línea
      ~53-58: quitar `/oc approval-mode ...`, cambiar
      `/oc approval-bypass ...` por `/oc elevated ...`).

## 5. Coordinación con clientes (fuera de este repo, documentar el cambio exacto)

- [x] 5.1 `gtk-llm-chat-android/src/xmpp/XmppService.ts` (~2778-2802):
      `setApprovalBypass`/`getApprovalBypassStatus` invocan
      `executeCommand`/`executeCommandWithFields` con el nodo `elevated` en
      vez de `approval-bypass`; el resto de la lógica (shape de campos)
      no cambia.
- [x] 5.2 `gtk-llm-chat/gtk_llm_chat/chat_window.py` (~2306-2413):
      `_set_approval_bypass`/`_query_approval_bypass_status` buscan el nodo
      `'elevated'` en vez de `'approval-bypass'` en la lista de comandos
      del agente.
- [x] 5.3 `gtk-llm-chat/gtk_llm_chat/chat_window.py` (~2480, 2527, 2659,
      2706): mapeos de nombre de botón/comando (`'bypass': ('bypass',
      'approval_bypass')` y su inverso) actualizan la clave interna a algo
      que no colisione con el nombre `elevated` del core (evitar ambigüedad
      con el propio comando nativo si el cliente alguna vez lo expone
      también).
- [x] 5.4 `gtk-llm-chat/gtk_llm_chat/agent_commands_sidebar.py:34` — el
      filtro `('agent-', 'approval-bypass')` pasa a `('agent-', 'elevated')`.
- [x] 5.5 Verificar en ambos clientes que un nodo de comando ausente (por
      desfase de despliegue) produce un mensaje de error legible, no un
      crash — condición para que el orden de despliegue plugin-primero sea
      seguro (ver Risks en design.md).

## 6. Verificación end-to-end (en el servidor real, tras desplegar)

- [ ] 6.1 Activar `elevated on 5` desde un cliente, confirmar que un
      comando exec subsiguiente en esa sesión auto-aprueba sin card.
- [ ] 6.2 Confirmar expiración automática pasado el TTL (sin intervención
      manual): un exec posterior vuelve a pedir aprobación normal.
- [ ] 6.3 Activar `elevated on`, reiniciar `claudio-w-openclaw.service`
      manualmente antes de que expire, confirmar que el sweep de arranque
      NO revierte (bypass aún vigente) y que sí revierte si se reinicia
      después de la expiración.
- [ ] 6.4 Confirmar que `approval-bypass`/`approval-mode` ya no aparecen en
      el menú de comandos de ningún cliente tras el despliegue coordinado.
