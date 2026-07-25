## Why

Hoy conviven, sin fallar visiblemente, tres problemas independientes en el
ciclo de vida de las aprobaciones XMPP:

1. **El contrato de estado del bypass es prosa en español, parseada por
   regex en dos clientes.** El servidor responde a `approval-bypass status`
   con texto libre (`"Bypass: activo, quedan 8m."`); Android
   (`gtk-llm-chat-android/src/xmpp/XmppService.ts`) y GTK
   (`gtk-llm-chat/gtk_llm_chat/chat_window.py`) reimplementan, cada uno por
   su lado, `/activo/i` + `/quedan\s+(\d+)([ms])/i` para recuperar el estado.
   Cambiar una palabra del texto rompe silenciosamente ambos clientes sin
   que ningún test lo detecte.

2. **El bypass falla abierto si el gateway reinicia mientras está activo.**
   El temporizador que lo revierte vive en memoria del proceso
   (`src/approval-bypass.ts`). Si el proceso reinicia, el temporizador se
   pierde pero la policy relajada (`execSecurity:"full"`, `execAsk:"off"`)
   ya escrita en el session store persiste — la sesión queda con exec sin
   aprobación indefinidamente, y nada lo señala. Este comportamiento está
   documentado como aceptado en el spec vigente
   (`specs/xmpp-approval-bypass/spec.md`, requirement "Bypass state does not
   survive gateway restart") — este change lo revierte.

3. **No hay un "modo override elevado" reconocido; hay tres mecanismos que
   se presentan como si compitieran.** `approval-bypass` (sesión, temporal),
   `approval-mode` (agente, persistente, requiere reinicio) y el allowlist
   de `exec-approvals.json` (comandos puntuales, persistente) resuelven
   necesidades distintas, pero la documentación no lo deja claro. Además, el
   registro nativo del core ya trae un comando `elevated` (verificado en
   `xmpp-parity-baseline`, Fase 1 del programa de paridad XMPP↔Telegram)
   respaldado por `SessionEntry.elevatedLevel` — un cuarto mecanismo no hace
   falta.

Se decidió corte limpio del contrato (no ventana de compatibilidad): al
controlar los tres repos (este plugin + GTK + Android), mantener el parseo
de prosa como fallback perpetuo solo prolonga la fragilidad. Los tres se
despliegan en la misma ventana operativa.

## What Changes

- **Contrato estructurado vía XEP-0004 `type="result"`.** `commandCompleted()`
  (`src/xep-0050.ts`) hoy solo emite `<note type="info">texto</note>`.
  XEP-0050 §3.4 permite adjuntar además un formulario de resultado. Se
  extiende `XmppAction.handler` para poder devolver `{text, fields}` en vez
  de solo `string`; cuando hay `fields`, se emite el `<x type="result">`
  junto al `<note>`. `approval-bypass` en modo `status` devuelve campos:
  `active`, `scope`, `expires-at-ms`, `remaining-seconds`, `mode`.

- **Corte limpio: se elimina el parseo por regex en ambos clientes.**
  Android (`getApprovalBypassStatus` en `XmppService.ts`) y GTK
  (`_query_approval_bypass_status` en `chat_window.py`) leen los campos
  estructurados del formulario de resultado, no el texto. El `<note>` se
  conserva como texto legible para humanos (Gajim, Cheogram sin parsing
  especial), pero deja de ser contrato para ningún cliente propio.

- **El bypass pasa a fallar cerrado ante un reinicio.** Se persiste
  `{expiresAtMs, previousExecSecurity, previousExecAsk}` en
  `SessionEntry.pluginExtensions["xmpp"]["approvalBypass"]` (existe en el
  SDK, sin cambio upstream) al activar el bypass. Al cargar el plugin
  (`registerFull` en `index.ts`), un barrido de `listSessionEntries()`
  revierte cualquier bypass cuyo `expiresAtMs` ya pasó, restaurando la
  policy previa guardada. El `setTimeout` en memoria sigue siendo la vía
  rápida cuando el proceso no reinicia; el registro durable es la fuente de
  verdad para cuando sí.

- **`/elevated` se documenta como el override reconocido, sin exponerlo
  todavía por XEP-0050.** Se reencuadra `OPERATIONS.md` como una tabla de
  cuatro alcances (bypass de sesión, `elevated` de sesión, `approval-mode`
  de agente, allowlist permanente), en vez de tres mecanismos que compiten.
  Exponer el nodo `elevated` en el menú de XEP-0050 es trabajo de la Fase 3
  del programa de paridad (depende del filtrado por tier ya medido en
  `xmpp-parity-baseline`); este change solo fija el modelo conceptual.

- **Se cierra `xmpp-approval-loose-ends` (en `claudio-w`) como bitácora
  absorbida.** Su tarea de reconciliación al arranque (3.x) se descarta
  explícitamente: `plugin-sdk` no expone ningún endpoint para enumerar
  aprobaciones pendientes del lado del core (verificado, no existe
  `replayPendingApprovals` ni equivalente), así que la reconciliación de
  *approvals* huérfanas queda como pedido upstream, distinta del barrido de
  *bypasses* de este change (que sí es implementable: el plugin es dueño de
  su propio registro en `pluginExtensions`, no depende de enumerar estado
  del core).

## Capabilities

### Modified Capabilities

- `xmpp-approval-bypass`: se agrega persistencia durable del estado de
  bypass activo (para que sobreviva un reinicio sin quedar fail-open) y un
  contrato de estado estructurado vía XEP-0004 result form (para que los
  clientes dejen de parsear prosa).

## Impact

- **Este repo** (`openclaw-xmpp`): `src/actions.ts` (`XmppAction.handler`,
  `ActionDispatcher.execute`), `src/xep-0050.ts` (`commandCompleted`,
  `executeNoParams`, `executeAndComplete`), `src/approval-bypass.ts`
  (persistencia + barrido), `index.ts` (invocar el barrido en
  `registerFull`), `OPERATIONS.md` (tabla de cuatro alcances).
- **Cliente Android** (`gtk-llm-chat-android`, fuera de `allowedEditRoots`
  de este repo — cambios coordinados, no propuestos acá):
  `src/xmpp/XmppService.ts` (`getApprovalBypassStatus`) deja de parsear
  prosa.
- **Cliente GTK** (`gtk-llm-chat`, fuera de `allowedEditRoots` — ídem):
  `gtk_llm_chat/chat_window.py` (`_query_approval_bypass_status`) deja de
  parsear prosa.
- **Despliegue coordinado, sin fallback contractual**: los tres repos deben
  quedar publicados/instalables en la misma ventana. Un cliente viejo que
  reciba el nuevo formulario de resultado lo ignora sin romperse (es un
  `<x>` hijo adicional del `<command>`, no un reemplazo del `<note>`); lo
  que se retira es la capacidad de leer el estado desde la prosa, no la
  prosa en sí.
- **No requiere cambio upstream en `openclaw`.** `pluginExtensions` y
  `listSessionEntries` ya existen en el SDK instalado (verificado contra
  `node_modules/openclaw@2026.7.1`).
