# Design: contrato unificado de aprobaciones XMPP

## Estado verificado del código actual (2026-07-25)

- `commandCompleted()` (`src/xep-0050.ts:329-335`) construye únicamente
  `<command status="completed"><note type="info">{text}</note></command>`.
  No hay ningún hijo `<x>`.
- `XmppAction.handler` (`src/actions.ts:43`) devuelve `Promise<string> | string`.
  `ActionDispatcher.execute()` (`src/actions.ts:65-69`) también retorna
  `Promise<string>` — el shape angosto se propaga por tres capas
  (`XmppAction` → `ActionDispatcher` → `xep-0050.ts`), no es solo el punto
  final.
- `executeNoParams`/`executeAndComplete` (`src/xep-0050.ts:276-327`) llaman
  `action.handler(...)`, pasan el resultado a `this.onActionComplete?.()` (un
  callback opcional, sin relación con el shape) y luego a `commandCompleted`.
- `approval-bypass.ts`'s `handler` (líneas 121-207) ya construye la prosa
  exacta que los clientes parsean: `"Bypass: activo, quedan ${...}."` (mode
  status) y `"Bypass: activado por ${minutes} min..."` (mode on). Los campos
  que un formulario de resultado necesitaría —`active`, `expiresAtMs`,
  `previousExecSecurity`, `previousExecAsk`— ya están calculados dentro del
  handler, solo nunca se devuelven estructurados.
- **`SessionEntry.pluginExtensions?: Record<string, Record<string,
  SessionPluginJsonValue>>` existe** (`types-DVCyjomt.d.ts:176`), sin cambio
  upstream necesario.
- **`listSessionEntries(params?: SessionStoreListParams)` existe**
  (`session-store-runtime-CXWc67h3.d.ts:84`), y su parámetro es
  `Partial<Omit<SessionStoreReadParams, "sessionKey">>` — es decir, `agentId`
  es opcional. Se puede enumerar todas las sesiones de todos los agentes de
  una pasada, no hace falta iterar agente por agente.
- `index.ts`'s `registerFull: (api) => {...}` es el punto de arranque del
  plugin (se llama una vez al cargar). Ya aloja el registro de
  `session_end`; es el lugar natural para lanzar el barrido.

## Decisiones

### D1. `XmppAction.handler` retorna `string | { text: string; fields?: ResultField[] }`

En vez de una unión ad-hoc en cada call site, se define:

```ts
export type ResultField = { var: string; value: string };
export type ActionResult = string | { text: string; fields?: ResultField[] };
```

`ActionDispatcher.execute()` pasa a devolver `Promise<ActionResult>`.
`executeNoParams`/`executeAndComplete` normalizan (`typeof result === "string"
? {text: result} : result`) antes de pasarlo a `commandCompleted`, que gana un
parámetro opcional `fields?: ResultField[]` y, si está presente, adjunta:

```xml
<x xmlns="jabber:x:data" type="result">
  <field var="{var}"><value>{value}</value></field>
  ...
</x>
```

XEP-0050 §3.4 permite explícitamente un `<x type="result">` como hijo de
`<command status="completed">`, junto al `<note>` existente — no hay que
elegir entre los dos.

**Por qué no tocar el `<note>`:** clientes que no son GTK ni Android (Gajim,
Cheogram vía "Execute Command" genérico) ya renderizan el `<note>` y no van
a buscar el `<x>`. El corte limpio es solo sobre qué leen los clientes
propios, no sobre qué emite el protocolo — eliminar el `<note>` rompería la
retrocompatibilidad con clientes normales que el usuario explícitamente
quiere preservar.

### D2. `approval-bypass`'s modo `status` devuelve los campos que ya calcula

El handler ya tiene `existing.expiresAtMs`, `nowMs`, y el propio booleano
`!!existing`. Se cambia el `return` de mode=status de un string a:

```ts
{
  text: existing ? `Bypass: activo, quedan ${formatRemaining(...)}.` : "Bypass: inactivo...",
  fields: existing
    ? [
        { var: "active", value: "true" },
        { var: "scope", value: "session" },
        { var: "expires-at-ms", value: String(existing.expiresAtMs) },
        { var: "remaining-seconds", value: String(Math.max(0, Math.round((existing.expiresAtMs - nowMs) / 1000))) },
        { var: "mode", value: "on" },
      ]
    : [{ var: "active", value: "false" }],
}
```

No se inventa una codificación nueva: `var`/`value` como strings es
exactamente la forma de un campo de XEP-0004 `type="result"` (no hay
`list-single` ni opciones que elegir; es un reporte, no un formulario a
completar).

