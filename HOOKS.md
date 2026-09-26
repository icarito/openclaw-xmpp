# HOOKS.md — contrato de la superficie XMPP para clientes ad-hoc

Este documento es el contrato **congelado** de la superficie que el plugin
`@openclaw/xmpp` expone a clientes XMPP externos (gtk-llm-chat,
gtk-llm-chat-android, Gajim, Dino, Cheogram, Conversations o cualquier
cliente ad-hoc). Todas las operaciones son XMPP estándar: comandos ad-hoc
XEP-0050, formularios XEP-0004, descubrimiento XEP-0030/XEP-0115, archivo
XEP-0313 (MAM), eventos PEP XEP-0163, acuses XEP-0184, marcadores XEP-0333,
respuestas XEP-0461 y reacciones XEP-0444.

El plugin **no** añade namespaces propietarios fuera de los nodos PEP
versionados `urn:openclaw:hooks:*:0`; el contrato de aprobaciones
(XEP-0004 `type="result"` + `expires-at-ms`) es el que ya consumen los
clientes GTK y no cambia.

## 1. Descubrimiento

### 1.1 Identidad y capabilities (XEP-0115)

El bot anuncia en su presencia:

```xml
<presence>
  <c xmlns='http://jabber.org/protocol/caps' hash='sha-1'
     node='https://github.com/openclaw/openclaw' ver='...'/>
</presence>
```

`ver` es el hash SHA-1 del verification string de la identidad
`automation/command-list/OpenClaw` más las features:

- `http://jabber.org/protocol/commands` (XEP-0050)
- `http://jabber.org/protocol/disco#info` (XEP-0030)
- `http://jabber.org/protocol/disco#items` (XEP-0030)
- `urn:openclaw:telemetry:0+notify` (telemetría PEP)

### 1.2 disco#info

```xml
<iq type='get' id='di1' to='bot@example.org'>
  <query xmlns='http://jabber.org/protocol/disco#info'/>
</iq>
```

Respuesta:

```xml
<iq type='result' id='di1' from='bot@example.org'>
  <query xmlns='http://jabber.org/protocol/disco#info'>
    <identity category='automation' type='command-list' name='OpenClaw'/>
    <feature var='http://jabber.org/protocol/commands'/>
    <feature var='http://jabber.org/protocol/disco#info'/>
    <feature var='http://jabber.org/protocol/disco#items'/>
  </query>
</iq>
```

### 1.3 disco#items (catálogo de nodes)

```xml
<iq type='get' id='ditems1' to='bot@example.org/resource'>
  <query xmlns='http://jabber.org/protocol/disco#items' node='http://jabber.org/protocol/commands'/>
</iq>
```

Respuesta:

```xml
<iq type='result' id='ditems1' from='bot@example.org/resource'>
  <query xmlns='http://jabber.org/protocol/disco#items' node='http://jabber.org/protocol/commands'>
    <item jid='bot@example.org/resource' node='status' name='OpenClaw: status'/>
    <item jid='bot@example.org/resource' node='credit' name='Crédito y consumo'/>
    <item jid='bot@example.org/resource' node='help' name='OpenClaw: help'/>
    <item jid='bot@example.org/resource' node='context' name='Session: context'/>
    <item jid='bot@example.org/resource' node='compact' name='Session: compact'/>
    <item jid='bot@example.org/resource' node='reset' name='Session: reset'/>
    <item jid='bot@example.org/resource' node='new' name='Session: new'/>
    <item jid='bot@example.org/resource' node='model' name='Session: model'/>
    <item jid='bot@example.org/resource' node='abort' name='Session: abort'/>
    <item jid='bot@example.org/resource' node='elevated' name='Elevated: temporary session bypass'/>
  </query>
</iq>
```

`cmd:*` y `q:*` son **nodes transitorios** creados al emitir una tarjeta o
una pregunta; no aparecen en disco#items y se resuelven por IQ directo (ver
§5 y §6).

## 2. XEP-0050: ejecutar un comando

Todo node se ejecuta con `action='execute'`; si tiene parámetros, el bot
responde `status='executing'` con un formulario XEP-0004 `type='form'`, y el
cliente lo devuelve como `type='submit'` con el mismo `sessionid`.

```xml
<iq type='set' id='c1' to='bot@example.org/resource'>
  <command xmlns='http://jabber.org/protocol/commands'
           node='status' action='execute'/>
</iq>
```

```xml
<iq type='result' id='c1' from='bot@example.org/resource'>
  <command xmlns='http://jabber.org/protocol/commands'
           node='status' status='completed' sessionid='oc-cmd-...'>
    <note type='info'>Connected as bot@example.org (accountId=bot, activity=available).
Server features: server MAM v2 yes.</note>
  </command>
</iq>
```

### 2.1 Nodes públicos

