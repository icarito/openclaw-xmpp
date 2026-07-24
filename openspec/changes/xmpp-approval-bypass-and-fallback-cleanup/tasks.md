## 1. Verificación previa (bloquea el resto)

- [x] 1.1 ~~Confirmar scope operator.admin~~ — ya no aplica: D1 cambió de
      `sessions.patch` (RPC externo) a `patchSessionEntry` (llamada
      in-process del plugin-sdk), que no pasa por chequeo de scope. Ver
      design.md D1 actualizado.
- [ ] 1.2 Confirmar en el bundle real desplegado (no solo en la copia de
      desarrollo `extensions/xmpp/node_modules/openclaw/dist`) que
      `resolveExecDefaults` efectivamente relee el estado de sesión en cada
      turno, y que `getSessionEntry`/`patchSessionEntry` están expuestos con
      esos campos en la versión de OpenClaw corriendo en producción.

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
- [ ] 2.9 Escribir/actualizar tests del plugin cubriendo los escenarios de
      `specs/xmpp-approval-bypass/spec.md` (activación, auto-reversión —
      con timers falseados/mockeados, desactivación manual, status, clamp de
      máximo, sender no autorizado).

## 3. Fix del fallback de texto — servidor (openclaw-xmpp)

- [x] 3.1 Cambiar `approval-handler.runtime.ts` (`buildXmppPendingPayload`)
      para construir `text` con `buildCompactExecApprovalText`, igual que
      `channel.ts`, en vez de usar `payload.text` crudo del core. Extraído a
      módulo compartido `src/approval-text.ts` (antes vivía solo en
      `channel.ts`) para que ambas rutas usen la misma implementación.
- [x] 3.2 Reforzar `compactApprovalFallbackText` en `send.ts` para eliminar
      bloques de fence triple vacíos (o solo whitespace) como red de
      seguridad independiente de la ruta de origen.
- [ ] 3.3 Escribir/actualizar tests cubriendo los escenarios de
      `specs/xmpp-approval-fallback-text/spec.md` (ambas rutas producen el
      mismo texto compacto; fences vacíos se eliminan; fences con contenido
      real se preservan).
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

## 5. Despliegue a claudio-w (fuera de este repo, coordinar aparte)

- [ ] 5.1 Actualizar el gitlink del submodule `extensions/xmpp` en
      `claudio-w` al commit que incluye este change.
- [ ] 5.2 Redeploy de `claudio-w-openclaw.service`.
- [ ] 5.3 Verificación end-to-end en producción: activar bypass desde un
      cliente real, confirmar `status` con tiempo restante, confirmar
      auto-reversión sin restart, confirmar que una card de aprobación
      entregada durante la ventana de bypass no aparece (o si el reviewer
      igual la genera por algún otro motivo, investigar por separado).

## 6. Cliente Android (gtk-llm-chat-android, fuera de allowedEditRoots — change/tasks propias en ese repo)

- [ ] 6.1 Cambiar `XmppService.setApprovalBypass` para ejecutar el comando
      ad-hoc `approval-bypass` descubierto vía disco#items (mismo camino de
      ejecución que el resto de comandos nativos), no un mensaje de texto
      `/oc approval-bypass on|off`.
- [ ] 6.2 Usar el parámetro `_minutes` (hoy descartado en
      `XmppService.ts:2753`) como valor real enviado al comando.
- [ ] 6.3 Reflejar en la UI el `status`/tiempo restante devuelto por el
      servidor, con consulta periódica mientras el switch está activo, para
      que el switch no quede "prendido" tras expirar solo del lado servidor.
- [ ] 6.4 Probar en un dispositivo/emulador real contra el gateway de
      desarrollo antes de considerar el fix cerrado.

## 7. Cliente GTK (gtk-llm-chat, fuera de allowedEditRoots — change/tasks propias en ese repo)

- [ ] 7.1 Agregar el switch de bypass en el panel expandido de la sticky
      card (equivalente al que ya existe en Android), invocando el comando
      `approval-bypass` descubierto dinámicamente.
- [ ] 7.2 Reflejar `status`/tiempo restante igual que en Android (punto
      6.3), para consistencia entre clientes.
- [ ] 7.3 Verificar que el dead code de categorización de menú en
      `agent_commands_sidebar.py:34` (prefijo `approval-bypass`) ahora sí
      matchea el nodo real anunciado por el servidor, y se comporta bien en
      el menú de comandos existente.

## 8. Documentación operativa — allowlist de lectura (no requiere código)

- [x] 8.1 Trasladado a `OPERATIONS.md` (sección "Reducing cards with a
      per-agent read-only allowlist"), con snippet Python reusable
      independiente de claudio-w. Nota: durante esta tarea se encontró que
      `OPERATIONS.md` documentaba `approval-bypass` como un alias simple de
      `approval-mode` (nunca implementado) — se corrigió esa sección para
      describir el mecanismo real (TTL, session-scoped) construido en 2.x.
