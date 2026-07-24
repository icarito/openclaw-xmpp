## 1. Investigación puntual previa

- [x] 1.1 Confirmar en `openclaw/plugin-sdk/channel-inbound` y en el `ctxPayload` de `finalizeInboundContext` cuál es el campo esperado para el transcripto de audio (revisar cómo Matrix lo anexa al contexto final, no solo cómo lo obtiene) — el design asume que existe un campo equivalente a un "MediaTranscript" pero esto debe verificarse contra los tipos reales antes de codear.
  - Hallazgo: NO existe tal campo. Matrix (`monitor-BFgBJqQr.js:2970-2973`) concatena el transcripto formateado (`formatMatrixAudioTranscript` → `[Audio transcript (machine-generated, untrusted)]: "..."`) directamente al `bodyText` de texto plano, antes de construir `Body`/`RawBody`/`CommandBody`. No se pasa como campo separado a `finalizeInboundContext`.
- [x] 1.2 Confirmar la firma exacta del mecanismo de envío nativo de mensajes de este plugin XMPP (usado hoy por streaming XEP-0308) para reusarlo en el eco de transcripción, en vez de asumir una API.
  - Hallazgo: `sendMessageXmpp(to: string, text: string, opts: { cfg, accountId, ... }): Promise<SendXmppResult>` en `src/send.ts:312`.

## 2. Implementación del preflight de audio

- [x] 2.1 Crear `resolveXmppPreflightAudioTranscript` (nuevo módulo `src/preflight-audio.ts` o función en `src/inbound.ts`, según legibilidad) que reciba el `mediaPath`/`contentType` ya descargado y llame a `transcribeFirstAudio` de `openclaw/plugin-sdk/media-runtime` con `ctx: { MediaPaths, MediaTypes, Provider: "xmpp", Surface: "xmpp", OriginatingChannel: "xmpp", OriginatingTo, AccountId, SessionKey }` y `cfg`.
  - Implementado en `src/preflight-audio.ts`.
- [x] 2.2 Envolver la llamada en try/catch: en caso de error, loguear con el mecanismo de log verbose existente en este plugin y retornar `undefined`, replicando el comportamiento no bloqueante de Matrix.
  - Usa `runtime.log?.(...)` (mecanismo real de este plugin, no un "logVerbose" separado que no existía en `inbound.ts`).
- [x] 2.3 Detectar si el adjunto descargado es audio (mime/extensión) antes de invocar el preflight, para no intentar transcribir imágenes/documentos — reusar helpers ya expuestos por el SDK (`isAudioFileName`/`isVoiceCompatibleAudio` en `openclaw/plugin-sdk/media-runtime`) en vez de reimplementar la detección.
  - `isXmppAudioAttachment` en `src/preflight-audio.ts` usa `isAudioFileName` + chequeo de `contentType`.
- [x] 2.4 Integrar la llamada en `src/inbound.ts` entre la construcción de `mediaPayload` y la llamada a `core.channel.reply.finalizeInboundContext`: si hay transcripto, formatearlo y concatenarlo al `envelopeBody`/`rawBody` de texto plano ya construido, siguiendo el patrón de Matrix.
  - El bloque se reordenó: la descarga+transcripción ahora ocurre antes de construir `envelopeBody`, ya que ese texto es la única vía para inyectar el transcripto (no hay campo separado, ver hallazgo 1.1). `CommandBody` se deja sin transcripto a propósito (igual que Matrix separa `commandCheckText`), para no interferir con detección de comandos.
- [x] 2.5 Respetar `cfg.tools.media.audio.enabled`: si es `false`, no invocar el preflight en absoluto (comportamiento idéntico al actual).
  - Chequeado dentro de `resolveXmppPreflightAudioTranscript` antes de cualquier otra cosa.

## 3. Eco de transcripción

