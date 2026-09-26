# xmpp-first-class-channel

## Why

El plugin XMPP pierde mensajes en casos concretos (sin MAM, sin acuses
fin‑a‑fin, descarte de stanzas retrasadas >5 min, sin spool de salida
persistente) y carece de paridad con el plugin de Telegram de OpenClaw en
historial, dedupe durable y protección anti‑fuga de tokens (los incidentes
`nanoclaw_402_loop_jul12` y el burn de 2.9M tokens del avatar nacieron de
cadenas de reintento sin clasificación de fallo). Además, la superficie para
clientes externos (gtk‑llm‑chat, gtk‑llm‑chat‑android, clientes ad‑hoc) está
dispersa entre nodes XEP‑0050, un namespace temporal de botones y un read‑side
de telemetría stub, sin contrato documentado ni eventos PEP consultables.
La investigación de alternativas (plugins comunitarios de OpenClaw y stacks
XMPP externos) confirma que ningún competidor cubre lo ya construido aquí
(cards de aprobación XEP‑0050, elevated session, streaming de progreso,
OMEMO dual, contrato con los clientes GTK), así que la vía correcta es
endurecer y extender este plugin, no migrar.

## What Changes

- **Fiabilidad de entrega (XEP‑0198 completo)**: manejo explícito de
  `resumed`/`failed`/`r`/`a`, spool persistente de mensajes salientes no
  reconocidos con reenvío al resumir/reconectar, clasificación de fallos de
  entrega (evita cadenas de reintento que queman tokens).
- **Anti‑fuga de tokens**: burst breaker de salida por destino (límite de
  turnos/mensajes por ventana), debounce de entrada estilo Telegram (ráfagas →
  un turno sintético), spool durable de entrada con claims/tombstones,
  dedupe persistente de despacho con TTL (baseline XEP‑0359).
- **Historial (XEP‑0313 MAM)**: catch‑up de mensajes en DM y MUC tras
  reconexión/reinicio usando archive‑ids estables (XEP‑0359) con RSM
  (XEP‑0059), control de historial al entrar a MUC, degradación a
  fetch‑latest si el anclaje expiró, e integración con el guard de stanzas
  retrasadas (reemplaza el corte ciego de 5 min por "todo lo no visto desde
  el último ack").
- **Acuses de recibo estándar**: solicitud/envío de receipts XEP‑0184 y
  chat markers XEP‑0333 salientes para que clientes estándar confirmen
  lectura/entrega de las respuestas del agente.
- **Hooks para clientes ad‑hoc**: contrato documentado de la superficie
  XEP‑0050 (nodes, forms XEP‑0004, expiración `expires-at-ms`), nodos PEP
  (XEP‑0060/XEP‑0163) con eventos estructurados de actividad/aprobación/progreso
  consultables por cualquier cliente, cierre del read‑side de telemetría,
  respuestas XEP‑0461 salientes y reacciones XEP‑0444.
- **Aprobaciones**: reconciliación local de cards huérfanas al arranque
  (cierre visible vía XEP‑0308 sin depender de endpoints inexistentes del
  SDK), y estado de expiración consultable vía MAM/PEP.

## Capabilities

### New Capabilities

- `xmpp-delivery-reliability`: acks XEP‑0198 con reenvío de salientes no
  reconocidos, receipts XEP‑0184, markers XEP‑0333, burst breaker, debounce
  de entrada y dedupe durable de despacho.
- `xmpp-history-mam`: recuperación de historial vía XEP‑0313 (DM y MUC),
  dedupe por archive‑id XEP‑0359, control de historial MUC y catch‑up de
  reconexión sin convertir replay en turnos.
- `xmpp-client-hooks`: superficie estándar para clientes ad‑hoc: contrato
  XEP‑0050/XEP‑0004 documentado, eventos PEP estructurados, telemetría
  legible, XEP‑0461 replies y XEP‑0444 reactions.

### Modified Capabilities

- `xmpp-omemo-sm-carbons`: el requisito de XEP‑0198 pasa de "soporte a nivel
  de librería con semilla en memoria" a manejo completo de acks/resume con
  spool de salientes no reconocidos; las seeds `lastStreamIds` dejan de ser
  el único mecanismo de resume.

## Impact

- **Código**: `src/client.ts` (eventos SM, features), `src/monitor.ts`
  (catch‑up, dedupe, spool), `src/send.ts` (receipts, markers, spool de
  salientes, burst breaker), `src/protocol.ts` (XEP‑0359, XEP‑0333,
  XEP‑0461 parse/build), `src/progress.ts` (eventos PEP), nuevos módulos
  `src/mam.ts`, `src/outbound-spool.ts`, `src/hooks/`.
- **Config**: `src/config-schema.ts` (secciones `reliability`, `history`,
  `hooks`), tipos y `config-ui-hints.ts`.
- **Servidor**: requiere `mod_mam` en Prosody (disco preflight; el plugin
  degrada con aviso si el host no archiva); los módulos
  `mod_expo_push`/`mod_push_hints_filter` ya desplegados se respetan
  (hints `<no-store/>` siguen evitando archivar parciales).
- **Clientes**: gtk‑llm‑chat y gtk‑llm‑chat‑android ganan la superficie de
  hooks (documentada en `HOOKS.md`); sin breaking changes en el contrato
  existente de aprobaciones (XEP‑0004 `type="result"` se mantiene).
- **Riesgo controlado**: todo el catch‑up de historial es fail‑closed —
  si MAM no está disponible o falla, el comportamiento actual (guard de
  delay + dedupe) permanece como fallback.
