# Tasks: contrato unificado de aprobaciones XMPP

> Repos objetivo: `openclaw-xmpp` (este repo, servidor), `gtk-llm-chat-android`
> y `gtk-llm-chat` (clientes, fuera de `allowedEditRoots` de este repo — sus
> cambios se coordinan, no se proponen desde acá). Despliegue en una sola
> ventana: sin fallback contractual entre servidor viejo/cliente nuevo o
> viceversa (decisión tomada).

## 1. Shape estructurado en el protocolo XEP-0050

- [x] 1.1 `ResultField`/`ActionResult` definidos en `src/actions.ts`.
      `XmppAction.handler` retorna `Promise<ActionResult> | ActionResult`.
- [x] 1.2 `ActionDispatcher.execute()` propaga `ActionResult`.
- [x] 1.3 `normalizeActionResult()` en `src/xep-0050.ts`, usado en
      `executeNoParams`/`executeAndComplete`.
- [x] 1.4 `commandCompleted()` acepta `fields?: ResultField[]` y emite
      `<x xmlns="jabber:x:data" type="result">` con un `<field var><value>`
      por entrada, como hijo adicional del `<command>`. Verificado con
      `src/tests/xep-0050-result-form.test.ts` (3 tests): el `<note>` no se
      toca, y sin `fields` no se emite ningún `<x>`.
- [x] 1.5 Confirmado por `tsc --noEmit` limpio: ningún handler existente que
      retorna `string` directo (native-commands.ts, approval-mode.ts, etc.)
      necesitó cambio — la unión ampliada acepta el shape angosto sin más.
      También se corrigió `onActionComplete` (recibía el resultado crudo sin
      normalizar, tipado `string`; ahora recibe el texto ya normalizado — sin
      consumidores externos que dependieran del tipo viejo).

## 2. `approval-bypass`: contrato estructurado

- [x] 2.1 `mode=status` devuelve `{text, fields}` con `active`, `scope`,
      `mode`, `expires-at-ms`, `remaining-seconds` cuando hay bypass activo,
      o solo `active=false` cuando no.
- [x] 2.2 Decidido: `mode=on`/`mode=off` siguen devolviendo texto plano. Son
      confirmaciones de una acción que el propio cliente acaba de disparar
      (ya sabe qué pidió), no consultas de estado — no ganan nada con campos
      estructurados que solo repetirían lo que el cliente ya envió.
- [x] 2.3 `src/tests/approval-bypass.test.ts` actualizado con
      `resultText()`/`resultField()` helpers y aserciones sobre `active`/
      `remaining-seconds` en los tests de `mode=status`. 7/7 verde.

## 3. Persistencia durable del bypass (fail-closed)

- [x] 3.1 `pluginExtensions.xmpp.approvalBypass = {expiresAtMs,
      previousExecSecurity, previousExecAsk}` (con `null` en vez de
      `undefined` para las políticas previas, porque
      `SessionPluginJsonValue` no acepta `undefined`) escrito al activar,
      preservando el resto de `pluginExtensions` vía spread.
- [x] 3.2 `revertBypass()` generalizado para recibir `sessionKey`/policies
      directo (no solo desde el `Map` en memoria) y limpiar
      `pluginExtensions.xmpp.approvalBypass` vía `clearPersistedBypass()` en
      cada reversión — manual, por timer, o por el barrido.
- [x] 3.3 `sweepExpiredApprovalBypasses()` implementado sin parámetro
      `cfg` (no hacía falta: `listSessionEntries({})` no lo requiere, y
      `deriveAgentIdFromSessionKey()` deriva el `agentId` del propio
      `sessionKey` con el patrón `agent:<agentId>:...` que
      `buildAgentSessionKey` ya usa).
- [x] 3.4 Invocado en `index.ts`'s `registerFull` con import dinámico +
      `.catch()` que solo loguea.
- [x] 3.5 `src/tests/approval-bypass-sweep.test.ts`: bypass vencido se
      revierte y limpia su entrada persistida.
- [x] 3.6 Mismo archivo: bypass no vencido no se toca.
- [x] 3.7 Mismo archivo: sin bypasses persistidos, no revierte nada.
      Además (no estaba en el plan original, se agregó al notar el
      insumo): un test de que otras claves de `pluginExtensions` ajenas al
      bypass se preservan al limpiar, y uno de que el barrido cubre varios
      agentes en una sola pasada. 5/5 verde.

## 4. Clientes: corte limpio del parseo por regex

- [x] 4.1 (`gtk-llm-chat-android` `df8841f`) `getApprovalBypassStatus` usa
      la nueva `executeCommandWithFields` (envuelve la misma lógica de
      request que `executeCommand`, reusando `parseSubmitForm` de
      `xep-0004.ts` para el `<x>`), lee `fields.active`/`fields['remaining-
      seconds']`. `executeCommand` en sí no cambió de firma — sigue
      devolviendo `string` para sus demás call sites. Verificado:
      `npm run type-check` limpio, `jest` 81/81 sin regresión.
- [x] 4.2 (`gtk-llm-chat` `3a158e5`) `xmpp_commands.py` gana
      `command_result_fields()`, hermana de `command_result_body()` (reusa
      `extend_form`, expone `var->value` crudo). `chat_window.py` la usa en
      vez de las regex. Sin suite de tests instalable en este entorno
      (`xmpp_commands.py` encadena a un módulo `llm` ausente) — verificado
      en cambio de forma aislada contra `nbxmpp` real: un `<x
      type="result">` de dos campos produce el dict esperado,
      `command.data=None` produce `{}` sin lanzar.
- [x] 4.3 Confirmado en ambos: `getApprovalBypassStatus`/
      `_query_approval_bypass_status` ya no reciben ni leen el texto del
      `<note>` en absoluto — solo desestructuran `fields`. `noteText`/
      `command_result_body` siguen usándose para el resto de comandos (que
      no llevan campos estructurados), sin cambio ahí.

## 5. Documentación: cuatro alcances, no tres mecanismos

- [x] 5.1 `OPERATIONS.md` reescrito (`58b41a5`) con la tabla de cuatro
      alcances al inicio de "Approval modes".
- [x] 5.2 `elevated` marcado en la tabla como "OpenClaw core native
      command; not yet exposed via XEP-0050 in this plugin -- planned, see
      xmpp-parity-baseline Phase 3".

## 6. Cierre

- [x] 6.1 `tsc --noEmit` sale 0, `vitest run` pasa 35/35 (27 previos + 8
      nuevos: 3 de `xep-0050-result-form.test.ts` + 5 de
      `approval-bypass-sweep.test.ts`).
- [x] 6.2 Servidor (`21ec431`), Android (`df8841f`) y GTK (`3a158e5`)
      commiteados en la misma sesión de trabajo — ninguno depende de un
      release intermedio del otro dado que el `<x>` es aditivo (D1: un
      cliente viejo sigue leyendo el `<note>` sin romperse). Publicación/
      instalación real en dispositivos queda a criterio del usuario, fuera
      del alcance de lo que un agente puede verificar desde este entorno.
- [x] 6.3 `ROADMAP.md` actualizado con el cierre de esta fase.
- [x] 6.4 `xmpp-approval-loose-ends/tasks.md` actualizado: el aviso de
      estado ahora dice explícitamente que ya fue absorbido y cerrado (no
      "va a absorberse"), distingue claramente que la Fase 2 resolvió el
      fail-open del bypass (una cosa) y no la reconciliación de approvals
      huérfanas del core (3.x, sigue bloqueada, cosa distinta), y recomienda
      archivar el change.