### D3. Persistencia del bypass: namespace `xmpp`, key `approvalBypass`

Al activar (mode=on), además de `patchSessionEntry({execSecurity, execAsk})`
ya existente, se agrega:

```ts
update: (entry) => ({
  execSecurity: BYPASS_EXEC_SECURITY,
  execAsk: BYPASS_EXEC_ASK,
  pluginExtensions: {
    ...entry.pluginExtensions,
    xmpp: {
      ...entry.pluginExtensions?.xmpp,
      approvalBypass: { expiresAtMs, previousExecSecurity, previousExecAsk },
    },
  },
}),
```

`revertBypass()` limpia la misma clave (`pluginExtensions.xmpp.approvalBypass:
null`, o eliminando la clave) al revertir, para que un bypass ya cerrado no
deje rastro que el barrido de arranque intente revertir dos veces.

**Esto reemplaza el requirement vigente "Bypass state does not survive
gateway restart"** de `specs/xmpp-approval-bypass/spec.md` — ver el spec
delta de este change, que lo marca `MODIFIED`.

**Por qué esto no es una migración de dato existente:** los bypasses activos
hoy (si los hay al momento del deploy) no tienen esta entrada persistida —
solo viven en el `Map` en memoria, que se pierde en el próximo reinicio de
todos modos. No hace falta backfill: el peor caso es idéntico al
comportamiento actual (bypass activo se pierde en el próximo restart, sin
revertir), no uno nuevo.

### D4. Barrido al arranque: por qué es implementable cuando la reconciliación de approvals no lo es

La tarea 3.x de `xmpp-approval-loose-ends` (en `claudio-w`, reconciliar
*approvals* huérfanas al arranque) está bloqueada porque el plugin no puede
preguntarle al core "¿esta aprobación sigue pendiente?" — no hay endpoint.
Este barrido es distinto en una forma que importa: el plugin **es dueño**
de su propio registro (`pluginExtensions.xmpp.approvalBypass`), escrito y
leído solo por este módulo. No hace falta reconciliar contra el core; hace
falta iterar el propio estado y decidir localmente si `expiresAtMs < now`.

En `index.ts`'s `registerFull`, agregar (fire-and-forget, igual criterio que
`cancelForSession`: nunca deja que un fallo aquí impida que el resto del
plugin registre sus hooks):

```ts
void sweepExpiredApprovalBypasses({ cfg: api.config }).catch((err) => {
  api.logger?.warn?.(`xmpp: fallo barriendo bypasses expirados: ${String(err)}`);
});
```

`sweepExpiredApprovalBypasses` llama `listSessionEntries({})` sin filtrar por
`agentId` (barre todos los agentes de una pasada, según lo confirmado
arriba), filtra las que tengan `pluginExtensions.xmpp.approvalBypass` con
`expiresAtMs < Date.now()`, y para cada una llama el mismo camino de
`revertBypass` que ya usa el timer normal — no se duplica lógica de
reversión, se generaliza `revertBypass` para aceptar la entrada leída del
store en vez de solo la del `Map` en memoria.

### D5. `elevated` se documenta, no se expone todavía

Exponer el nodo del registro requiere el trabajo de mapeo de choices→
list-single que es la Fase 3 completa del programa de paridad (filtrado por
tier, forms multi-campo — ver `xmpp-parity-baseline` en `claudio-w`).
Adelantarlo a medias en este change mezclaría dos fases sin necesidad. Lo
que sí se hace acá es fijar el modelo conceptual en `OPERATIONS.md`, para
que la Fase 3 tenga un lugar claro donde encajar `elevated` cuando llegue.

## Riesgos

- **[Medio] Despliegue coordinado sin fallback.** Si un cliente se
  actualiza y otro no dentro de la ventana, el que no se actualizó sigue
  leyendo el `<note>` con éxito (no se tocó), pero no se beneficia del
  contrato estructurado hasta que se actualice. No hay riesgo de rotura,
  solo de beneficio parcial temporal — aceptado, dado que la ventana es
  corta y los tres repos están bajo el mismo control.
- **[Bajo] `listSessionEntries({})` sin filtro puede ser costoso** si hay
  muchas sesiones acumuladas. Mitigación: correr una sola vez al arranque
  del plugin (no en un intervalo), y el filtro de `pluginExtensions.xmpp.
  approvalBypass` presente descarta la inmensa mayoría antes de cualquier
  trabajo por sesión.
- **[Ninguno] Riesgo de compatibilidad de protocolo.** El `<x type="result">`
  es aditivo; ningún cliente existente (propio o de terceros) se rompe por
  su presencia.
