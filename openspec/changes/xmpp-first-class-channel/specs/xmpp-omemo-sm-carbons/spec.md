# xmpp-omemo-sm-carbons — Delta

Nota: este spec heredado no usa bloques `### Requirement:`; los requisitos
siguiente son ADDED y **sustituyen** la suposición del Feature 2
("el soporte de @xmpp/client para XEP-0198 es suficiente... solo hay que
suscribirse a los eventos correctos") y la sección 2.1/2.2 del spec
principal, que quedan absorbidas por el manejo explícito de acks/resume y
el spool de salientes definido aquí y en `xmpp-delivery-reliability`.

## ADDED Requirements

### Requirement: Acks y resume de XEP-0198 gestionados por el plugin
El plugin DEBE (MUST) manejar explícitamente `resumed`, `failed` y los
reconocimientos de XEP-0198, y DEBE (MUST) mantener el spool de salientes no
reconocidos (capability `xmpp-delivery-reliability`) como fuente de
reenvío; las seeds en memoria `lastStreamIds`/`lastInboundCounts`
permanecen como optimización del resume supervisado, pero el sistema DEBE (MUST)
funcionar correctamente sin ellas (proceso reiniciado).

#### Scenario: Reinicio de proceso con resume imposible
- **WHEN** el proceso muere y al arrancar el servidor ya no permite resumir
  el stream anterior
- **THEN** el plugin abre sesión nueva y recupera los salientes pendientes
  desde el spool sin pérdida ni duplicados

#### Scenario: Resume exitoso en memoria
- **WHEN** el plugin se reconecta en el mismo proceso y el resume tiene
  éxito
- **THEN** los salientes cubiertos por el contador `h` del servidor se
  marcan reconocidos y no se reenvían

### Requirement: Carbons y hints sin regresión
El reenvío desde el spool y el catch-up MAM DEBEN (MUST) preservar el
comportamiento actual de XEP-0280 (ignorar `<sent/>`, procesar
`<received/>`) y de XEP-0334 (los parciales efímeros conservan
`<no-store/>` y nunca llenan MAM ni push).

#### Scenario: Reenvío con carbons activos
- **WHEN** un mensaje se reenvía desde el spool con carbons habilitados
- **THEN** la copia `<sent/>` propia se ignora y el dedupe del receptor
  neutraliza cualquier duplicado
