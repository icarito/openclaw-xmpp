# xmpp-first-class-channel — Design

## Context

Estado actual verificado (HEAD `820213a`, v2026.7.4-4):

- **Historial**: sin XEP-0313 (cero referencias funcionales); stanzas
  retrasadas (XEP-0203) se descartan a ciegas si tienen >5 min
  (`src/protocol.ts:38-44`); el join de MUC no pide historial
  (`src/client.ts:117-140`), así que depende del server-default; el resume
  de XEP-0198 se apoya en seeds en memoria (`lastStreamIds`) que mueren con
  el proceso; no hay spool de salientes.
- **Acuses**: receipts XEP-0184 se ignoran y nunca se piden; sin XEP-0333;
  XEP-0461 solo inbound; sin `<reply/>` saliente.
- **Aprobaciones**: cards XEP-0050 (`cmd:*`) + textual fallback + elevated
  session (fase 2 del programa de paridad, desplegada 2026-07-25); estado de
  pendientes vive en el core; los mapas del plugin son en memoria, así que un
  reinicio deja cards huerfanas que solo expiran por timeout.
- **Anti-fuga**: dedupe de entrada persistente (ventana 10 min),
  self-reflection MUC, carbons `<sent/>` ignorados; **sin** burst breaker de
  salida, sin debounce de entrada, sin spool durable de entrada. La auditoría
  `AUDITORIA-TOKENS-2026-07-18.md` documenta cadenas de reintento
  auto-sostenidas (~5 s por turno) como causa directa del burn.
- **Superficie de hooks**: XEP-0050/XEP-0004 completos y en producción,
  caps XEP-0115, PEP publish (apodo/mood), botones bajo namespace temporal
  `urn:xmpp:tmp:quick-response`; telemetría publicada pero **read-side
  stub**; nada de esto está documentado como contrato para clientes externos.

### Investigación de alternativas (recomendación: NO migrar)

Se evaluó el ecosistema (búsqueda web, 2026-09-26; sin acceso directo a
Perplexity en esta sesión, se usó búsqueda web equivalente):

