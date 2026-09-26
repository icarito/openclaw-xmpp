# xmpp-client-hooks — Delta

## ADDED Requirements

### Requirement: Contrato documentado de ad-hoc commands
El plugin DEBE (MUST) mantener y documentar en `HOOKS.md` el contrato completo de
la superficie XEP-0050 para clientes externos: nodes públicos y ocultos
(`status`, `credit`, `context`, `compact`, `reset`, `new`, `model`,
`abort`, `elevated`, `cmd:*`, `q:*`), forms XEP-0004 de entrada y
`type="result"`, semántica de `expires-at-ms` para retirar cards vencidas,
y discovery (XEP-0030 + caps XEP-0115). El documento DEBE (MUST) incluir
ejemplos de stanzas de cada operación.

#### Scenario: Cliente ad-hoc descubre comandos
- **WHEN** un cliente XMPP estándar consulta disco#items sobre el JID del
  bot
- **THEN** obtiene la lista de nodes públicos y puede ejecutar cualquiera
  con las forms documentadas

#### Scenario: Card vencida en el historial del cliente
- **WHEN** un cliente renderiza una card con `expires-at-ms` vencido
- **THEN** puede retirarla localmente sin esperar la corrección del bot

### Requirement: Eventos estructurados vía PEP
El plugin DEBE (MUST) publicar eventos estructurados en nodos PEP versionados
(`urn:openclaw:hooks:activity:0`, `urn:openclaw:hooks:approval:0`,
`urn:openclaw:hooks:progress:0`) con payload JSON que incluya sessionKey,
estado, JID de origen y marca de tiempo, respetando el modelo de acceso
PEP del servidor y los mismos criterios de autorización `allowFrom` del
canal.

#### Scenario: Aprobación visible para cliente externo
- **WHEN** se crea una aprobación pendiente con redirect `approvalDmJid`
- **THEN** el evento PEP `approval` publica id, estado y expiración para
  los clientes suscritos que estén autorizados

#### Scenario: Cliente no autorizado
- **WHEN** un JID fuera de `allowFrom` intenta suscribirse a los nodos de
  hooks
- **THEN** el servidor aplica el access model de PEP y no recibe eventos

### Requirement: Telemetría legible
El read-side de telemetría DEBE (MUST) responder datos reales vía XEP-0050
(el node `credit` y el estado de conexión) en lugar del stub actual, y el
evento de actividad PEP DEBE (MUST) reflejar el estado de presencia del canal
(available/processing/busy/paused/pending).

#### Scenario: Consulta de consumo
- **WHEN** un cliente autorizado ejecuta el node `credit`
- **THEN** recibe el reporte de consumo real de la sesión y no el mensaje
  de "no session" del stub

### Requirement: Respuestas con reply estándar
El plugin DEBE (MUST) construir `<reply xmlns='urn:xmpp:reply:0'/>` con
`<fallback/>` (XEP-0428) en las respuestas durables que respondan a un
mensaje entrante, usando el id y el remitente del mensaje original.

#### Scenario: Respuesta citada en Conversations
- **WHEN** el agente responde a un mensaje de DM entrante
- **THEN** la respuesta lleva reply/fallback y el cliente muestra la cita
  del mensaje original

### Requirement: Reacciones estándar opt-in
El plugin DEBE (MUST) poder emitir reacciones XEP-0444 cuando `hooks.reactions`
esté habilitado, en DM siempre y en MUC solo rooms non-anonymous (misma
política de elegibilidad que OMEMO), y DEBE (MUST) ignorar reacciones entrantes
sin tratarlas como turnos.

#### Scenario: Reacción a confirmación
- **WHEN** el usuario aprueba una card y `hooks.reactions` está activo
- **THEN** el bot reacciona al mensaje de la card y no genera turno por la
  reacción entrante

#### Scenario: MUC semi-anónimo
- **WHEN** el room es semi-anónimo
- **THEN** no se emiten reacciones y queda registro de la elisión