| node | parámetros | mutating | descripción |
|---|---|---|---|
| `status` | — | no | Estado real de conexión, actividad y preflight de features del servidor. |
| `credit` | — | no | Consumo real de la sesión (memoria activa, tokens, coste de sesión y del día). |
| `help` | — | no | Ayuda breve; el catálogo real es disco#items. |
| `context` | `arg` (text-single, opcional) | no | Reporta el contexto de la sesión. |
| `compact` | `arg` (text-single, opcional) | sí | Compacta el contexto (instrucciones opcionales). |
| `reset` | — | sí | Reinicia el contexto de la sesión. |
| `new` | — | sí | Abre una sesión nueva. |
| `model` | `arg` (text-single, opcional) | sí | Muestra/cambia el modelo. |
| `abort` | — | sí | Cancela el turno activo. |
| `elevated` | `mode` (list-single, requerido), `minutes` (text-single, opcional) | sí | Bypass temporal solo-sesión. |

`context`/`compact`/`reset`/`new`/`model` se resuelven contra el registro
nativo de comandos de OpenClaw: el resultado puede tardar (turno de agente),
así que el IQ se acusa inmediatamente con `status='completed'` y la respuesta
real llega como mensaje de chat normal.

### 2.2 `elevated` (formulario de entrada)

```xml
<iq type='result' id='e1' from='bot@example.org/resource'>
  <command xmlns='http://jabber.org/protocol/commands'
           node='elevated' status='executing' sessionid='oc-cmd-...'>
    <x xmlns='jabber:x:data' type='form'>
      <title>Elevated: temporary session bypass</title>
      <field var='mode' type='list-single' label='Modo'>
        <value>status</value>
        <option label='on'><value>on</value></option>
        <option label='off'><value>off</value></option>
        <option label='status'><value>status</value></option>
      </field>
      <field var='minutes' type='text-single' label='Minutos'>
        <value>10</value>
      </field>
    </x>
  </command>
</iq>
```

Submit:

```xml
<iq type='set' id='e2' to='bot@example.org/resource'>
  <command xmlns='http://jabber.org/protocol/commands'
           node='elevated' sessionid='oc-cmd-...' action='submit'>
    <x xmlns='jabber:x:data' type='submit'>
      <field var='mode'><value>on</value></field>
      <field var='minutes'><value>10</value></field>
    </x>
  </command>
</iq>
```

### 2.3 XEP-0004 `type='result'` (resultado estructurado)

Como hijo adicional de `<command status='completed'>`, el bot puede adjuntar
un formulario `type='result'` con var/value, junto al `<note>` legible. Los
clientes deben preferir el formulario y no parsear el texto.

`elevated status` devuelve, por ejemplo:

```xml
<x xmlns='jabber:x:data' type='result'>
  <field var='active'><value>true</value></field>
  <field var='scope'><value>session</value></field>
  <field var='mode'><value>on</value></field>
  <field var='expires-at-ms'><value>1758900000000</value></field>
  <field var='remaining-seconds'><value>540</value></field>
</x>
```

## 3. `expires-at-ms`

Las superficies accionables pueden caducar. El cliente debe retirar
localmente cualquier acción/card cuyo `expires-at-ms` (epoch en milisegundos)
ya haya vencido, **sin esperar** a la corrección del bot:

- En las tarjetas de aprobación (XEP-0439 quick responses) viaja en cada
  `<response ... expires-at-ms='...'/>`.
- En los botones XEP-0050 viaja en cada `<item ... expires-at-ms='...'/>`.

```xml
<message type='chat' to='operator@example.org' id='oc-...'>
  <body>🔒 rm -rf /tmp/x
Responde: /approve deadbeef allow-once | allow-always | deny</body>
  <response xmlns='urn:xmpp:tmp:quick-response'
            value='/approve deadbeef allow-once' label='Allow Once'
            style='success' expires-at-ms='1758900000000'/>
  <query xmlns='http://jabber.org/protocol/disco#items'
         node='http://jabber.org/protocol/commands'>
    <item jid='bot@example.org/openclaw' node='cmd:oc-...:0'
          name='Allow Once' style='success' expires-at-ms='1758900000000'/>
  </query>
</message>
```

El contrato de aprobaciones (XEP-0004 `type='result'` + `expires-at-ms`) es
el que consumen gtk-llm-chat y gtk-llm-chat-android y **no cambia**.

## 4. Historial con XEP-0313 (MAM)

Para leer historial, un cliente autorizado consulta el archivo del servidor
con un `IQ-set` que incluye un formulario XEP-0004 y paginación RSM
(XEP-0059). El plugin usa exactamente esta forma para el catch-up; el
cliente puede replicarla con `with` para limitar a un peer.