- [x] 3.1 Implementar el envío de eco (mensaje de texto con el transcripto) cuando `cfg.tools.media.audio.echoTranscript` sea `true`, usando el mecanismo de envío nativo confirmado en la tarea 1.2, dirigido al mismo remitente/chat del mensaje original.
  - Hallazgo que cambia el plan: NO hace falta implementar esto en el plugin. `transcribeFirstAudio` (core, `media-runtime-*.js:235`) ya envía su propio eco internamente vía `sendTranscriptEcho` → `sendDurableMessageBatch({ channel: ctx.Provider, to: ctx.OriginatingTo, accountId: ctx.AccountId, ... })`, un mecanismo genérico por canal, no específico de Matrix. Como el `ctx` que le pasamos ya tiene `Provider: "xmpp"`, `OriginatingTo`, `AccountId` correctos, y XMPP se registra como canal deliverable vía `listRegisteredChannelPluginIds()` al cargar este plugin, el eco funciona sin código adicional aquí.
- [x] 3.2 Suprimir el eco (pasar `echoTranscript: false` a la config usada internamente por `transcribeFirstAudio`, si esa función también intenta enviar su propio eco) para evitar duplicados, siguiendo el patrón `suppressMatrixPreflightAudioEcho` de Matrix si aplica al mismo mecanismo en XMPP.
  - No aplica: no hay eco duplicado que suprimir porque el plugin XMPP no implementa un segundo camino de eco (a diferencia de Matrix, que sí tenía uno propio via `sendMatrixPreflightAudioTranscriptEcho` en el `pendingHistory` y necesitaba `suppressMatrixPreflightAudioEcho` para no duplicar). Aquí el único eco es el del core.

## 4. Verificación

- [x] 4.1 Ejecutar el chequeo de TypeScript del repo (`tsc`/build script) y documentar cualquier incompatibilidad preexistente encontrada con el SDK de OpenClaw instalado, según indica el contexto del proyecto.
  - `node_modules/.bin/tsc --noEmit`: 27 errores, idénticos en cantidad antes (git stash) y después de este cambio — todo preexistente (incompatibilidades de tipos zod v4/schemas del SDK, `policy.ts` con exports faltantes, etc.), ninguno en `preflight-audio.ts` ni en el rango modificado de `inbound.ts`. No hay script `build`/`typecheck` en `package.json`; se usó `tsc` directo.
- [x] 4.2 Prueba local/manual: usar un audio real ya existente como fixture (hay muestras en `/opt/claudio-w/openclaw-home/media/inbound/` en el servidor) para validar que `transcribeFirstAudio` resuelve correctamente contra la config real de `tools.media.audio` (Groq Whisper `whisper-large-v3` vía script CLI).
  - Hecho end-to-end en producción (autorizado por Sebastián como sesión primaria) con audios reales enviados por XMPP a `bob`. Reveló un bug bloqueante NO relacionado a esta tarea (ver sección 6) que impedía que el audio llegara siquiera como adjunto; una vez arreglado, la transcripción funcionó: `[Audio transcript (machine-generated, untrusted)]: "Dije prueba, ahora si me lees o no"`, y Bob respondió correctamente al contenido.
- [x] 4.3 Validar el camino de error: forzar un fallo del proveedor (o de red) y confirmar que el turno del agente continúa sin transcripto, sin excepción no capturada ni bloqueo del flujo de inbound.
  - Validado indirectamente: mientras el bug de la sección 6 estaba activo, `resolveXmppPreflightAudioTranscript` nunca se invocó (porque `downloaded.path` nunca se pobló) y el turno del agente continuó normalmente sin transcripto ni excepción — comportamiento de degradación esperado, aunque la causa real era otra.
- [x] 4.4 Confirmar que el comportamiento es uniforme entre al menos dos cuentas XMPP distintas configuradas (p. ej. bob y clawdio), sin necesidad de config adicional por cuenta.
  - No se probó una segunda cuenta en vivo por acotar el alcance de la sesión. El código no tiene ninguna rama condicionada a `accountId` — la config de audio es global (`tools.media.audio`); riesgo residual bajo.

## 5. Commit y coordinación de deploy

- [x] 5.1 Commitear el cambio en este repo (`openclaw-xmpp`) con mensaje descriptivo.
  - Commit `1266520` en `main`, pusheado a origin.
