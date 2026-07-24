## Context

`src/inbound.ts` en este plugin descarga adjuntos entrantes de XMPP (incluye
audio, vía HTTP Upload/XEP-0363) y los empaqueta con
`buildChannelInboundMediaPayload(...)` antes de pasar el contexto a
`finalizeInboundContext` → `dispatchReply`. Nunca se resuelve una
transcripción para el audio en ese camino.

El SDK de OpenClaw (`openclaw/plugin-sdk/media-runtime`, re-exportado desde
`media-runtime-Bx-j125F.js`) expone `transcribeFirstAudio({ ctx, cfg,
agentDir?, providers?, activeModel? }): Promise<string | undefined>`, que
transcribe el primer adjunto de audio usando el proveedor configurado en
`cfg.tools.media.audio` (hoy: script CLI de Groq Whisper `whisper-large-v3`).

El canal Matrix ya resuelve este patrón en
`extensions/matrix/src/matrix/monitor/preflight-audio.ts`
(`resolveMatrixPreflightAudioTranscript`, compilado en
`monitor-BFgBJqQr.js:1728-1753` del paquete `openclaw` instalado). Ese código
sirve de referencia directa — no es necesario adivinar la forma del `ctx` ni
el manejo de errores, ya está resuelto ahí.

## Goals / Non-Goals

**Goals:**
- Antes de despachar la respuesta del agente para un mensaje XMPP con
  adjunto de audio, transcribir el audio vía `transcribeFirstAudio` y anexar
  el transcripto al contexto del mensaje entrante, igual que Matrix.
- Respetar `cfg.tools.media.audio.echoTranscript`: si está activo, enviar de
  vuelta al remitente un eco del transcripto (mismo patrón que
  `sendMatrixPreflightAudioTranscriptEcho`), usando el mecanismo de envío
  de mensajes ya existente en este plugin XMPP (no
  `sendDurableMessageBatch` de Matrix, que es específico de ese canal).
- Que falle de forma silenciosa y no bloqueante: un error de transcripción
  (proveedor caído, timeout, audio corrupto) debe loguearse y permitir que
  el flujo normal de inbound continúe sin transcripto, nunca abortar el
  turno.
- Aplicar uniformemente a las 7 cuentas XMPP configuradas (config de audio
  es global, no por agente/cuenta).

**Non-Goals:**
- No se modifica `tools.media.audio` en `openclaw.json` ni el script
  `groq-whisper-transcribe.sh` — la config y el proveedor ya son correctos.
- No se implementa transcripción para video o notas de voz con codecs no
  soportados por el proveedor configurado (fuera del alcance: eso ya lo
  resuelve `transcribeFirstAudio` internamente vía `isVoiceCompatibleAudio`
  / `isAudioFileName`).
- No se cambia el comportamiento de otros canales (Matrix, Feishu, Discord,
  Telegram) ni código compartido del core.

## Decisions

**Reusar `transcribeFirstAudio` del plugin-sdk en vez de invocar el script
CLI directamente.** El plugin XMPP no debe reimplementar resolución de
proveedor/modelo ni manejo de `MIN_AUDIO_FILE_BYTES`/mime sniffing — todo
eso ya lo hace `transcribeFirstAudio` a partir de `cfg.tools.media.audio`.
Llamar directo al script sería duplicar lógica que ya existe en el core y
divergería si el proveedor cambia (p. ej. si se agrega el fallback OpenAI
`gpt-4o-mini-transcribe` que ya está listado en `models[]`).

**Construir `ctx` con `Provider: "xmpp"`, `Surface: "xmpp"`,
`OriginatingChannel: "xmpp"`**, siguiendo el mismo patrón que Matrix usa
`"matrix"` en esos tres campos. `MediaPaths` apunta al archivo ya descargado
localmente por el pipeline existente de XMPP (mismo path que hoy se pasa a
`buildChannelInboundMediaPayload`), no se re-descarga nada.