| Alternativa | Hallazgo | Veredicto |
|---|---|---|
| Upstream OpenClaw | No hay canal XMPP: PRs #9741, #21015, #20998 rechazados/abandonados; los mantainers derivan los plugins XMPP a repos de terceros (issue #29046) | No hay adónde migrar dentro del árbol upstream |
| `toughworm/Openclaw-XMPP-Plugin` | OMEMO legacy + XEP-0184 receipts; sin aprobaciones, sin ad-hoc commands, sin streaming | Detrás en todo lo que define a este plugin |
| `elmafioso79/xmpp-channel` | Modular; XEP-0333 markers, XEP-0444 reactions, XEP-0461 replies, XEP-0198 "ack/resume"; sin cards, sin elevated, sin MAM | Fuente de patrones client-compat, no reemplazo |
| `weijia/xmpp-connector` | Connector mínimo user/pass | Irrelevante |
| Stack Python (slixmpp) | XEPs incluidos (0313, 0184, 0198, 0333) pero obligaría a reescribir ~50 módulos TS, el sidecar OMEMO v2, los módulos Prosody y el pipeline de deploy (`xmpp-parity-deployment`) | Costo altísimo, ganancia cero en features |
| xmpp.js `@xmpp/client` 0.14 | SM incluido; resumption con semánticas delicadas (issues #822, #1003); MAM no incluido (implementable: IQ + XEP-0004 + XEP-0059, ambos ya implementados en el plugin) | Quedarse; manejar resume explícitamente |
| fluux-messenger (processone) | Patrón moderno de catch-up MAM: cursores archive-id, manejo de gaps, degradación a fetch-latest, modificaciones resueltas cross-página | Adoptar el patrón para `src/mam.ts` |

**Recomendación honesta**: no hay migración que compense. Ningún competidor
implementa cards de aprobación, elevated session, streaming de progreso,
OMEMO dual o el contrato con gtk-llm-chat que ya están verificados en
producción. Las brechas reales (MAM, receipts, spool, burst breaker) son
aditivas. El riesgo está en xmpp.js-resumption, y se mitiga implementando
los acks a mano sobre la librería, no migrando de librería.

## Goals / Non-Goals

**Goals:**

- Cero pérdida de mensajes ante reconexión de stream o reinicio del plugin,
  dentro de la retención del archivo del servidor.
- Paridad con Telegram en las capas de recovery: spool durable, dedupe
  persistente con TTL, debounce, reintento con backoff y dead-letter.
- Freno estructural de fuga de tokens: ninguna cadena de turnos puede
  auto-sostenerse por fallos de entrega repetidos.
- Superficie de hooks 100 % estándar XMPP, documentada (`HOOKS.md`), usable
  desde gtk-llm-chat, gtk-llm-chat-android y cualquier cliente ad-hoc.
- Fail-closed: si el servidor no soporta MAM/receipts, el comportamiento
  actual queda como fallback sin regresiones.

**Non-Goals:**

- No se reemplaza el archivo del servidor por un store local de mensajes
  (Prosody `mod_mam` es la fuente de verdad; Telegram cachea porque su API
  no tiene archivo consultable — XMPP sí).
- No se implementa XEP-0384 para el catch-up de MAM cifrado por encima de lo
  ya soportado (el decrypt de stanzas OMEMO reutilizadas del archivo se
  limita a lo que el pipeline actual ya sabe descifrar).
- No se cambia el contrato de aprobaciones (XEP-0004 `type="result"`,
  `expires-at-ms`); los clientes GTK no requieren cambios obligatorios.
- No se toca producción desde este change (deploy es fase posterior
  coordinada desde claudio-w, como `xmpp-parity-deployment`).
- No se implementa XEP-0048/0402 bookmarks, MIX (XEP-0369) ni trust
  management OMEMO.

## Decisions

### D1. Quedarse en xmpp.js; acks XEP-0198 gestionados a mano

`@xmpp/client` 0.14 expone SM pero su resume es opaco (discussion #1003) y
no expone spool de salientes. Se completa a nivel plugin:

- Suscribirse a los eventos de stream-management (`resumed`, `failed`,
  acks `r`/`a`) y al estado `online`/`offline`.
- Nuevo módulo `src/outbound-spool.ts`: cola persistente en
  `$OPENCLAW_STATE_DIR/channel-cache/xmpp/<accountId>-outbound-spool.json`
  (mismo patrón atómico tmp+rename que el dedupe de entrada) que guarda cada
  mensaje saliente no efímero keyeado por su **origin-id XEP-0359**
  (`<origin-id xmlns='urn:xmpp:sid:0' id='oc-*'/>`), hasta ack (XEP-0198
  `a`) o receipt XEP-0184. Tras `<resumed>` SOLO se marca lo cubierto por el
  contador `h` del servidor (nunca replay ciego); tras `<failed>`, sesión
  nueva o reinicio de proceso, se reenvía lo pendiente con el **mismo
  origin-id** (la dedupe del receptor es idempotente por ese id), con
  backoff y tope. Investigación Perplexity 2026-09-26 (XEP-0198 §Resumption,
  XEP-0359, xmpp.js releases): el SM-ID es opaco y de vida corta, no sirve
  como clave de spool; el origin-id sí es estable entre reintentos.
- Las seeds `lastStreamIds` se mantienen pero dejan de ser mecanismo único.
- *Alternativa descartada*: migrar a slixmpp/stanza.io (reescribe todo,
  ver tabla de investigación) o parchear xmpp.js upstream (mantenimiento
  de fork sin retorno).

### D2. MAM como única fuente de historial, patrón fluux

`src/mam.ts` implementa la parte cliente de XEP-0313: query IQ-set con form
(XEP-0004), paginación RSM (XEP-0059) **obligatoria** (Prosody default
`max_archive_query_results = 50`), dedupe por `stanza-id` XEP-0359 en su
clave compuesta `(by, id)` (el id está scopeado al JID que lo asigna) más
`origin-id` del remitente, catch-up hacia adelante desde el último
archive-id visto (persistido por cuenta+peer), degradación a fetch-latest si
el anclaje no existe en el archivo (patrón `mam-anchor-purged` de fluux).
Ventana de catch-up acotada por la retención real del servidor: Prosody
borra por defecto a **1 semana** (`archive_expires_after = "1w"`,
`muc_log_expires_after = "1w"`), así que el default del plugin no puede
pretender recuperar más de eso (ver Open Questions). Aplicaciones:

- **Reconexión**: tras `online` (o `resumed` fallido), consultar MAM desde
  el último id visto; los resultados alimentan el contexto de sesión como
  *observaciones* (nunca turnos), salvo opt-in config.
- **MUC**: el join deja de confiar en el historial por defecto; se pide
  `maxstanzas=0` (control explícito) y el catch-up va por MAM del room.
- **Guard de delay**: el corte de 5 min se sustituye por "procesar solo lo
  posterior al watermark de catch-up"; el guard actual queda como último
  recurso si MAM no está disponible.
- *Alternativa descartada*: caché local estilo Telegram (`telegram.message-cache`)
  — duplicaría el archivo del servidor y su consistencia; los reply-chains
  del contexto de turno se resuelven con MAM puntual cuando hagan falta.

### D3. Anti-fuga en tres capas + clasificación de fallos

1. **Debounce de entrada** (estilo `bot-handlers.inbound-debounce`):
   ráfagas del mismo JID dentro de una ventana config (default 1.5 s) se
   fusionan en un turno sintético, respetando `steer`.
2. **Dedupe durable de despacho**: claims persistentes
   `xmpp.message-dispatch-dedupe` con TTL 7 días (paridad con Telegram);
   replay tras reinicio no re-ejecuta turnos.
3. **Burst breaker de salida**: límite de envíos por destino y ventana
   (config `reliability.burstBreaker`); al tripular, pausa el envío y
   publica actividad "paused" existente; nunca descarta el turno final.
4. **Clasificación de fallos de entrega**: errores de envío se clasifican
   (retryable / fatal / duplicate-commit) y el turno fallido **no** se
   re-encola en cadena; el estado queda visible en `status` (XEP-0050 node
   `status`) y en PEP activity. Esto complementa el burst breaker del core
   (patch 6 de la auditoría) sin duplicarlo.
- *Alternativa descartada*: resolverlo solo en core/openclaw.json — los
  incidentes demostraron que el canal necesita autocuidado propio.

### D4. Hooks: contrato estándar + PEP para eventos push

- `HOOKS.md` documenta la superficie congelada: nodes XEP-0050 (`status`,
  `credit`, `context`, `compact`, `reset`, `new`, `model`, `abort`,
  `elevated`, `cmd:*`, `q:*`), forms XEP-0004, `expires-at-ms`, caps
  XEP-0115, y el uso de MAM para leer historial.
- Nuevo `src/hooks/pep-events.ts`: publica nodos PEP versionados
  (`urn:openclaw:hooks:activity:0`, `...:approval:0`, `...:progress:0`)
  con payloads JSON estructurados (openclaw sessionKey, estado, jids);
  acceso restringido por allowFrom (PEP access model del servidor).
- Read-side de telemetría: se completa como consulta XEP-0050 (`credit`
  ya lo hace) en vez del stub SQLite.
- XEP-0461 saliente (`<reply/>` + fallback XEP-0428 ya implementado) y
  XEP-0444 (reacciones en respuestas a comandos/decisions, opt-in config,
  DM siempre, MUC solo non-anonymous como OMEMO).
- *Alternativa descartada*: canal de eventos ad-hoc sobre el namespace
  temporal de botones — no estándar y ya marcado como experimental.

### D5. Reconciliación local de cards huérfanas

Se persiste el registro de cards activas (stanza-id, sessionKey, expiry,
JID destino) en plugin state; al arrancar, cada card cuya vida tocó el
reinicio se cierra con XEP-0308 "expirada/reconciliada" y se libera su
`sessionKey`. No depende de endpoints del core (la petición upstream de
enumerar pendientes del core queda como pedido, no como bloqueo).
- *Alternativa descartada*: dejarlo solo a expiración (estado actual:
  cards zombis editables por nadie durante 15 min).

### D6. Feature-flags por fase y degradación por disco

`config-schema.ts` gana `reliability`, `history`, `hooks`; cada capa
preflight por disco (disco#info `urn:xmpp:mam:2` en cuenta y MUC domain,
XEP-0184/0333 awareness de los pares) y degrada con aviso en `status`
cuando el servidor no soporta la feature. Defaults conservadores:
catch-up observacional (no crea turnos), receipts solo en finales durables.

## Risks / Trade-offs

- [Prosody sin `mod_mam` o con retención corta] → preflight disco +
  degradación al guard actual; OPERATIONS.md documenta habilitarlo;
  `history.mam` permite desactivar.
- [Catch-up masivo tras horas offline] → watermark por cuenta + tope
  RSM por página y por query; replay entra como contexto, no turnos;
  ventana máxima config.
- [MUC OMEMO + MAM: mensajes archivados cifrados] → catch-up MUC aplica
  solo a rooms non-anonymous con OMEMO-capable occupants (misma política
  que el envío); si el decrypt falla, el mensaje se contabiliza como visto
  sin materializar contenido.
- [Burst breaker dispara en falso con varios usuarios legítimos] → límites
  por destino con ventana corta, configurable, visible en `status`, y el
  turno final nunca se descarta.
- [Receipts/markers incrementan ruido de stanzas] → solo finales durables,
  nunca parciales efímeros (hints XEP-0334 se mantienen); batching de acks.
- [Reenvío de salientes tras resume duplica mensajes] → dedupe receptor
  existente (stanza-id + id propio `oc-*`) + XEP-0359 en el remitente;
  reenvío marcado con `<no-store/>`... no: reenvíos son durables y dedupe
  por `origin-id`/`id` del receptor cubre el resto.
- [Alcance grande] → fases A/B/C independientes y verificables; cada una
  puede delegarse por separado (ver Migration Plan).

## Migration Plan

1. **Fase A (reliability)**: spool, debounce, burst breaker, receipts,
   markers — feature-flag `reliability`, default on salvo spool-reenvío
   (opt-in primera semana).
2. **Fase B (history)**: `src/mam.ts`, watermark, guard nuevo —
   feature-flag `history.catchup` default observacional; matrix E2E
   ampliada del programa de paridad (ack, progress, completion, cancel,
   stale approval) + casos nuevos (kill del proceso con salientes
   pendientes, reconexión larga offline, MUC con replay).
3. **Fase C (hooks)**: PEP events, HOOKS.md, replies/reactions — sin
   flag (aditivo), verificación con gtk-llm-chat en worktree.
4. Deploy por la vía ya verificada de `xmpp-parity-deployment` (tag +
   checkout en `/opt/claudio-w/repos/openclaw-xmpp`), desde sesión
   primaria; rollback = tag anterior (cada fase es un tag).
5. Registro de versiones: `EXPECTED_OPENCLAW_VERSION`/patches no cambian;
  el plugin no toca el bundle core.

## Open Questions

- Retención de `mod_mam` en el Prosody de producción: el default de
  Prosody es 1 semana (`archive_expires_after = "1w"`); si la producción
  usa defaults, la ventana útil de catch-up es ≤ 7 días. Verificar
  `archive_expires_after`/`muc_log_expires_after` con `prosodyctl shell`
  en deploy y ajustar la ventana default del plugin a la retención real.
- ¿Los clientes GTK quieren consumir los PEP events en esta iteración o
  solo los nodes XEP-0050 existentes? (coordinar en ROADMAP; el contrato
  PEP es versionado para no bloquearlos).
- ¿Reacciones XEP-0444 también entrantes como input de control (p. ej.
  reaccionar ✅ a una card)? Se deja fuera salvo decisión en apply.
