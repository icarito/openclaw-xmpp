## 1. Verificación previa (bloquea el resto)

- [x] 1.1 ~~Confirmar scope operator.admin~~ — ya no aplica: D1 cambió de
      `sessions.patch` (RPC externo) a `patchSessionEntry` (llamada
      in-process del plugin-sdk), que no pasa por chequeo de scope. Ver
      design.md D1 actualizado.
- [x] 1.2 Confirmado indirectamente por 5.3: el ciclo completo
      activación→countdown(~21s)→auto-reversión(~70s) se verificó en
      producción real con el mismo `ActiveEnterTimestamp` antes y después
      (sin restart de por medio), lo que exige que `getSessionEntry`/
      `patchSessionEntry` estén expuestos y que `resolveExecDefaults` relea
      el estado en cada turno -- si no, el bypass no habría tenido efecto
      observable.

## 2. Bypass temporal — servidor (openclaw-xmpp)

- [x] 2.1 Crear `src/approval-bypass.ts` con `buildApprovalBypassAction`,
      siguiendo el patrón de `approval-mode.ts` (autorización vía
      `allowFrom`, mismo estilo de mensajes de confirmación). Mecanismo real
      difiere del design original: usa `resolveAgentRoute` +
      `getSessionEntry`/`patchSessionEntry` (in-process, plugin-sdk), no
      `sessions.patch` por RPC — ver design.md D1 actualizado.
- [x] 2.2 Implementar el estado en memoria del plugin: `Map<sessionKey,
      BypassEntry>` con policy previa, timestamp de expiración y timer
      (`setTimeout`), sin persistencia a disco (design D3).
- [x] 2.3 Implementar `mode=on` (con `minutes`, clamped al máximo
      configurable): lee la policy actual de la sesión, la guarda como
      "previa", patchea la policy relajada, agenda el timer de reversión.
- [x] 2.4 Implementar `mode=off`: revierte inmediatamente a la policy previa
      guardada, cancela el timer, limpia la entrada del mapa.
- [x] 2.5 Implementar `mode=status`: reporta si hay bypass activo para la
      sesión y tiempo restante, sin mutar nada.
- [x] 2.6 Implementar el callback del timer: al expirar, revierte vía
      `revertBypass` (mismo código que usa `mode=off`, sin duplicar lógica).
- [x] 2.7 Registrar el nodo `approval-bypass` en `commands.ts`, junto a
      `approval-mode`.
- [x] 2.8 Default 10 min / máximo 60 min (constantes `DEFAULT_BYPASS_MINUTES`
      / `MAX_BYPASS_MINUTES` en `approval-bypass.ts`) — valores del design.md
      tal cual, no se validó explícitamente con el usuario; ajustar si pide
      otros.
- [x] 2.9 `src/tests/approval-bypass.test.ts`, 7 tests, todos los escenarios
      del spec cubiertos con timers falseados (`vi.useFakeTimers`) y mocks de
      `session-store-runtime`/`routing`. Nota de diseño de test: el `Map`
      `activeBypasses` es estado de módulo sin exportar (por diseño, ver
      header del propio módulo), así que cada test usa una `sessionKey`
      única en vez de resetear el módulo entre tests — mismo aislamiento que
      tendría producción entre dos sesiones reales.

## 3. Fix del fallback de texto — servidor (openclaw-xmpp)

- [x] 3.1 Cambiar `approval-handler.runtime.ts` (`buildXmppPendingPayload`)
      para construir `text` con `buildCompactExecApprovalText`, igual que
      `channel.ts`, en vez de usar `payload.text` crudo del core. Extraído a
      módulo compartido `src/approval-text.ts` (antes vivía solo en
      `channel.ts`) para que ambas rutas usen la misma implementación.
- [x] 3.2 Reforzar `compactApprovalFallbackText` en `send.ts` para eliminar
      bloques de fence triple vacíos (o solo whitespace) como red de
      seguridad independiente de la ruta de origen.
