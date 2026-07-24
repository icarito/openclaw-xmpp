## Why

Los agentes con `tools.exec.mode: "auto"` generan una card de aprobación por
cada comando que el reviewer no clasifica como `risk:"low"` — en la práctica,
cualquier exec fuera de una allowlist estática cae en `ask`. Cuando un agente
necesita ejecutar una racha de comandos de diagnóstico (ej. Clawdio
investigando un bug), esto produce docenas de cards seguidas sin que el
usuario pueda mantenerse al día, y no existe ninguna forma de decirle al
gateway "confiá en mí por los próximos N minutos" desde el cliente — solo el
comando manual `approval-mode full`, sin expiración automática, que además
requiere que el operador se acuerde de revertirlo.

Separadamente, Android ya tiene un switch de "bypass approvals" en la sticky
card (agregado sin verificar el contrato con el servidor) que manda un
comando XMPP a un nodo que el plugin nunca registró — el switch existe pero
no hace nada. GTK no tiene ningún control equivalente. Y la card de
aprobación entregada por la ruta nativa de XMPP se ve peor que por la ruta
forwarder porque una de las dos rutas no pasa el texto por el compactador
existente, dejando bloques de código vacíos visibles al usuario.

## What Changes

- Nueva acción de comando ad-hoc `approval-bypass` (XEP-0050) en el plugin,
  distinta de `approval-mode`: activa una policy de exec relajada
  (`execSecurity`/`execAsk` a nivel de sesión, vía el método de gateway
  `sessions.patch` ya soportado por el core) por una duración acotada
  (parámetro en minutos, con un máximo configurable), sin editar
  `openclaw.json` ni requerir reinicio del gateway.
- Un temporizador en el proceso del plugin agenda la reversión automática al
  vencer, volviendo a aplicar la policy previa vía el mismo `sessions.patch`,
  sin depender de que el cliente siga conectado.
- El estado de bypass activo (policy previa, timestamp de expiración) se
  mantiene en memoria del proceso del plugin (no en disco); se expone vía el
  mismo comando en modo `status` para que un cliente pueda consultar cuánto
  tiempo queda. Si el gateway se reinicia mientras hay un bypass activo, el
  estado en memoria se pierde y la sesión vuelve a su policy persistida
  normal — comportamiento aceptado, documentado en design.md.
- Corrección del nombre de nodo esperado: el comando que los clientes deben
  invocar para bypass temporal es `approval-bypass`, descubierto dinámicamente
  vía disco#items como cualquier otro comando ad-hoc — ningún cliente debe
  hardcodear un nodo que el servidor no registra.
- Unificación de la ruta nativa de entrega de approval cards
  (`approval-handler.runtime.ts`) para pasar el texto por el mismo
  compactador (`buildCompactExecApprovalText`) que ya usa la ruta forwarder,
  eliminando la asimetría que deja bloques de código vacíos en el fallback de
  texto.
- Refuerzo de `compactApprovalFallbackText` en `send.ts` para eliminar
  cualquier bloque de fence vacío remanente, como red de seguridad
  independiente de cuál ruta de entrega generó el texto.
- Documentación (no código, en `design.md`) del patrón de allowlist de
  lectura por agente en `exec-approvals.json`, para que cualquier agente
  nuevo (incluyendo despliegues fuera de claudio-w) pueda adoptarlo sin
  redescubrir el mecanismo.

**BREAKING**: ninguno — `approval-bypass` es un comando nuevo; `approval-mode`
no cambia de comportamiento.

## Capabilities

### New Capabilities
- `xmpp-approval-bypass`: comando ad-hoc de bypass temporal de aprobaciones
  con auto-reversión server-side, descubrible vía XEP-0050, independiente de
  `approval-mode`.
- `xmpp-approval-fallback-text`: garantía de que el texto de fallback de una
  approval card, sin importar cuál de las rutas de entrega la generó, nunca
  contiene bloques de código vacíos.

### Modified Capabilities
(ninguna — `xmpp-inline-buttons` no cambia de contrato: el bypass se expone
como comando ad-hoc adicional, no como una opción nueva dentro de las cards
de aprobación puntuales existentes)

## Impact

- Afecta `src/approval-mode.ts` (o un nuevo `src/approval-bypass.ts` hermano),
  `src/commands.ts` (registro del nodo), `src/approval-handler.runtime.ts`
  (fix de compactación), `src/send.ts` (refuerzo del filtro de fences vacíos).
- No afecta el core vendorizado de OpenClaw ni el vocabulario de decisión de
  aprobaciones puntuales (`allow-once|allow-always|deny`).
- Fuera de este repo: los clientes `gtk-llm-chat-android` y `gtk-llm-chat`
  necesitan su propio trabajo (fuera del alcance de este change, documentado
  como contrato en `design.md`) para que sus switches de bypass inviquen
  `approval-bypass` en vez de `approval-bypass` mal registrado (Android) o
  agreguen el control (GTK) — ambos vía descubrimiento dinámico de comandos,
  sin strings hardcodeados del lado cliente salvo el nombre del comando en sí
  para poder mostrarlo antes de que llegue el primer disco#items.