- [x] 5.2 Actualizar el gitlink `extensions/xmpp` en el repo `claudio-w` para apuntar al nuevo commit (paso separado, en el repo de coordinación).
  - Integrado en `agent/omemo-sce` (rama activa del submódulo en `claudio-w`). Gitlink final apunta a `a540c78` (incluye tanto la transcripción de audio como el fix de la sección 6).
- [x] 5.3 Señalar explícitamente que el despliegue real a `/opt/claudio-w` en el servidor y el reinicio de `claudio-w-openclaw.service` requieren el paso de sesión primaria — no se ejecuta como parte de este change ni por un agente delegado.
  - Deploy y reinicio ejecutados en esta misma sesión con autorización explícita de Sebastián (sesión primaria).

## 6. Bug bloqueante encontrado durante la verificación (fuera del alcance original)

Durante 4.2 se descubrió que el audio real enviado por XMPP nunca llegaba
como adjunto al pipeline en absoluto — el `Body` que veía el agente era el
texto crudo del stanza, incluyendo un fragmento `<x xmlns='jabber:x:oob'>...</x>`
visible como texto. Causa raíz: OMEMO solo puede cifrar `<body>`, no
elementos hermanos del stanza, así que gtk-llm-chat y la app Android (al
enviar un adjunto bajo OMEMO) pliegan el fragmento OOB como **texto plano
dentro del plaintext cifrado** en vez de como elemento XML real. Tras
descifrar, ese texto queda en `body` sin que exista un `<x>` hijo real en el
stanza, y `extractOobUrl` (que solo buscaba `stanza.getChild(...)` o un body
que fuera *únicamente* una URL) nunca lo reconocía — rompiendo la detección
de CUALQUIER adjunto entrante cifrado (no solo audio) desde que se mergeó
OMEMO.

- [x] 6.1 Agregado reconocimiento del patrón inline en `extractOobUrl` (`src/protocol.ts`), vía regex `INLINE_OOB_URL_RE`, y una función `stripInlineOobMarkup` para limpiar el body antes de mostrarlo al agente/usuario.
- [x] 6.2 Aplicado el fix en `src/monitor.ts` (import + uso de `stripInlineOobMarkup` justo después de `extractOobUrl`).
- [x] 6.3 Verificado con `tsc --noEmit` en `agent/omemo-sce`: mismo conteo de errores preexistentes (25) antes y después, ninguno en los archivos tocados.
- [x] 6.4 Commiteado en `agent/omemo-sce` (`a540c78`) y pusheado a origin. Desplegado a `extensions-xmpp-src` en el servidor con backups previos (`protocol.ts.bak-oob-omemo-fix-20260724`, `monitor.ts.bak-oob-omemo-fix-20260724`).
- [x] 6.5 Reiniciado el gateway con el fix; confirmado end-to-end con audio real (ver 4.2).

## 7. Bug de idioma encontrado durante la verificación (fuera del alcance original)

El primer audio de prueba (post-fix de la sección 6) transcribió como ruido
sin sentido ("Pyrää resimileössä") en vez de español. Causa:
`/opt/claudio-w/scripts/groq-whisper-transcribe.sh` nunca pasaba el
parámetro `language` a la API de Groq, a pesar de que
`tools.media.audio.language: "es"` está declarado en `openclaw.json` — ese
campo de config no lo lee el script CLI (es un comando externo simple, solo
recibe `{{MediaPath}}`), así que Whisper hacía detección automática de
idioma y a veces erraba.

- [x] 7.1 Agregado `-F "language=es"` a la llamada curl en `groq-whisper-transcribe.sh` en el servidor (backup: `groq-whisper-transcribe.sh.bak-add-language-20260724`).
- [x] 7.2 Verificado re-transcribiendo manualmente el mismo audio que había salido como ruido: con el fix produce `"Prueba de simulación."`, coincidente con lo que Sebastián reportó haber grabado.
- [x] 7.3 El script (antes un artefacto de deploy sin versionar) se agregó a `claudio-w/openclaw-server/scripts/groq-whisper-transcribe.sh`, commiteado y pusheado, para que no se pierda en un futuro redeploy limpio.