- [x] 3.3 `src/tests/send.test.ts`, 7 tests. Cubre `stripEmptyFencedCodeBlocks`
      y `compactApprovalFallbackText` directamente (ambas exportadas para
      este fin). El escenario "misma ruta nativa vs. forwarder" no se
      re-testea por unidad: ambas rutas ya comparten la misma implementación
      en `approval-text.ts` desde 3.1, así que sería un test de que dos
      llamados al mismo import dan el mismo resultado — no aporta sobre
      testear la función una vez.
- [x] 3.4 Verificación manual (parcial, sin cliente XMPP real disponible
      desde este entorno): confirmado contra `formatFencedCodeBlock` real del
      core vendorizado (`node_modules/openclaw/dist/markdown-code-*.js`,
      `` `${fence}${language}\n${text}\n${fence}` ``) que con `text=""` el
      regex de `stripEmptyFencedCodeBlocks` limpia el bloque correctamente
      (probado con `node -e` contra varios casos, incluyendo el `"sh"` real
      que usa `exec-approval-reply` para "Pending command:"). Verificación
      con cliente real y card en vivo queda pendiente en 5.3
      (producción/claudio-w).

## 4. Verificación TypeScript y checklist de cierre (openclaw-xmpp)

- [x] 4.1 `npx tsc --noEmit`: 27 errores antes y después de este change
      (baseline verificado con `git stash`) — sin regresión. Los archivos
      nuevos (`approval-bypass.ts`, `approval-text.ts`) no producen errores
      propios. Errores preexistentes documentados: mismatches de tipos en
      `approval-handler.runtime.ts` (accountId `null` vs `undefined`, 6
      ocurrencias, ya existían antes de este change), `policy.ts` (exports
      faltantes de `openclaw/plugin-sdk/channel-policy`), `message-adapter.ts`
      (params implícitamente `any`), `monitor.ts`, `telemetry.ts`, y errores
      de variance de Zod en el SDK vendorizado (`schemas-CkRCGSfd.d.ts`) —
      ninguno relacionado con este change. `tsconfig.package-boundary.base.json`
      también falta (error TS5083), preexistente.
- [x] 4.2 Actualizado `PORT-NOTES.md` (dos menciones): el módulo de bypass de
      NanoClaw pasa de "no portado" a "no portado mecánicamente, pero existe
      approval-bypass con diseño distinto" (session store + TTL en memoria,
      no `sessions.patch` — ver design.md D1 actualizado).

## 5. Despliegue a claudio-w

- [x] 5.1 Gitlink actualizado: `openclaw-xmpp` main (`736d5bb`) mergeado en
      `agent/omemo-sce` (commit `7dfa29a`, pusheado), submodule
      `extensions/xmpp` en `claudio-w` apuntando ahí, commiteado como
      `f5b5453` (local, no pusheado a GitHub de claudio-w).
- [x] 5.2 Redeploy ejecutado 2026-07-24 16:05 UTC: árbol de producción
      (`/opt/claudio-w/extensions-xmpp-src/`, NO es checkout git — se
      sincroniza copiando archivos) actualizado con
      `OPERATIONS.md`/`PORT-NOTES.md`/`src/{approval-bypass,approval-text,
      approval-handler.runtime,channel,commands,send}.ts`; backup previo en
      `backups/approval-bypass-20260724160244/`. `systemctl --user restart
      claudio-w-openclaw.service`: arranque limpio, `[gateway] ready` en
      ~12s, 8 cuentas XMPP conectadas, sin errores, parches previos
      re-aplicados sin cambios.
