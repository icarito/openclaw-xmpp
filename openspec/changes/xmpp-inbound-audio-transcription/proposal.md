## Why

El pipeline de inbound del canal XMPP (`src/inbound.ts`) descarga y empaqueta
adjuntos de audio, pero nunca invoca al transcriptor de audio del core de
OpenClaw antes de despachar la respuesta. Los canales Matrix, Feishu y
Discord sí resuelven una transcripción preflight para audio entrante; XMPP
nunca lo implementó (confirmado: ni el backup más antiguo del soporte de
media, del 16 de julio, lo tenía — no es una regresión, es una capability
que faltó desde el origen). El gateway ya está configurado correctamente a
nivel de `tools.media.audio` (Groq Whisper `whisper-large-v3` vía script
CLI), pero esa configuración nunca se consulta porque el canal XMPP no llega
a ese punto del flujo. El resultado observable: los agentes reciben audio
por XMPP sin transcripción, para las 7 cuentas configuradas (bob, clawdio,
hiori, odiseo, pliaget, rolando, steve).

## What Changes

- Agregar una llamada de preflight de transcripción de audio en
  `src/inbound.ts`, invocada cuando el adjunto entrante es audio, antes de
  `finalizeInboundContext`/`dispatchReply`.
- Seguir el patrón ya usado por otros canales del mismo runtime (p. ej.
  `loadMatrixPreflightAudioRuntime` / `resolveFeishuAudioPreflightTranscript`)
  para reusar el mecanismo de transcripción del core en vez de reimplementarlo.
- La transcripción resultante se adjunta al contexto del mensaje entrante de
  la misma forma que los demás canales (texto transcrito visible al agente,
  respetando `echoTranscript` si el core lo expone).
- Sin cambios de configuración: se reutiliza `tools.media.audio` tal como
  está definida hoy en `openclaw.json` (Groq Whisper `whisper-large-v3` sin
  turbo). Este change no toca el script `groq-whisper-transcribe.sh` ni el
  config del gateway.
- Aplica de forma uniforme a las 7 cuentas XMPP configuradas, ya que la
  config de audio es global (`tools.media`), no por agente.

## Capabilities

### New Capabilities
- `xmpp-inbound-audio-transcription`: transcripción automática de adjuntos
  de audio entrantes por XMPP, reusando el runtime de transcripción del
  core de OpenClaw antes de despachar la respuesta del agente.

### Modified Capabilities
(ninguna — no existe spec previa de inbound media/audio en este repo)

## Impact

- Código afectado: `src/inbound.ts` (flujo de inbound media), posible
  import nuevo desde el SDK/runtime de OpenClaw para el transcriptor.
- Sin cambios en `openclaw.json` del gateway ni en el script CLI de Groq.
- Sin cambios de esquema de DB ni de protocolo XMPP.
- Requiere verificación end-to-end con un audio real por al menos una
  cuenta XMPP antes de considerarse resuelto (no basta con que compile).
- Deploy: cambio vive en `openclaw-xmpp` (este repo); tras mergear, el
  gitlink `extensions/xmpp` en `claudio-w` debe actualizarse por separado,
  y el despliegue a `/opt/claudio-w` en el servidor requiere el paso
  explícito de sesión primaria (no lo hace un agente delegado).