```xml
<iq type='set' id='mam1' to='bot@example.org'>
  <query xmlns='urn:xmpp:mam:2' queryid='q1'>
    <x xmlns='jabber:x:data' type='submit'>
      <field var='FORM_TYPE' type='hidden'><value>urn:xmpp:mam:2</value></field>
      <field var='with'><value>peer@example.org</value></field>
    </x>
    <set xmlns='http://jabber.org/protocol/rsm'>
      <max>50</max>
    </set>
  </query>
</iq>
```

Los resultados llegan como `<message><result xmlns='urn:xmpp:mam:2'
queryid='q1' id='ARCHIVE-ID'><forwarded>...</forwarded></result></message>`
y terminan con `<fin complete='true'><set>...</set></fin>`. El `id` del
`<result>` (o el `<stanza-id by=... id=.../>` del mensaje archivado, XEP-0359)
es el ancla estable para paginar con `<after>ARCHIVE-ID</after>`.

Notas de observación del plugin:

- El plugin mantiene un **watermark** persistente por cuenta y por peer; los
  replays no vistos desde el último ack no se convierten en turnos (modo
  observacional por defecto). Un cliente que sólo lee el archivo no altera
  ese watermark.
- Si el ancla fue purgada por retención, la consulta degrada a *fetch-latest*
  (`<before/>` vacío) en lugar de fallar.
- La retención del servidor manda: por defecto Prosody borra a la semana
  (`archive_expires_after = "1w"`). Ver OPERATIONS.md.

## 5. Node `cmd:*` (botones de tarjetas / aprobaciones)

Cada botón de una tarjeta se registra como un node transitorio
`cmd:<stanzaId>:<index>` durante 15 minutos. El cliente lo ejecuta por IQ:

```xml
<iq type='set' id='b1' to='bot@example.org/resource'>
  <command xmlns='http://jabber.org/protocol/commands'
           node='cmd:oc-abc:0' action='execute'/>
</iq>
```

```xml
<iq type='result' id='b1' from='bot@example.org/resource'>
  <command xmlns='http://jabber.org/protocol/commands'
           node='cmd:oc-abc:0' status='completed' sessionid='oc-cmd-...'>
    <note type='info'>Command submitted.</note>
  </command>
</iq>
```

Si el node expiró, el `<note>` es `type='warn'` con `Command expired.`.
Las aprobaciones resueltas se retiran con XEP-0308 (corrección del mensaje
de la card), así que el cliente debe borrar los botones al recibir la
corrección.

## 6. Node `q:*` (preguntas interactivas)

`ask_question` renderiza opciones como nodes `q:<questionId>:<index>`. Se
ejecutan igual que `cmd:*`:

```xml
<iq type='set' id='q1' to='bot@example.org/resource'>
  <command xmlns='http://jabber.org/protocol/commands'
           node='q:abc123:1' action='execute'/>
</iq>
```

## 7. Eventos PEP (XEP-0163)

El plugin publica eventos estructurados en nodos PEP **versionados**. El
payload es un documento JSON que es el **texto** del elemento `<event>` cuyo
namespace es el propio nodo; `version` viaja además como atributo.

| node | evento | contenido |
|---|---|---|
| `urn:openclaw:hooks:activity:0` | actividad del canal | `state` ∈ `available`/`processing`/`busy`/`paused`/`pending` |
| `urn:openclaw:hooks:approval:0` | ciclo de aprobaciones | `state` ∈ `pending`/`resolved`/`expired`/`canceled`, `approvalId`, `expiresAtMs` |
| `urn:openclaw:hooks:progress:0` | progreso de turno | `state` ∈ `start`/`end` |

Campos comunes del JSON: `contractVersion` (1), `event`, `state`,
`sessionKey`, `originJid`, `target`, `timestamp` (ISO-8601). Campos propios:
`pendingCount` (activity), `approvalId`/`stanzaId`/`jid`/`expiresAtMs`/
`decision` (approval), `detail` (progress).

### 7.1 Suscripción

```xml
<iq type='set' id='sub1' to='bot@example.org'>
  <pubsub xmlns='http://jabber.org/protocol/pubsub'>
    <subscribe node='urn:openclaw:hooks:activity:0' jid='operator@example.org'/>
  </pubsub>
</iq>
```

### 7.2 Notificación

Cuando algo cambia, el servidor entrega a los suscriptores:

```xml
<message type='headline' from='bot@example.org'>
  <event xmlns='http://jabber.org/protocol/pubsub#event'>
    <items node='urn:openclaw:hooks:activity:0'>
      <item id='oc-hook-activity-...'>
        <event xmlns='urn:openclaw:hooks:activity:0' version='1'>{
  "contractVersion": 1,
  "event": "activity",
  "state": "busy",
  "sessionKey": "agent:clawdio:xmpp:peer@example.org",
  "originJid": "peer@example.org",
  "target": "peer@example.org",
  "timestamp": "2026-09-26T12:00:00.000Z"
}</event>
      </item>
    </items>
  </event>
</message>
```

