## Why

El controlador de burbuja de progreso XMPP (`XmppProgressController`, una
burbuja por turno editada vía XEP-0308) tiene tres fallas relacionadas
detectadas en producción hoy (2026-07-22) sobre la cuenta `operator`:

1. **Pérdida de contenido real**: cuando un turno termina sin que
   `dispatchReply` haya llamado `deliver()` (por ejemplo, un recovery forzado
   tras un tool-call bloqueado), el código sobrescribe incondicionalmente la
   burbuja viva con el texto genérico "Turno completado sin respuesta
   visible.", **sin verificar si ya había contenido real visible en la
   burbuja**. Confirmado en logs de servidor: una sesión `operator` quedó
   bloqueada 35+ minutos por una tarjeta de aprobación que cayó a fallback de
   texto plano (`payload controls=0`), el recovery forzó un abort sucio
   (`aborted=false drained=false forceCleared=true`), y el usuario vio una
   respuesta que estaba leyendo convertirse en el texto genérico en el
   cliente GTK.
2. **Burbujas duplicadas en vez de edición**: `progressMessageId` vive sólo
   en el closure de `createXmppProgressController`, instanciado una vez por
   mensaje entrante. Sin deduplicación de reentrega, una reconexión XMPP
   (confirmados 3 reinicios de servicio en una ventana de 24h) puede
   reprocesar el mismo turno y abrir una burbuja nueva en vez de editar la
   existente — visible como respuestas triples y como "Usando herramienta:
   exec" repetido en mensajes de chat separados en vez de una sola burbuja
   viva.
3. **Envío de adjuntos no soportado**: el canal xmpp no implementa la acción
   `upload-file`; el log de errores del servidor muestra
   `Message action upload-file not supported for channel xmpp`. El
   downloadr entrante (XEP-0363 vía `downloadInboundAttachment`) ya existe;
   falta el camino de subida saliente. Esto es la causa concreta de un bug
   ya reportado por usuarios (adjuntos de agentes que nunca llegan como
   archivo real al cliente).

Los tres bugs comparten el mismo componente (el controlador de progreso y su
entrega vía `deliverXmppReply`) y se están arreglando juntos porque tocan el
mismo ciclo de vida de burbuja/turno.

## What Changes

- `finishWithoutReply()` (`src/progress.ts`) deja de sobrescribir
  incondicionalmente la burbuja: si `compositorText`/`partialText` ya tienen
  contenido sustantivo cuando el turno cierra sin `deliver()`, la burbuja se
  conserva tal cual (o se marca como interrumpida de forma que no borre el
  texto), en vez de reemplazarse por "Turno completado sin respuesta
  visible.".
- El controlador de progreso gana un guard defensivo contra reapertura de
  burbuja para el mismo turno/stanza: si ya existe una burbuja viva
  (`progressMessageId` no nulo) asociada a un turno en curso y llega un
  reprocesamiento del mismo mensaje entrante, no se abre una burbuja nueva.
  Este guard es defensivo y liviano — la deduplicación robusta de
  reconexión (XEP-0198 Stream Management) la está implementando el agente
  Operator en paralelo en otro change; este no la duplica.
- Se implementa la acción `upload-file` para el canal xmpp usando XEP-0363
  HTTP Upload (mismo servicio de upload que ya usa la descarga entrante),
  permitiendo que los agentes envíen adjuntos reales en vez de fallar
  silenciosamente.

## Capabilities

### New Capabilities
- `xmpp-progress-bubble`: ciclo de vida de la burbuja de progreso editable
  por turno (XEP-0308) — creación, edición, finalización con respuesta real,
  finalización sin respuesta, y protección contra reapertura duplicada.
- `xmpp-outbound-attachments`: envío de archivos adjuntos salientes desde un
  agente hacia un contacto XMPP vía XEP-0363 HTTP Upload.

### Modified Capabilities
(ninguna — no hay spec existente para este comportamiento; ambas capacidades
son nuevas)

## Impact

- `src/progress.ts`: `finishWithoutReply`, `start`, guard de reapertura de
  burbuja.
- `src/inbound.ts`: punto de llamada de `progress.finishWithoutReply()` y
  creación del controller.
- Nuevo código de envío de adjuntos (probablemente `src/send.ts` o módulo
  nuevo), reutilizando el descubrimiento de servicio de upload ya existente
  para la descarga entrante.
- Sin cambios de esquema de configuración; no rompe compatibilidad con
  cuentas existentes.
- Coordinación con el trabajo en curso de XEP-0198/Message Carbons (otro
  change, mismo repo) — este change no debe reimplementar Stream Management.