- [x] 5.3 Verificación end-to-end con cuenta mock-approval-a vía `/oc`
      (disco#items no respondió por bare JID sin presencia previa -- ver
      nota abajo; textual fallback sí funcionó): `approval-bypass status`
      inicial → "inactivo"; `on 1` → confirmación con alcance de sesión;
      `status` a los ~21s → "activo, quedan 38s" (aritmética correcta);
      `status` tras >70s → "inactivo" de nuevo, sin restart del gateway en
      el medio (mismo `ActiveEnterTimestamp` antes y después). Ciclo
      completo activación→countdown→auto-reversión confirmado en
      producción real. No verificado en esta pasada: que una card de
      aprobación entregada DURANTE la ventana de bypass efectivamente no
      aparece (requeriría disparar un exec real desde una sesión de agente,
      no solo el comando de chat) -- queda para una prueba futura con un
      comando real.

**Nota para el próximo que use `disco-test.mjs`/scripts similares**: mandar
presencia (`<presence/>`) inmediatamente después de conectar, antes de
enviar el primer mensaje -- sin eso el servidor no entregó el mensaje al
bare JID de destino (sin error visible del lado cliente, simplemente no
llegó respuesta). No se investigó la causa raíz exacta (roster/suscripción
vs. enrutamiento de presence), solo se documenta el workaround que
funcionó.

## 6. Cliente Android (gtk-llm-chat-android, fuera de allowedEditRoots — change/tasks propias en ese repo)

- [x] 6.1 Hecho en `gtk-llm-chat-android` commit `3c116ea`
      (`fix(xmpp): invoke approval-bypass as real ad-hoc command, add popover
      switch`): `setApprovalBypass` usa `executeCommand` con `DataForm`, no
      texto plano. El primer intento (`bc41309`) sí usaba `/oc` como mensaje
      de texto y fue lo que motivó el fix real.
- [x] 6.2 Confirmado en el código actual: `setApprovalBypass(targetJid,
      enabled, minutes = 10)` usa `minutes` en el form (`XmppService.ts`),
      ya no lo descarta.
- [x] 6.3 `getApprovalBypassStatus` agregado en el mismo commit, con poll
      cada 15s mientras el popover está abierto.
- [ ] 6.4 Sin verificar en dispositivo/emulador real desde este entorno de
      agente — declarado explícitamente pendiente en el propio changelog de
      `3c116ea`. **Nota (Fase 2, `xmpp-approval-unified-contract`):**
      `getApprovalBypassStatus` hoy parsea la prosa de respuesta por regex
      (`/activo/i`, `/quedan\s+(\d+)([ms])/i`) — ese parseo se retira en la
      Fase 2 a favor de un campo estructurado XEP-0004. Este `.4` queda
      absorbido ahí, no cerrado acá.

## 7. Cliente GTK (gtk-llm-chat, fuera de allowedEditRoots — change/tasks propias en ese repo)

- [x] 7.1 Hecho en `gtk-llm-chat` commit `c850cc0`
      (`feat(xmpp): add approval bypass switch to sticky card popover`):
      `_set_approval_bypass` descubre el nodo vía disco#items y completa el
      form directo con los valores del switch.
- [x] 7.2 `_query_approval_bypass_status` en el mismo commit, mismo criterio
      que Android (refresca al abrir el popover).
- [ ] 7.3 Sin verificar contra un servidor real desde este entorno de
      agente. Mismo aviso que 6.4: el parseo por regex en
      `_query_approval_bypass_status` (idéntico patrón que Android, en
      Python) se retira en la Fase 2 del programa de paridad
      (`xmpp-approval-unified-contract`), no acá.

## 8. Documentación operativa — allowlist de lectura (no requiere código)

- [x] 8.1 Trasladado a `OPERATIONS.md` (sección "Reducing cards with a
      per-agent read-only allowlist"), con snippet Python reusable
      independiente de claudio-w. Nota: durante esta tarea se encontró que
      `OPERATIONS.md` documentaba `approval-bypass` como un alias simple de
      `approval-mode` (nunca implementado) — se corrigió esa sección para
      describir el mecanismo real (TTL, session-scoped) construido en 2.x.
