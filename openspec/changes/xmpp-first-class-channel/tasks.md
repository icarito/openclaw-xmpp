## 1. Base: verificación, config y preflight

- [x] 1.1 Agregar script `test` (vitest) a `package.json` y correr la
      suite existente (`src/tests/*.test.ts`) como línea base verde
- [x] 1.2 `src/config-schema.ts` + `src/types.ts` + `config-ui-hints.ts`:
      secciones `reliability` (debounce, burstBreaker, spool),
      `history` (catchup, window, maxPages, mucMaxStanzas),
      `hooks` (pep events, reactions, receipts) con defaults del design
- [x] 1.3 Preflight disco por cuenta (disco#info de bare JID y MUC domain):
      detección `urn:xmpp:mam:2`, caché del resultado y exposición del
      estado para el node `status`
- [x] 1.4 Registrar los errores SDK pre-existentes de `npx tsc --noEmit`
      como baseline para distinguir regresiones nuevas

## 2. Fase A — Spool de salientes y XEP-0198

- [x] 2.1 Nuevo `src/outbound-spool.ts`: cola persistente por cuenta
      (tmp+rename atómico, mismo patrón que el dedupe de entrada) con
      enqueue/ack/requeue/dead-letter y expiración config
- [x] 2.2 `src/client.ts`: suscripción a eventos SM (`resumed`, `failed`,
      acks) y marcado de reconocidos según contador `h` del servidor
- [x] 2.3 Reenvío de no-reconocidos al `online`/resume-fallido con backoff
      y tope, preservando hints XEP-0334 y carbons (sin regresión)
- [x] 2.4 Tests: proceso reiniciado con pendientes → reenvío único; resume
      exitoso con `h` → sin reenvío; carbons activos → `<sent/>` ignorada

## 3. Fase A — Anti-fuga de tokens

- [x] 3.1 Debounce de entrada por remitente (ventana config, fusión de
      texto+adjuntos, compatible con `steer` y menciones MUC)
- [x] 3.2 Dedupe durable de despacho en plugin state (claims con TTL 7d,
      rollback de claims comprometidos, duplicate-commit = fatal)
- [x] 3.3 Burst breaker de salida por destino (turnos/mensajes por ventana,
      actividad `paused` al tripular, lane de control/aprobaciones exenta,
      turno final jamás descartado)
- [x] 3.4 Clasificación de fallos de entrega (retryable/fatal/duplicate)
      con dead-letter y visibilidad en node `status`
- [x] 3.5 Tests: ráfaga fusionada; replay post-reinicio sin turno doble;
      cadena de fallos que auto-se frena; aprobación envía con breaker
      activo

## 4. Fase A — Receipts y markers

- [x] 4.1 XEP-0184: `<request/>` en finales durables (DM y MUC), respuesta
      a receipts recibidos y ack del spool por receipt
- [x] 4.2 XEP-0333: markers `received`/`displayed` hacia el remitente al
      procesar; jamás en parciales efímeros
- [x] 4.3 Tests de forma de stanza (request/received/marker) y de que las
      ediciones con `<no-store/>` no los incluyen

## 5. Fase B — MAM y catch-up

- [x] 5.1 Nuevo `src/mam.ts`: query IQ-set con form XEP-0004, paginación
      RSM XEP-0059, lectura de archive-id XEP-0359, tope de páginas/query
- [x] 5.2 Watermark persistente por cuenta y por room (último archive-id
      visto, actualizado en vivo y en catch-up)
- [x] 5.3 Catch-up en reconexión: modo observacional (contexto, no
      turnos), ventana máxima config, degrade a fetch-latest si el anclaje
      fue purgado, registro del degrade
- [x] 5.4 MUC: join con `maxstanzas=0` (o config) + catch-up del room por
      MAM respetando watermark
- [x] 5.5 Reconfigurar guard XEP-0203: con MAM, descarte por dedupe de
      archive-id (guard 5 min como red de seguridad); sin MAM, guard
      actual intacto
- [x] 5.6 Tests: watermark sin gaps; replay offline como contexto;
      anclaje purgado → fetch-latest; join MUC sin procesar replay;
      delayed stanza cubierta descartada por dedupe

## 6. Fase B — Aprobaciones e historial

- [x] 6.1 Persistir registro de cards activas (stanza-id, sessionKey,
      expiry, JID destino, nodo `cmd:*`) en plugin state
- [x] 6.2 Reconciliación al arranque: cards que cruzaron un reinicio se
      cierran con XEP-0308 ("expirada/reconciliada"), liberan `sessionKey`
      y el contador de reconciliadas queda en logs; arranque limpio sin
      ruido
- [x] 6.3 Tests: kill con aprobación pendiente → cierre visible y slot
      liberado; arranque sin huérfanas sin correcciones

## 7. Fase C — Hooks para clientes ad-hoc

- [x] 7.1 Nuevo `src/hooks/pep-events.ts`: nodos PEP versionados
      (`activity`, `approval`, `progress`) con payload JSON estructurado y
      modelo de acceso respetando `allowFrom`
- [x] 7.2 Cableado: actividad (activity-registry), aprobaciones (crear /
      resolver / expirar) y progreso (inicio/fin de turno) publican
      eventos
- [x] 7.3 Read-side de telemetría real vía node `credit` (retirar el stub
      `readTelemetryStub`)
- [x] 7.4 XEP-0461 saliente: `<reply/>` + `<fallback/>` XEP-0428 en
      respuestas durables a un mensaje entrante
- [x] 7.5 XEP-0444: reacciones opt-in (`hooks.reactions`), DM siempre,
      MUC solo non-anonymous, reacciones entrantes ignoradas sin turno
- [x] 7.6 Tests: formas de stanza (reply/fallback, reactions), eventos PEP
      con sessionKey/estado, gate de room semi-anónimo

## 8. Documentación y verificación

- [x] 8.1 `HOOKS.md`: contrato completo de la superficie (nodes, forms,
      `expires-at-ms`, MAM para historial, PEP events) con stanzas de
      ejemplo por operación
- [x] 8.2 `OPERATIONS.md`: requisitos de servidor (`mod_mam`, retención),
      flags nuevos y cómo degradan; `PORT-NOTES.md` actualizado
- [x] 8.3 `npx tsc --noEmit`: sin errores nuevos respecto al baseline 1.4
- [x] 8.4 Suite vitest verde incluyendo los tests nuevos
- [x] 8.5 Plan de verificación E2E con cuentas mock (kill con salientes
      pendientes, reconexión larga offline, replay MUC, card huérfana)
      documentado con resultados; los casos que requieran servidor
      quedan marcados como pendientes de sesión primaria
      (→ `verification.md` en este change)
- [ ] 8.6 Nota en el change para claudio-w: actualizar la fila del
      programa XMPP↔Telegram en `openspec/ROADMAP.md` tras el apply
      (el deploy y el bump del gitlink son fases posteriores de sesión
      primaria, fuera de este change)