**Insertar la llamada de preflight antes de `finalizeInboundContext`,** no
dentro de `buildChannelInboundMediaPayload`. Esto mantiene el empaquetado de
media (que sirve para imagen/documento/video también) desacoplado de la
lógica de transcripción, igual que en Matrix donde el preflight es una
función separada que se llama desde el monitor antes de construir el
contexto final.

**Eco de transcripción usa el sender nativo de XMPP del plugin, no
`sendDurableMessageBatch`.** Esa función es específica del runtime interno
de Matrix; este plugin ya tiene su propio mecanismo de envío de mensajes
(usado por streaming XEP-0308 y demás). El eco debe usar ese mecanismo
existente para mantener consistencia de firma/edición de mensajes en este
canal.

**Envolver toda la resolución en try/catch con log verbose, replicando
`catch (err) { logVerbose(...); return; }` de Matrix.** Ningún fallo de
transcripción debe convertirse en una excepción no capturada que tumbe el
turno o deje la sesión en un estado inconsistente — ya hay precedente de
"la burbuja de progreso pisa contenido real" en incidentes previos de este
canal cuando errores no manejados interrumpen el flujo normal.

## Risks / Trade-offs

- [El proveedor Groq puede fallar por rate-limit o timeout de red bajo
  carga (p. ej. varios audios simultáneos entre distintas cuentas XMPP)] →
  Mitigación: el try/catch ya propuesto asegura degradación a "sin
  transcripto" en vez de bloquear el turno; no se requiere retry en este
  change.
- [Audio muy corto o con ruido puede producir transcripts vacíos o
  erróneos] → Mitigación: ya cubierto por `MIN_AUDIO_FILE_BYTES` dentro de
  `transcribeFirstAudio`; no se necesita lógica adicional en el plugin XMPP.
- [Cuentas XMPP con adjuntos grandes pueden exceder `maxBytes` configurado
  (20 MiB actual)] → Mitigación: ya gestionado por config existente
  (`tools.media.audio.maxBytes`), sin cambios necesarios aquí.
- [Duplicar el eco de transcripción si el usuario ya ve el audio original
  reenviado] → Mitigación: respetar el flag `echoTranscript` tal cual está
  configurado hoy (`true`); no se agrega un flag nuevo por canal.

## Migration Plan

1. Implementar el preflight de audio en `src/inbound.ts` (o un módulo nuevo
   `src/preflight-audio.ts` si el archivo actual ya es grande, siguiendo la
   separación de Matrix en su propio archivo).
2. Verificar compilación TypeScript del plugin contra el SDK instalado
   (`tsc`/build script del repo) y documentar cualquier incompatibilidad
   preexistente encontrada, según indica el contexto del proyecto.
3. Probar localmente contra al menos una cuenta XMPP real con un audio de
   prueba (hay audios ya guardados en
   `/opt/claudio-w/openclaw-home/media/inbound/` en el servidor que pueden
   usarse como fixture) antes de dar por buena la implementación.
4. Commitear en este repo (`openclaw-xmpp`), luego actualizar el gitlink
   `extensions/xmpp` en `claudio-w` (repo espejo/coordinación).
5. El despliegue real a `/opt/claudio-w` en el servidor requiere el paso
   explícito de sesión primaria — no lo ejecuta un agente delegado. Reiniciar
   `claudio-w-openclaw.service` tras desplegar para que tome el nuevo código.
6. Verificación end-to-end post-deploy: enviar un audio real por XMPP a una
   cuenta y confirmar en logs (`openclaw.log`) y en la respuesta del agente
   que el transcripto llegó — no basta con ausencia de errores.

## Open Questions

- ¿El eco de transcripción (`echoTranscript: true`) debe respetar el mismo
  formato `📝 "{transcript}"` que usa Matrix, o el usuario prefiere un
  formato distinto para XMPP? Se asume el mismo formato por defecto salvo
  indicación contraria durante la implementación.
- ¿Vale la pena extraer un helper compartido en el core para evitar que
  cada canal reimplemente su propio `resolve<Channel>PreflightAudioTranscript`
  casi idéntico? Fuera de alcance de este change (tocaría el core de
  OpenClaw, no este plugin), pero se deja anotado para una futura propuesta.
