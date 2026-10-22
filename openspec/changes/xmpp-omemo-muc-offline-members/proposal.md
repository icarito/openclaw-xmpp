## Why

En `engineering`, dos mensajes OMEMO 2 de Operator enviados el 2026-10-16 a las 16:00 UTC omitieron todas las claves de Sebastián, aunque sigue afiliado como `owner`. El plugin seleccionaba únicamente ocupantes presentes; los mensajes archivados para miembros ausentes son imposibles de descifrar.

## What Changes

- Consultar las listas MUC de `member`, `admin` y `owner` antes de cifrar cada mensaje grupal, e incluir esos JID aunque estén ausentes.
- Rechazar el envío cifrado si alguna lista no puede leerse o algún destinatario queda sin clave, evitando un sobre incompleto.
- Conservar los ocupantes presentes como complemento para no perder el comportamiento de salas abiertas.

## Scope

Plugin `openclaw-xmpp`, cifrado saliente MUC OMEMO y pruebas del roster. No altera identidades, afiliaciones ni credenciales. Los mensajes históricos requieren reenvío posterior.
