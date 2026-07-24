## Context

`XmppProgressController` (`src/progress.ts`) mantiene una única burbuja de
mensaje por turno, editada vía XEP-0308 conforme llegan eventos de
tool-progress y texto parcial. Su ciclo de vida esperado es: `start()` →
eventos intermedios → `finalizeWithFinalText()` (respuesta real) o
`finishWithoutReply()` (turno sin respuesta visible).

El estado (`progressMessageId`, `compositorText`, `partialText`) vive en un
closure creado una vez por mensaje entrante procesado
(`createXmppProgressController` en `src/inbound.ts:488`). No hay
persistencia entre invocaciones ni entre reconexiones del proceso.

Tres fallas de este diseño se confirmaron hoy en producción vía logs del
servidor y reporte directo del usuario, todas descritas en el proposal.
Este documento cubre las decisiones de diseño para las dos primeras (bubble
lifecycle); la tercera (`upload-file`) es un feature aparte sin relación de
diseño con el ciclo de vida de la burbuja, tratado al final.

## Goals / Non-Goals

**Goals:**
- Nunca destruir contenido de agente ya visible en la burbuja al cerrar un
  turno sin `deliver()`.
- Evitar burbujas duplicadas cuando el mismo turno se reprocesa mientras
  una burbuja para ese turno sigue viva.
- Implementar el envío saliente de adjuntos vía XEP-0363, reutilizando el
  descubrimiento de servicio de upload ya existente para la ruta entrante.

**Non-Goals:**
- No implementar XEP-0198 Stream Management ni Message Carbons — ese
  trabajo está en curso en paralelo (otro change, mismo repo, atribuido al
  agente Operator) y es la solución robusta a la causa raíz de
  reconexión/reentrega. Este change agrega solo un guard defensivo y barato
  a nivel de compositor, no una solución completa de deduplicación de
  stanzas.
- No cambiar el mecanismo de recovery de sesiones stuck en el core de
  OpenClaw (fuera de este repo) — se asume que un abort forzado puede
  seguir ocurriendo; este change solo hace que sus consecuencias visibles
  para el usuario sean menos destructivas.
- No agregar reintentos de subida de adjuntos ni progreso de subida en la
  burbuja — la primera versión de `upload-file` es un camino feliz simple.

## Decisions

### 1. Umbral de "contenido sustantivo" para no pisar la burbuja
`finishWithoutReply()` se modifica para chequear si `partialText.trim()` o
`compositorText.trim()` son no vacíos antes de llamar
`finalizeWithFinalText("Turno completado sin respuesta visible.")`. Si hay
contenido, se llama en su lugar a una variante que solo drena la burbuja
tal cual está (equivalente a `closeWindow()`) sin reemplazar el texto.

Alternativa considerada: agregar un sufijo tipo "(interrumpido)" al texto
existente. Se descarta para la primera iteración por simplicidad — el
usuario ya vio el contenido en vivo mientras se generaba vía las ediciones
XEP-0308 previas; dejarlo tal cual es menos sorprendente que modificarlo
post-hoc con una anotación que el usuario no pidió.

### 2. Guard de reapertura: identidad de turno, no de mensaje
El guard usa la referencia viva a `progressMessageId` dentro del mismo
closure del controller como señal de "hay un turno en curso" — no requiere
tracking de `stanza-id`/`origin-id` cross-proceso. Esto cubre el caso
donde `dispatchReply` es invocado dos veces dentro del mismo proceso para
el mismo mensaje entrante (p.ej. reentrega detectada tarde, antes de que el
turno anterior cerrara), pero NO cubre reprocesamiento tras un reinicio de
proceso completo (ahí `progressMessageId` vuelve a `null` porque el
closure entero se recrea) — ese caso queda para el trabajo de XEP-0198 en
curso.

Alternativa considerada: persistir `progressMessageId` en disco/DB keyed
por turno para sobrevivir reinicios. Rechazada como fuera de alcance de
este change (Non-Goals) — es exactamente el problema que XEP-0198 resuelve
de forma correcta (resumir la sesión de stream en vez de parchear
deduplicación a mano).

### 3. `upload-file`: reutilizar descubrimiento de servicio existente
La ruta entrante (`downloadInboundAttachment` en `src/inbound.ts`) ya
resuelve el host del servicio HTTP Upload del dominio de la cuenta. La
implementación saliente reutiliza esa misma lógica de descubrimiento
(disco#items + disco#info, ver runbook — el servicio suele vivir en un
subdominio `upload.*`, no en el dominio base) en vez de duplicar la
resolución.

## Risks / Trade-offs

- [El guard de reapertura no cubre reinicio de proceso] → Mitigación:
  documentado explícitamente como Non-Goal; el trabajo de XEP-0198 en
  curso lo cubre. No se debe interpretar este change como "arreglo
  completo" de la triplicación.
- [Dejar la burbuja sin finalizar tras un abort forzado puede quedar
  visualmente como "a medias" para el usuario] → Mitigación: es
  preferible a perder el contenido; se documenta como comportamiento
  esperado, no como bug residual.
- [Cambios en `upload-file` tocan código de red/credenciales de subida] →
  Mitigación: camino feliz simple primero, sin manejo especial de
  archivos grandes o multi-adjunto; probar contra el servidor real
  (`upload.hablar.fuentelibre.org`) antes de considerar el fix completo,
  siguiendo el mismo patrón de verificación end-to-end que otros fixes de
  XEP en este repo (no asumir éxito solo porque compila).

## Migration Plan

- Sin cambios de configuración ni de esquema — despliegue es solo código.
- Verificar compilación TypeScript del repo antes de cerrar el change
  (constraint del proyecto).
- Commit en `openclaw-xmpp` primero; luego actualizar el gitlink del
  submódulo en `claudio-w` (`extensions/xmpp`) y reiniciar el servicio
  (`systemctl --user restart claudio-w-openclaw.service`) para probar en
  el servidor real.
- Verificación end-to-end: forzar un turno con tool-call bloqueado (o
  simular `finishWithoutReply` con contenido parcial ya compuesto) y
  confirmar que la burbuja no se pisa; probar `upload-file` con un archivo
  real hacia una cuenta de prueba antes de dar el fix por bueno.

## Open Questions

- ¿El guard de reapertura debería loggear cuando evita una burbuja
  duplicada, para poder medir cuán seguido ocurre este caso vs. el caso de
  reinicio completo que XEP-0198 va a cubrir? (sugerido: sí, un log line
  liviano, decidible en implementación).
