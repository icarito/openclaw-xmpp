# xmpp-delivery-reliability — Delta

## ADDED Requirements

### Requirement: Spool persistente de salientes no reconocidos
El plugin DEBE (MUST) persistir cada mensaje saliente no efímero keyeado por
su origin-id XEP-0359 (`<origin-id xmlns='urn:xmpp:sid:0' id='oc-*'/>`,
junto a destino, cuerpo/payload serializado y marcas de tiempo) en un spool
por cuenta bajo `$OPENCLAW_STATE_DIR/channel-cache/xmpp/`, y conservarlo
hasta que la entrega quede reconocida por XEP-0198 (`a`/`h`) o por receipt
XEP-0184 del destinatario. El spool DEBE (MUST) escribirse atómicamente
(tmp+rename) y DEBE (MUST) limitar su tamaño con política de expiración
configurable. Todo reenvío DEBE (MUST) conservar el mismo origin-id del
envío original.

#### Scenario: Proceso muere con mensajes en vuelo
- **WHEN** el proceso del plugin se detiene tras enviar mensajes que el
  servidor no llegó a reconocer, y arranca de nuevo
- **THEN** el spool recarga los salientes pendientes y los reenvía una vez
  al restablecerse la sesión, con el mismo origin-id, y cada reenvío queda
  registrado en logs

#### Scenario: Reenvío no duplica turnos
- **WHEN** un mensaje reenviado desde el spool llega al receptor que ya lo
  procesó
- **THEN** el receptor lo deduplica por stanza-id/origin-id y no genera un
  segundo turno

### Requirement: Manejo explícito de stream management
El plugin DEBE (MUST) suscribirse a los eventos de XEP-0198 (`resumed`, `failed`,
acks) y, al fallar el resume, DEBE (MUST) recuperar los salientes no reconocidos
desde el spool en el siguiente `online`. Las seeds `lastStreamIds` dejan de
ser el único mecanismo de resume y su ausencia no debe impedir el reenvío.

#### Scenario: Resume exitoso
- **WHEN** la conexión se recupera vía `resumed` con un contador `h` que
  cubre los salientes pendientes
- **THEN** el spool marca reconocidos los mensajes cubiertos y no los
  reenvía

#### Scenario: Resume fallido tras expiración del servidor
- **WHEN** el servidor responde `failed` al resume y la sesión reinicia
- **THEN** el plugin recupera los salientes no reconocidos desde el spool
  durante el catch-up de reconexión

### Requirement: Debounce de entrada
El plugin DEBE (MUST) fusionar las ráfagas de mensajes del mismo remitente dentro
de una ventana configurable (default 1.5 s) en un único turno, combinando
texto y adjuntos, sin romper el modo `steer` ni la detección de menciones
en MUC.

#### Scenario: Ráfaga de tres mensajes
- **WHEN** un remitente autorizado envía tres mensajes seguidos dentro de
  la ventana
- **THEN** el agente recibe un único turno con el contenido combinado y el
  orden original preservado

#### Scenario: Mensaje separado por encima de la ventana
- **WHEN** dos mensajes del mismo remitente distan más que la ventana
- **THEN** se despachan como turnos independientes

### Requirement: Dedupe durable de despacho
El plugin DEBE (MUST) mantener claims persistentes de despacho (por cuenta, JID y
stanza-id/origin-id) con TTL configurable (default 7 días) que impidan
re-ejecutar un turno ya procesado tras reinicio del proceso; un claim ya
comprometido ante un fallo posterior DEBE (MUST) clasificarse como no
re-reintentable en lugar de duplicar el turno.

#### Scenario: Replay de stanza tras reinicio
- **WHEN** el mismo stanza-id vuelve a llegar después de reiniciar el
  proceso dentro del TTL
- **THEN** se descarta con log y no produce un segundo turno

### Requirement: Burst breaker de salida
El plugin DEBE (MUST) limitar la tasa de envíos por destino (turnos y mensajes por
ventana, configurable vía `reliability.burstBreaker`) y al tripular DEBE (MUST)
pausar el envío, publicar actividad `paused` y reanudar después, sin
descartar jamás el turno final ni las aprobaciones pendientes.

#### Scenario: Cadena de fallos auto-sostenida
- **WHEN** una secuencia de turnos con fallo de entrega se repetiría cada
  pocos segundos hacia el mismo destino
- **THEN** el breaker pausa los envíos tras el umbral, el estado queda
  visible en el node `status` de XEP-0050 y no se acumulan más turnos

#### Scenario: Aprobaciones nunca bloqueadas por el breaker
- **WHEN** el breaker está activo y llega una card de aprobación
- **THEN** la card se envía igualmente (lane de control excluida del
  límite)

### Requirement: Receipts y markers estándar
El plugin DEBE (MUST) solicitar receipts XEP-0184 en los finales durables de DM y
MUC, DEBE (MUST) responder receipts recibidos, y DEBE emitir chat markers
XEP-0333 (`received`/`displayed`) hacia el remitente cuando el agente
procesa los mensajes, nunca para parciales efímeros.

#### Scenario: Cliente estándar confirma entrega
- **WHEN** Conversations recibe la respuesta final del agente
- **THEN** el mensaje incluye `<request xmlns='urn:xmpp:receipts'/>` y el
  plugin registra el `<received/>` de vuelta marcando el spool entregado

#### Scenario: Parciales efímeros sin receipts
- **WHEN** se envía una edición de progreso con hint `<no-store/>`
- **THEN** el mensaje no solicita receipt ni marker

### Requirement: Clasificación de fallos de entrega
El plugin DEBE (MUST) clasificar cada fallo de envío como reintentable o fatal,
aplicar backoff a los reintentables con tope, y tratar el
duplicate-commit como fatal (dead-letter en el spool), de modo que ningún
fallo de entrega pueda encadenar turnos automáticos ilimitados.

#### Scenario: Error reintentable
- **WHEN** un envío falla con un error de red transitorio
- **THEN** se reprograma con backoff exponencial acotado y registro en
  spool

#### Scenario: Error fatal
- **WHEN** el envío falla con un error no reintentable (p. ej. JID
  inválido)
- **THEN** el mensaje queda en dead-letter con registro y el turno se
  cierra con la notificación de error existente
