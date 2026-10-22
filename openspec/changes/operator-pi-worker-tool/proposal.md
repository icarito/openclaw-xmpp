## Why

Operator necesita iniciar, consultar y detener un worker `pi-msg` desde la
MUC actual sin dar al modelo acceso directo a credenciales o shell privilegiado.

## What Changes

- Registrar la herramienta tipada `pi_worker` solo en ejecuciones del agente y
  cuenta XMPP `operator`.
- Exigir el JID real del propietario para inicio/cierre y limitar inicio a la
  MUC del turno; enviar solicitudes por un socket Unix local.
- Fail closed si el evento no contiene un JID real visible.

## Capabilities

### New Capabilities

- `xmpp-pi-worker-tool`: interfaz XMPP restringida para controlar el worker local.

## Impact

- `src/pi-worker-tool.ts`, registro del plugin, manifiesto y dependencias.
- Pruebas del límite de confianza. La ejecución/credenciales del worker se
  implementan en el repositorio de `claudio-w`.
