## Why

Tras la reconexión de Operator el 2026-10-16, Prosody archivó de nuevo dos mensajes de `engineering` con los mismos `origin-id` emitidos 17 minutos antes. El spool aún los consideraba pendientes porque el eco del MUC se descartaba sin registrarlo como confirmación de entrega.

## What Changes

- Reconocer el eco del propio nick de un MUC como confirmación del mensaje saliente correspondiente.
- Confirmar únicamente cuando coinciden el `origin-id` y la sala de la entrada pendiente.
- Consumir el eco antes de intentar descifrarlo o despacharlo al agente.

## Scope

Plugin `openclaw-xmpp`, confirmación del spool para mensajes MUC. No cambia la semántica de mensajes directos ni modifica el historial archivado.