Aprobación pendiente:

```xml
<items node='urn:openclaw:hooks:approval:0'>
  <item id='oc-hook-approval-...'>
    <event xmlns='urn:openclaw:hooks:approval:0' version='1'>{
  "contractVersion": 1,
  "event": "approval",
  "state": "pending",
  "approvalId": "3f2a...",
  "stanzaId": "oc-abc",
  "jid": "operator@example.org",
  "sessionKey": "agent:clawdio:xmpp:room@conference.example.org",
  "expiresAtMs": 1758900000000,
  "timestamp": "2026-09-26T12:00:00.000Z"
}</event>
      </item>
    </items>
```

Progreso de turno:

```xml
<items node='urn:openclaw:hooks:progress:0'>
  <item id='oc-hook-progress-...'>
    <event xmlns='urn:openclaw:hooks:progress:0' version='1'>{
  "contractVersion": 1,
  "event": "progress",
  "state": "start",
  "sessionKey": "agent:clawdio:xmpp:peer@example.org",
  "target": "peer@example.org",
  "timestamp": "2026-09-26T12:00:00.000Z"
}</event>
      </item>
    </items>
```

### 7.3 Modelo de acceso

PEP es PubSub user-centric: el **servidor** aplica el modelo de acceso del
nodo; el plugin no puede filtrar suscriptores. Los tres nodos se publican con
`pubsub#access_model=presence`, de modo que sólo los contactos con los que el
bot tiene presencia mutua (los JIDs autorizados del canal son contactos de su
roster) reciben eventos. Para un límite más estricto, el operador debe
configurar el nodo en modo `whitelist` en el servidor. El plugin aplica los
mismos criterios de autorización que el canal antes de emitir (p. ej. las
aprobaciones sólo se emiten si la cuenta XMPP está configurada con
`allowFrom`).

Los nodos son de eventos (no persistidos): un cliente que llega tarde puede
consultar el estado actual con `disco#info`/`status`, pero no debe asumir que
encontrará el último item archivado.

## 8. Acuses y marcadores

- **XEP-0184**: los finales durables llevan `<request xmlns='urn:xmpp:receipts'/>`.
  El bot responde a los `<request/>` entrantes con `<received id='...'/>`.
  Un cliente que quiera acuse de sus propios mensajes debe incluir
  `<request/>` en su stanza.
- **XEP-0333**: al procesar un mensaje entrante, el bot emite un marcador
  `<displayed xmlns='urn:xmpp:chat-markers:0' id='...'/>`. Los parciales
  efímeros (`<no-store/>`) nunca piden receipt ni generan marcador.

```xml
<message type='chat' to='peer@example.org' id='oc-1'>
  <body>respuesta final</body>
  <origin-id xmlns='urn:xmpp:sid:0' id='oc-1'/>
  <request xmlns='urn:xmpp:receipts'/>
</message>
```

## 9. Respuestas XEP-0461 y reacciones XEP-0444

### 9.1 Respuestas citadas

Las respuestas durables que responden a un mensaje entrante llevan
`<reply/>` (XEP-0461) con el `id` y el remitente (`to`) originales, más un
`<fallback/>` (XEP-0428) con el texto citado para clientes que no renderizan
la cita:

```xml
<message type='chat' to='peer@example.org' id='oc-2'>
  <body>Claro, lo reviso.</body>
  <reply xmlns='urn:xmpp:reply:0' id='inbound-1' to='peer@example.org/resource'/>
  <fallback xmlns='urn:xmpp:fallback:0' for='urn:xmpp:reply:0'>
    <body>¿Puedes revisar esto?</body>
  </fallback>
</message>
```

### 9.2 Reacciones (opt-in)

Con `hooks.reactions: true` el bot puede reaccionar a un mensaje (p. ej. la
card que el usuario acaba de aprobar):

```xml
<message type='chat' to='operator@example.org'>
  <reactions xmlns='urn:xmpp:reactions:0' id='oc-card-1'>
    <reaction>✅</reaction>
  </reactions>
</message>
```

Elegibilidad: en DM siempre; en MUC sólo rooms **non-anonymous** (misma
política que OMEMO). En rooms semi-anónimos o anónimos la reacción se elide
y queda registro en logs. Las reacciones **entrantes se ignoran**: nunca
generan un turno del agente.

## 10. Presencia y telemetría

- Presencia dirigida al peer con `show`/`status` refleja el estado real
  (`available`/`away`/`dnd`).
- El node `status` (XEP-0050) reporta conexión real, actividad viva y el
  resultado del preflight de features del servidor.
- La telemetría PEP `urn:openclaw:telemetry:0` lleva contexto/tokens/coste
  reales de la sesión; el node `credit` los resume en texto.
