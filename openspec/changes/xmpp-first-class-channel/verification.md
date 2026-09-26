# Verificación — xmpp-first-class-channel

## Resultados locales (2026-09-26, rama `xmpp-first-class-channel`)

| Verificación | Baseline | Final | Estado |
|---|---|---|---|
| `npx tsc --noEmit` | 0 errores | 0 errores | ✓ |
| `npx vitest run` | 6 archivos / 36 tests | 22 archivos / 119 tests | ✓ |

Suite nueva por fase: A — spool, dedupe, debounce, burst breaker,
delivery-failure, receipts, carbons, preflight; B — mam, mam-watermark,
history-context, approval-cards; C — hooks-pep, reply-fallback, reactions,
telemetry-real.

## Matriz E2E (pendiente de sesión primaria — requiere servidor real)

Casos que exigen Prosody + cliente real; se ejecutan desde sesión primaria
antes del deploy (tarea 8.5 del change, vía el flujo `xmpp-parity-deployment`):

- [ ] **Kill con salientes pendientes**: matar el proceso del gateway tras
      enviar mensajes sin ack; al arrancar, reenvío único con el mismo
      origin-id y sin turno duplicado en el cliente.
- [ ] **Resume exitoso**: desconexión breve con XEP-0198; los salientes
      cubiertos por `h` no se reenvían.
- [ ] **Reconexión larga offline** (> ventanas de debounce y dentro de la
      retención MAM): catch-up observacional recupera contexto sin crear
      turnos; watermark avanza; no hay duplicados live/MAM/carbons.
- [ ] **Anclaje purgado**: forzar watermark sobre archive-id eliminado
      (retención 1 semana); degradación a fetch-latest con registro.
- [ ] **MUC con replay**: join con `maxstanzas=0` a un room con archivo;
      el replay no genera turnos ni duplicados; catch-up del room vía MAM.
- [ ] **Card huérfana**: kill del proceso con aprobación pendiente; al
      arrancar, cierre XEP-0308 visible, `sessionKey` liberado, arranque
      siguiente sin ruido.
- [ ] **Burst breaker en vivo**: cadena de fallos de entrega hacia un
      destino; breaker pausa, actividad `paused` visible en `status` y PEP,
      aprobaciones siguen saliendo.
- [ ] **Receipts/markers en cliente estándar**: Conversations/Gajim
      confirman `<request xmlns='urn:xmpp:receipts'/>` y markers; parciales
      efímeros sin receipts.
- [ ] **Cliente ad-hoc**: descubrimiento disco#items + ejecución de nodes
      XEP-0050 con forms XEP-0004 siguiendo HOOKS.md; consumo de PEP events
      (activity/approval/progress) desde un cliente externo.
- [ ] **Reacciones XEP-0444**: reacción a card resuelta en DM y en room
      non-anonymous; elisión registrada en room semi-anónimo.
- [ ] **Compatibilidad gtk-llm-chat / Android**: matrix existente del
      programa de paridad (ack, progress, completion, cancel, stale
      approval) sin regresiones.

## Riesgos conocidos heredados de los informes de fase

- Si `@xmpp/stream-management` consume `<resumed>` antes del listener del
  plugin, el `h` del resume se pierde y se cae al reenvío por spool
  (idempotente por origin-id, nunca pérdida).
- `decideArchiveReplay` degrada solo ante `item-not-found`; un servidor que
  responda página vacía ante anclaje muerto no dispara el degrade.
- Watermark/contexto persisten por mensaje (write amplification tmp+rename);
  optimizable con batching si se observa costo real.
- Reacciones en rooms anónimos y `<reply/>` bajo OMEMO quedan fuera por
  diseño (documentado en HOOKS.md/PORT-NOTES.md).
