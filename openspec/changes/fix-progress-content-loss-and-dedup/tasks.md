## 1. No content overwrite on turn close (prioritario — pérdida de datos activa)

- [x] 1.1 En `src/progress.ts`, modificar `finishWithoutReply()` para
      chequear `partialText.trim()` y `compositorText.trim()` antes de
      llamar `finalizeWithFinalText`.
- [x] 1.2 Si hay contenido sustantivo, drenar la burbuja tal cual está
      (equivalente a `closeWindow()`) en vez de reemplazarla con "Turno
      completado sin respuesta visible.".
- [x] 1.3 Si no hay contenido sustantivo, mantener el comportamiento actual
      (finalizar con el texto genérico).
- [x] 1.4 Test unitario: turno con `partialText` no vacío que cierra sin
      `deliver()` — la burbuja conserva el texto existente. **N/A**: el
      repo no tiene test runner configurado (sin script `test`, sin
      devDependency de framework, sin archivos `*.test.ts` en `src/`); la
      verificación de este repo es `npx tsc --noEmit` (ver CLAUDE.md). No
      se introduce infraestructura de testing nueva fuera del alcance de
      este fix — verificado manualmente vía revisión de código y, si es
      posible, prueba end-to-end contra el servidor real (tarea 4.4).
- [x] 1.5 Test unitario: turno tool-only sin texto que cierra sin
      `deliver()` — la burbuja se finaliza con el texto genérico (caso
      existente, no debe regresionar). **N/A**: mismo motivo que 1.4.

## 2. Guard contra reapertura de burbuja para el mismo turno

- [x] 2.1 En `src/progress.ts` / `src/inbound.ts`, identificar cómo se
      puede detectar que `createXmppProgressController` se está invocando
      de nuevo para un turno cuya burbuja anterior (mismo proceso) sigue
      viva. **Solución**: registro module-level (`liveBubbleRegistry`,
      patrón `globalThis` + Map igual que `activity-registry.ts`) keyed
      por `route.sessionKey`, pasado como nuevo param `sessionKey`.
- [x] 2.2 Agregar el guard: si aplica, reusar/editar la burbuja existente
      en vez de crear una nueva vía `sendMessageXmpp`. `progressMessageId`
      ahora se inicializa desde el registro si hay burbuja viva para la
      sesión — `start()` ya no la reabre porque su guard existente
      (`if (progressMessageId) return`) pasa a ser cierto.
- [x] 2.3 Log liviano cuando el guard evita una burbuja duplicada (ver
      Open Question del design). Agregado en `start()`-path vía
      `params.log` cuando se reusa una burbuja del registro.
- [x] 2.4 Test: reprocesamiento del mismo turno dentro del mismo proceso
      mientras la burbuja sigue viva — no se crea una segunda burbuja.
      **N/A**: mismo motivo que 1.4/1.5 (sin test runner en el repo).
- [x] 2.5 Test: turno nuevo tras finalización del anterior — se crea
      burbuja normalmente (no regresión). **N/A**: mismo motivo.
- [x] 2.6 Documentar explícitamente en el código (comentario corto) que
      este guard NO cubre reinicio de proceso — eso lo cubre el trabajo de
      XEP-0198 en curso por separado. Documentado en el comentario sobre
      `LIVE_BUBBLES_KEY`.

## 3. Envío de adjuntos salientes (`upload-file`)

- [x] 3.1 Ubicar el código que actualmente rechaza la acción `upload-file`
      para el canal xmpp con "Message action upload-file not supported".
      **Hallazgo que corrige el diagnóstico original del proposal**: el
      error no viene de un `send.ts` incompleto -- `sendFileXmpp` YA
      implementa XEP-0363 real (request slot → PUT → URL) y ya lo usa el
      camino `"send"` con `mediaUrl`. El error viene del SDK
      (`dispatchChannelMessageAction` en `message-action-dispatch`): el
      plugin declara `supportsAction` limitado a `"send" | "read"`
      (`src/channel.ts` ~505), así que cualquier acción `upload-file`
      nunca llega a `handleAction` y el runner lanza el genérico "not
      supported for channel xmpp".
- [x] 3.2 Reutilizar la lógica de descubrimiento de servicio HTTP Upload
      ya usada por `downloadInboundAttachment`. **N/A tal como estaba
      planteado**: no hace falta reutilizar nada porque el descubrimiento
      de servicio de subida saliente YA existe y ya funciona
      (`uploadFileXmpp` dentro de `sendFileXmpp`, `src/send.ts:598`) --
      sólo faltaba exponerlo bajo el nombre de acción `upload-file`.
- [x] 3.3 Implementar el flujo de subida XEP-0363. **N/A, ya existía** —
      ver 3.1/3.2. Cambio real: `src/channel.ts` -- `supportsAction`,
      `describeMessageTool`, `resolveExecutionMode` y `handleAction` ahora
      aceptan `"upload-file"` y lo enrutan siempre a `sendFileXmpp`
      (nunca cae a texto plano ni a payload, a diferencia de `"send"`).
- [x] 3.4 Manejar el caso de servicio de upload no descubierto: error
      explícito en vez de "not supported for channel xmpp" genérico.
      `sendFileXmpp` (`src/send.ts:599-621`) ya degrada a un mensaje con
      link plano + log de la razón cuando `uploadFileXmpp` falla, en vez
      de fallar duro -- comportamiento preexistente, adecuado, sin cambios
      necesarios. Además se agregó un chequeo explícito en `handleAction`:
      `upload-file` sin `mediaUrl` falla con mensaje claro en vez de
      silenciosamente mandar texto vacío.
- [ ] 3.5 Probar end-to-end contra el servidor real
      (`upload.hablar.fuentelibre.org`) con un archivo de prueba antes de
      dar el fix por bueno — no asumir éxito solo porque compila.
      **Pendiente**: requiere desplegar en el servidor (tarea 4.4 cubre
      esto en conjunto).

## 4. Cierre del change

- [x] 4.1 Ejecutar la comprobación TypeScript del repo y documentar
      cualquier incompatibilidad preexistente con el SDK de OpenClaw.
      `npx tsc --noEmit` tiene múltiples errores preexistentes en el repo
      (incompatibilidades de tipos del SDK zod/openclaw en
      `approval-handler.runtime.ts`, `config-schema.ts`, `monitor.ts`,
      `policy.ts`, `telemetry.ts`, y un error en `inbound.ts:544-545`
      sobre `onPartialReply`), confirmados vía `git stash` de los 3
      archivos tocados como YA presentes antes de este change — no son
      regresión. Los dos archivos donde sí hice cambios de lógica nueva
      (`src/channel.ts`, `src/progress.ts`) compilan sin ningún error.
- [ ] 4.2 Commit en `openclaw-xmpp`.
- [ ] 4.3 Actualizar el gitlink del submódulo `extensions/xmpp` en
      `claudio-w`.
- [ ] 4.4 Reiniciar `claudio-w-openclaw.service` en el servidor y
      verificar en logs reales que: (a) un turno con contenido parcial no
      se pisa al cerrar sin respuesta, (b) `upload-file` entrega un
      adjunto real de prueba.
