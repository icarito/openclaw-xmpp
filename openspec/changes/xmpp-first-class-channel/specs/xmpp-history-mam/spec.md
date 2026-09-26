# xmpp-history-mam — Delta

## ADDED Requirements

### Requirement: Consulta MAM para recuperación de historial
El plugin DEBE (MUST) implementar la parte cliente de XEP-0313 sobre el
archivo del servidor (IQ-set con form XEP-0004 y paginación RSM XEP-0059
obligatoria — Prosody default `max_archive_query_results = 50`), para
conversaciones 1:1 (archivo del bare JID) y MUC (archivo del room),
consultando solo si el preflight disco#info reporta soporte
`urn:xmpp:mam:2`, y acotando la ventana de catch-up a la retención del
servidor (default de Prosody: 1 semana).

#### Scenario: Servidor con MAM
- **WHEN** la cuenta y el MUC domain anuncian `urn:xmpp:mam:2` en
  disco#info
- **THEN** las queries de catch-up se emiten y los resultados se integran
  al contexto de sesión

#### Scenario: Servidor sin MAM
- **WHEN** el disco no reporta MAM
- **THEN** el catch-up queda desactivado con aviso en el node `status` y
  el comportamiento actual (guard de delay + dedupe) se mantiene

### Requirement: Watermark por cuenta y dedupe por archive-id
El plugin DEBE (MUST) persistir por cuenta el último archive-id visto
(XEP-0359 `stanza-id`, en su clave compuesta `(by, id)` porque el id está
scopeado al JID que lo asigna) como watermark, y DEBE (MUST) descartar
cualquier mensaje cuyo archive-id sea ≤ watermark o ya procesado (en vivo,
en catch-up, en carbons y en replay de join history), incluyendo el
fallback al origin-id del remitente cuando no haya stanza-id.

#### Scenario: Reconexión sin gaps
- **WHEN** el plugin se reconecta y el watermark coincide con el último
  mensaje del archivo
- **THEN** no se emite query de catch-up ni se duplican mensajes

#### Scenario: Mensajes del período offline
- **WHEN** el plugin estuvo desconectado y el archivo contiene mensajes
  posteriores al watermark
- **THEN** los mensajes nuevos se recuperan en orden, se registran como
  contexto y cada uno actualiza el watermark

### Requirement: Catch-up observacional fail-closed
El catch-up DEBE (MUST) tratar el historial recuperado como contexto de
conversación (nunca como turnos nuevos del modelo) salvo opt-in explícito
de configuración (`history.catchup.spawnTurns`), y DEBE (MUST) acotar cada query
con límite de páginas y ventana máxima configurables; si el anclaje del
watermark ya no existe en el archivo, DEBE (MUST) degradar a fetch-latest en vez
de fallar.

#### Scenario: Vueltas largas offline
- **WHEN** el bot estuvo horas desconectado y el catch-up recupera cientos
  de mensajes
- **THEN** ninguno genera turnos, el contexto queda disponible y el consumo
  de tokens se acota a la ventana configurada

#### Scenario: Anclaje purgado
- **WHEN** el watermark apunta a un archive-id que el servidor ya purgó
- **THEN** la query se degrada a fetch-latest, se registra el degrade y no
  se reintenta eternamente sobre el anclaje muerto

### Requirement: Control de historial MUC
El plugin DEBE (MUST) entrar a los MUC con historial explícito (`maxstanzas=0` o
valor config) y obtener el historial del room vía MAM, evitando el replay
de historial del servidor como fuente de turnos o duplicados.

#### Scenario: Join a room con historial acumulado
- **WHEN** el plugin se une a un room con miles de mensajes archivados
- **THEN** no procesa el replay del servidor y el catch-up MUC respeta el
  watermark del room

### Requirement: Integración con guard de stanzas retrasadas
Cuando MAM esté disponible, el guard de XEP-0203 DEBE (MUST) aplicarse solo como
red de seguridad (stanzas retrasadas ya cubiertas por el watermark se
descartan por dedupe, no por edad); sin MAM, el guard actual de 5 minutos
permanece inalterado.

#### Scenario: Delayed stanza del período offline con MAM activo
- **WHEN** llega una stanza con `<delay/>` cuyo archive-id ya cubrió el
  catch-up
- **THEN** se descarta por dedupe de archive-id y el log lo marca como
  replay

#### Scenario: Sin MAM, comportamiento actual
- **WHEN** MAM no está disponible y llega una stanza retrasada de más de
  5 minutos
- **THEN** se descarta por el guard existente (regresión cero)
