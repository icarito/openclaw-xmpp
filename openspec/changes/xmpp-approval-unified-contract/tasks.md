# Tasks: contrato unificado de aprobaciones XMPP

> Repos objetivo: `openclaw-xmpp` (este repo, servidor), `gtk-llm-chat-android`
> y `gtk-llm-chat` (clientes, fuera de `allowedEditRoots` de este repo — sus
> cambios se coordinan, no se proponen desde acá). Despliegue en una sola
> ventana: sin fallback contractual entre servidor viejo/cliente nuevo o
> viceversa (decisión tomada).

## 1. Shape estructurado en el protocolo XEP-0050

- [ ] 1.1 Definir `ResultField`/`ActionResult` en `src/actions.ts`. Cambiar
      `XmppAction.handler` de `Promise<string> | string` a
      `Promise<ActionResult> | ActionResult`.
- [ ] 1.2 Actualizar `ActionDispatcher.execute()` para propagar
      `ActionResult` en vez de `string`.
- [ ] 1.3 En `src/xep-0050.ts`, normalizar el resultado
      (`typeof result === "string" ? {text: result} : result`) en
      `executeNoParams`/`executeAndComplete` antes de pasarlo a
      `commandCompleted`.
- [ ] 1.4 Extender `commandCompleted()` para aceptar `fields?: ResultField[]`
      y emitir `<x xmlns="jabber:x:data" type="result">` con un `<field
      var><value></value></field>` por entrada, como hijo adicional del
      `<command>`, sin tocar el `<note>` existente.
- [ ] 1.5 Revisar los demás handlers de `XmppAction` (`native-commands.ts`,
      `approval-mode.ts`, etc.) que retornan `string` directo: confirmar que
      siguen compilando sin cambios (el shape angosto sigue siendo válido,
      solo se amplió la unión).

## 2. `approval-bypass`: contrato estructurado

- [ ] 2.1 Cambiar el `return` de `mode=status` en `approval-bypass.ts` para
      devolver `{text, fields}` con `active`, `mode`, `scope`,
      `expires-at-ms`, `remaining-seconds` (activo) o solo `active=false`
      (inactivo).
- [ ] 2.2 Verificar que `mode=on`/`mode=off` siguen devolviendo texto plano
      (no necesitan campos estructurados — son confirmaciones de acción, no
      consultas de estado) o decidir si también se benefician de un `active`
      + `expires-at-ms` en la respuesta de activación.
- [ ] 2.3 Actualizar/extender `src/tests/approval-bypass.test.ts` (ya
      existe desde el cierre del change anterior) para cubrir la forma
      estructurada del resultado de `mode=status`.

## 3. Persistencia durable del bypass (fail-closed)

- [ ] 3.1 En `approval-bypass.ts`, al activar (`mode=on`), agregar
      `pluginExtensions.xmpp.approvalBypass = {expiresAtMs,
      previousExecSecurity, previousExecAsk}` al `update` de
      `patchSessionEntry`, preservando el resto de `pluginExtensions`
      existente (D3 del design).
- [ ] 3.2 En `revertBypass()`, limpiar esa misma clave al revertir (manual,
      por timer, o por el barrido de arranque), para que un bypass ya
      cerrado no quede como candidato a revertir dos veces.
- [ ] 3.3 Escribir `sweepExpiredApprovalBypasses({cfg})`: llama
      `listSessionEntries({})` sin filtrar `agentId`, filtra las entradas
      con `pluginExtensions.xmpp.approvalBypass.expiresAtMs < Date.now()`, y
      llama `revertBypass` (generalizado para aceptar la entrada leída del
      store) por cada una.
- [ ] 3.4 Invocar el barrido en `index.ts`'s `registerFull`, fire-and-forget
      con `.catch()` que solo loguea — mismo criterio que
      `cancelForSession` ya usa para `session_end`.
- [ ] 3.5 Test: activar un bypass con `expiresAtMs` en el pasado (mockeado),
      correr el barrido, confirmar que revierte la policy y limpia
      `pluginExtensions.xmpp.approvalBypass`.
- [ ] 3.6 Test: un bypass con `expiresAtMs` futuro no se toca durante el
      barrido.
- [ ] 3.7 Test: barrido sin ningún bypass expirado no revierte nada ni
      lanza.

## 4. Clientes: corte limpio del parseo por regex

- [ ] 4.1 (`gtk-llm-chat-android`) `getApprovalBypassStatus` en
      `XmppService.ts` lee los campos del formulario de resultado
      (`active`, `expires-at-ms`, `remaining-seconds`) en vez de
      `/activo/i` + `/quedan\s+(\d+)([ms])/i`.
- [ ] 4.2 (`gtk-llm-chat`) `_query_approval_bypass_status` en
      `chat_window.py` hace el mismo cambio en Python.
- [ ] 4.3 Confirmar en ambos clientes que el `<note>` deja de leerse para
      ningún propósito funcional (solo puede quedar como log/debug).

## 5. Documentación: cuatro alcances, no tres mecanismos

- [ ] 5.1 Reescribir la sección de modos de aprobación en `OPERATIONS.md`
      como tabla de cuatro alcances: bypass de sesión (`approval-bypass`),
      `elevated` de sesión (core, no expuesto todavía por XEP-0050),
      `approval-mode` de agente (persistente, requiere reinicio), allowlist
      permanente (`exec-approvals.json`).
- [ ] 5.2 Marcar explícitamente `elevated` como candidato prioritario de la
      Fase 3 del programa de paridad (`xmpp-parity-baseline` en
      `claudio-w`), no como trabajo de este change.

## 6. Cierre

- [ ] 6.1 `tsc --noEmit` y `vitest run` verdes con todo el código de este
      change.
- [ ] 6.2 Coordinar la ventana de despliegue: servidor + los dos clientes
      publicados/instalables antes de que cualquiera dependa del contrato
      nuevo.
- [ ] 6.3 Actualizar `openspec/ROADMAP.md` en `claudio-w` con el cierre de
      esta fase y el enlace a este change.
- [ ] 6.4 Confirmar que `xmpp-approval-loose-ends` (en `claudio-w`) queda
      correctamente marcado como absorbido, sin tareas vivas colgando.
