#!/usr/bin/env python3
"""
Re-aplica parches locales sobre el bundle dist de OpenClaw.

Paridad de aprobaciones para el canal XMPP. Sin estos parches el canal XMPP
funciona, pero las cards de exec-approval usan el camino asíncrono (frágil) y
el timeout es de 30 min en vez de 5. Ver `INSTALL.md` §6 y el README de esta
carpeta.

Sostenible frente a `npm i -g openclaw` / upgrades: se corre en el arranque del
servicio (ExecStartPre) y localiza los archivos dist POR CONTENIDO, no por su
nombre hasheado (que cambia entre builds). Cada parche es idempotente: si ya
está aplicado, no hace nada; si el bloque original no aparece (upstream cambió
la forma), avisa y sigue sin romper el arranque.

Rutas y versión objetivo parametrizables por entorno (con defaults de la
instalación de referencia claudio-w):
  OPENCLAW_DIST              directorio dist del paquete openclaw instalado
  OPENCLAW_PACKAGE_JSON      package.json del paquete openclaw instalado
  OPENCLAW_AGENTS_DIR        $STATE/agents (para la purga de sesiones de canal)
  EXPECTED_OPENCLAW_VERSION  versión de openclaw contra la que se verificaron
                             los anchors; el precheck falla cerrado si no coincide

Detalle por parche: dentro del propio archivo, y en `INSTALL.md` §6.
"""
import glob
import json
import os
import subprocess
import sys
import time

# Defaults de la instalación de referencia (claudio-w). Sobrescribibles por
# entorno para reutilizar el script en cualquier OpenClaw estándar:
#   OPENCLAW_DIST=$(npm root -g)/openclaw/dist
#   OPENCLAW_AGENTS_DIR=$OPENCLAW_STATE_DIR/agents
_DEFAULT_OPENCLAW_ROOT = "/opt/claudio-w/npm-global/lib/node_modules/openclaw"
DIST = os.environ.get("OPENCLAW_DIST", f"{_DEFAULT_OPENCLAW_ROOT}/dist")
OPENCLAW_PACKAGE_JSON = os.environ.get(
    "OPENCLAW_PACKAGE_JSON", f"{_DEFAULT_OPENCLAW_ROOT}/package.json"
)
AGENTS_DIR = os.environ.get(
    "OPENCLAW_AGENTS_DIR", "/opt/claudio-w/openclaw-home/agents"
)

# Versión de `openclaw` contra la que estos 13 parches fueron verificados
# (anchors localizados por contenido en el dist correspondiente a esta
# versión). Un `npm i -g openclaw` que cambie de versión puede mover o
# reescribir el código que los anchors buscan sin que find_file() lo note
# como error — simplemente vería 0 candidatos y seguiría, dejando parches
# críticos sin aplicar en silencio. El precheck falla cerrado si la versión
# instalada no coincide, en vez de confiar en que el conteo final de
# "N no evaluados" sea revisado a tiempo.
EXPECTED_OPENCLAW_VERSION = os.environ.get(
    "EXPECTED_OPENCLAW_VERSION", "2026.7.35"
)


def installed_openclaw_version():
    try:
        with open(OPENCLAW_PACKAGE_JSON, encoding="utf-8") as fh:
            return json.load(fh).get("version")
    except (OSError, ValueError):
        return None

# Una sesión de canal XMPP directa se considera huérfana y se purga si su
# sessionId difiere del de la sesión main del agente Y lleva inactiva más de
# este umbral. Las sesiones de canal se regeneran con id nuevo en cada
# reconexión XMPP; los approvals viejos quedan anclados al id anterior y se
# descartan ("rebound") al aprobarse tarde. Purgarlas en cada arranque evita
# que ese estado muerto se acumule. El umbral protege una sesión activa en
# curso (que compartiría o alcanzaría el id de main pronto).
ORPHAN_CHANNEL_IDLE_MIN = 30


def purge_orphan_channel_sessions():
    """Elimina sesiones de canal xmpp:...:direct:... huérfanas de cada agente.

    Huérfana = sessionId distinto del de agent:<id>:main e inactiva
    >ORPHAN_CHANNEL_IDLE_MIN. Hace backup antes de reescribir. Nunca borra la
    sesión main. Fail-safe: cualquier error en un agente se salta sin abortar.
    """
    now_ms = time.time() * 1000
    total = 0
    for path in glob.glob(f"{AGENTS_DIR}/*/sessions/sessions.json"):
        try:
            with open(path, encoding="utf-8") as fh:
                sessions = json.load(fh)
        except (OSError, ValueError):
            continue
        main_key = next((k for k in sessions if k.endswith(":main")), None)
        main_id = (sessions.get(main_key, {}) or {}).get("sessionId") if main_key else None
        victims = []
        for key, entry in list(sessions.items()):
            if ":xmpp:" not in key or ":direct:" not in key:
                continue
            sid = (entry or {}).get("sessionId")
            idle_min = (now_ms - ((entry or {}).get("updatedAt") or 0)) / 60000
            # Purga solo si diverge de main y está inactiva; si por lo que sea
            # comparte el id de main, no la toques.
            if sid != main_id and idle_min >= ORPHAN_CHANNEL_IDLE_MIN:
                victims.append(key)
        if not victims:
            continue
        try:
            subprocess.run(["cp", path, path + ".bak-orphan-purge"], check=False)
            for key in victims:
                sessions.pop(key, None)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(sessions, fh, indent=2)
            agent = os.path.basename(os.path.dirname(os.path.dirname(path)))
            print(f"  ~ purge: {agent} -> {len(victims)} sesión(es) de canal huérfana(s)",
                  flush=True)
            total += len(victims)
        except OSError as err:
            print(f"  ! purge fallo en {path}: {err}", flush=True)
    if total == 0:
        print("  = purge: sin sesiones de canal huérfanas", flush=True)
    return total


def find_file(name, old_block, applied_mark):
    """Único .js del dist donde este parche corresponde: contiene el bloque
    original SIN parchear, o ya la marca de aplicado. Devuelve (path, src,
    already_applied). None si 0 o >1 candidatos.

    El caso de 0 candidatos NO es lo mismo que "ya aplicado": significa que ni
    el bloque original ni la marca de aplicado aparecen en ningún archivo del
    dist, típicamente porque upstream cambió esa zona del código y el anchor
    quedó obsoleto (ver el caso "single-pending-approval", retirado 2026-07-20
    tras un día reportando "sin cambios" sobre un parche que en realidad no
    tenía dónde aplicarse). Por eso este caso se imprime con el nombre del
    parche y se cuenta aparte en el resumen de main(), no se descarta en
    silencio."""
    hits = []
    for path in glob.glob(f"{DIST}/*.js"):
        if ".bak" in path or ".patch-tmp" in path:
            continue
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                src = fh.read()
        except OSError:
            continue
        applied = applied_mark in src
        if old_block in src or applied:
            hits.append((path, src, applied))
    if len(hits) == 1:
        return hits[0]
    if len(hits) == 0:
        print(f"  ! {name}: sin candidato en el dist (anchor obsoleto o ya "
              f"no aplica); NO reportar como \"al día\"", flush=True)
    else:
        print(f"  ! {name}: matchea {len(hits)} archivos; salto", flush=True)
    return None


# --- Parche 1: gateway preflight guard --------------------------------------
GW_MARKER = "Dropping stale exec approval followup"
GW_APPLIED_MARK = "agentIdForMain"
GW_OLD = (
    "let currentSessionId;\n"
    "\t\t\ttry {\n"
    "\t\t\t\tcurrentSessionId = normalizeOptionalString(loadSessionEntry(requestedSessionKeyRaw).entry?.sessionId);\n"
    "\t\t\t} catch {\n"
    "\t\t\t\tcurrentSessionId = void 0;\n"
    "\t\t\t}\n"
    "\t\t\tif (isExecApprovalFollowupSessionRebound({\n"
    "\t\t\t\texpectedSessionId,\n"
    "\t\t\t\tresolvedSessionId: currentSessionId\n"
    "\t\t\t}))"
)
GW_NEW = (
    "let currentSessionId;\n"
    "\t\t\tlet reboundKnownIds = [];\n"
    "\t\t\ttry {\n"
    "\t\t\t\tconst loadedForRebound = loadSessionEntry(requestedSessionKeyRaw);\n"
    "\t\t\t\tcurrentSessionId = normalizeOptionalString(loadedForRebound.entry?.sessionId);\n"
    "\t\t\t\treboundKnownIds = (loadedForRebound.storeKeys ?? []).map((k) => normalizeOptionalString(loadedForRebound.store?.[k]?.sessionId)).filter(Boolean);\n"
    "\t\t\t\tconst agentIdForMain = agentId || resolveAgentIdFromSessionKey(requestedSessionKeyRaw);\n"
    "\t\t\t\tif (agentIdForMain) {\n"
    "\t\t\t\t\tconst mainKey = resolveAgentMainSessionKey({ cfg, agentId: agentIdForMain });\n"
    "\t\t\t\t\tconst loadedMainForRebound = loadSessionEntry(mainKey, { agentId: agentIdForMain, clone: false });\n"
    "\t\t\t\t\tconst mainSessionId = normalizeOptionalString(loadedMainForRebound.entry?.sessionId);\n"
    "\t\t\t\t\tif (mainSessionId) reboundKnownIds.push(mainSessionId);\n"
    "\t\t\t\t\treboundKnownIds = (loadedMainForRebound.storeKeys ?? []).map((k) => normalizeOptionalString(loadedMainForRebound.store?.[k]?.sessionId)).filter(Boolean).concat(reboundKnownIds);\n"
    "\t\t\t\t}\n"
    "\t\t\t} catch {\n"
    "\t\t\t\tcurrentSessionId = void 0;\n"
    "\t\t\t}\n"
    "\t\t\tif (!(expectedSessionId && reboundKnownIds.includes(expectedSessionId)) && isExecApprovalFollowupSessionRebound({\n"
    "\t\t\t\texpectedSessionId,\n"
    "\t\t\t\tresolvedSessionId: currentSessionId\n"
    "\t\t\t}))"
)

# --- Parche 2: direct-delivery guard ----------------------------------------
DD_APPLIED_MARK = 'agentIdForKey ? normalizeOptionalString(storeForKey?.["agent:" + agentIdForKey + ":main"]'
DD_OLD = (
    "\ttry {\n"
    "\t\treturn isExecApprovalFollowupSessionRebound({\n"
    "\t\t\texpectedSessionId,\n"
    "\t\t\tresolvedSessionId: normalizeOptionalString(loadSessionStore(resolveStorePath(normalizeOptionalString(params.sessionStore), { agentId: resolveAgentIdFromSessionKey(sessionKey) }))?.[sessionKey]?.sessionId)\n"
    "\t\t});\n"
    "\t} catch (err) {"
)
DD_NEW = (
    "\ttry {\n"
    "\t\tconst agentIdForKey = resolveAgentIdFromSessionKey(sessionKey);\n"
    "\t\tconst storeForKey = loadSessionStore(resolveStorePath(normalizeOptionalString(params.sessionStore), { agentId: agentIdForKey }));\n"
    "\t\tconst knownIds = [\n"
    "\t\t\tnormalizeOptionalString(storeForKey?.[sessionKey]?.sessionId),\n"
    "\t\t\tagentIdForKey ? normalizeOptionalString(storeForKey?.[\"agent:\" + agentIdForKey + \":main\"]?.sessionId) : void 0\n"
    "\t\t].filter(Boolean);\n"
    "\t\tif (expectedSessionId && knownIds.includes(expectedSessionId)) return false;\n"
    "\t\treturn isExecApprovalFollowupSessionRebound({\n"
    "\t\t\texpectedSessionId,\n"
    "\t\t\tresolvedSessionId: knownIds[0]\n"
    "\t\t});\n"
    "\t} catch (err) {"
)

# --- Parche 3: clave canónica para followups async --------------------------
# createExecTool conservaba defaults.sessionKey sin aplicar eventRouting. En
# DMs XMPP con dmScope=main esa clave puede ser la clave directa de ejecución,
# aunque el turno humano viva en agent:<id>:main. El completion aprobado abría
# entonces una segunda transcripción sin contexto. Respeta la política ya
# calculada por agent-tools y colapsa únicamente cuando no hay una excepción de
# binding que pida preservar la sesión directa.
FOLLOWUP_ROUTE_APPLIED_MARK = "rawNotifySessionKey"
FOLLOWUP_ROUTE_OLD = (
    "\tconst notifySessionKey = normalizeOptionalString(defaults?.sessionKey);"
)
FOLLOWUP_ROUTE_NEW = (
    "\tconst rawNotifySessionKey = normalizeOptionalString(defaults?.sessionKey);\n"
    "\tconst notifySessionAgentId = rawNotifySessionKey ? resolveAgentIdFromSessionKey(rawNotifySessionKey) : void 0;\n"
    "\tconst notifySessionKey = rawNotifySessionKey && defaults?.eventRouting?.dmScope === \"main\" && defaults.eventRouting.preserveSessionKey !== true && notifySessionAgentId ? \"agent:\" + notifySessionAgentId + \":\" + (defaults.eventRouting.mainKey || \"main\") : rawNotifySessionKey;"
)

# --- Parche 4: una sola aprobación pendiente por turno ----------------------
# El modelo interpretaba approval-pending como permiso para seguir explorando
# y llegó a abrir >10 approvals antes de esperar la primera decisión. Cada una
# generaba luego un followup independiente y una tormenta de mensajes. La guía
# del system prompt debe convertir approval-pending en barrera explícita.
APPROVAL_STOP_APPLIED_MARK = "STOP the turn immediately. Do not call any other tool"
APPROVAL_STOP_OLD = (
    'return "If exec returns approval-pending, use native approval card/buttons first. '
    'Include a plain /approve command only when the tool says chat/manual approval is required; '
    'copy the exact command from \\"Reply with:\\".";'
)
APPROVAL_STOP_NEW = (
    'return "If exec returns approval-pending, STOP the turn immediately. Do not call any other tool '
    'and do not create another approval until this decision completes. Use native approval card/buttons first; '
    'include plain /approve only when chat/manual approval is required.";'
)

# --- Parche 5: RETIRADO 2026-07-20 — premisa refutada, ver abajo ------------
# Historia: nació el 2026-07-19 como guard (una sola aprobación pendiente por
# sesión, para evitar la Promise huérfana de dos exec paralelos). Horas
# después se re-declaró como REVERSIÓN de ese mismo guard ("upstream permite N
# aprobaciones pendientes"), tras un incidente donde su re-aplicación nocturna
# rechazaba tool calls exec paralelos legítimos.
#
# Verificado 2026-07-20 contra el bundle desplegado (openclaw 2026.7.1):
# - SINGLE_APPROVAL_REVERT_OLD (el guard "existingSessionApproval" a revertir)
#   NO EXISTE en el dist actual. find_file() no encuentra candidato, salta en
#   silencio, y el resumen final de main() decía "sin cambios (todo al día)"
#   como si este parche no tuviera nada pendiente — un falso negativo.
# - SINGLE_APPROVAL_REVERT_APPLIED_MARK ("approval id already pending") SÍ
#   existe, pero pertenece a código upstream no relacionado (el dedup por
#   explicitId, unas líneas antes del guard real). Por eso el script podía
#   creer "ya aplicado" sobre un archivo que nunca tocó.
# - La premisa "upstream permite N aprobaciones pendientes" es FALSA hoy:
#   upstream sigue limitando a una por sesión (sessionApprovalMergeKey), solo
#   que devuelve un toolResult "Exec paused... retry" en vez de un error duro.
#   Es decir, el guard que este parche pretendía revertir ya no existe en esa
#   forma — upstream lo reemplazó, no lo quitó.
#
# Con la premisa original y la de reversión ambas obsoletas, no hay nada que
# aplicar ni que revertir aquí: el límite vive en el core y es correcto
# dejarlo. El guard adicional de este plugin (activeSessionApprovals en
# approval-handler.runtime.ts) sigue existiendo para la carrera residual que
# el guard del core no cubre (dos approvals llegando a deliverPending antes de
# que el core registre la primera); ese SÍ ahora avisa al usuario en vez de
# tragarse el rechazo en silencio — ver commit c8e0052 de openclaw-xmpp.
#
# Esta entrada se retira de PATCHES, no se deja como no-op: un no-op fallando
# en silencio fue exactamente el problema que este comentario documenta.

# --- Parche 6: breaker de ráfaga de followups async -------------------------
# Auditoría 2026-07-18: cadenas exec→followup→exec de comandos auto-aprobados
# (whitelist) re-despiertan al agente con contexto completo cada ~5s sin que
# loopDetection intervenga (los resultados nunca son idénticos). Caso odiseo
# 2026-07-17: 35 followups en 3 min ≈ 2.9M tokens. Ventana deslizante por
# sessionKey: al 5º followup en 10 min se inyecta una orden de cierre en el
# prompt; sobre el 8º se suprime el despertar (queda log.warn greppeable:
# "Suppressing exec approval followup burst").
FOLLOWUP_BURST_APPLIED_MARK = "noteExecFollowupBurst"
FOLLOWUP_BURST_OLD = (
    "async function sendExecApprovalFollowup(params) {\n"
    "\tconst sessionKey = params.sessionKey?.trim();\n"
    "\tconst resultText = params.resultText.trim();\n"
    "\tif (!resultText) return false;\n"
)
FOLLOWUP_BURST_NEW = (
    "const EXEC_FOLLOWUP_BURST_WINDOW_MS = 6e5;\n"
    "const EXEC_FOLLOWUP_BURST_WARN = 5;\n"
    "const EXEC_FOLLOWUP_BURST_MAX = 8;\n"
    "const execFollowupBurstStamps = new Map();\n"
    "function noteExecFollowupBurst(sessionKey) {\n"
    "\tconst now = Date.now();\n"
    "\tconst stamps = (execFollowupBurstStamps.get(sessionKey) ?? []).filter((t) => now - t < EXEC_FOLLOWUP_BURST_WINDOW_MS);\n"
    "\tstamps.push(now);\n"
    "\texecFollowupBurstStamps.set(sessionKey, stamps);\n"
    "\treturn stamps.length;\n"
    "}\n"
    "async function sendExecApprovalFollowup(params) {\n"
    "\tconst sessionKey = params.sessionKey?.trim();\n"
    "\tlet resultText = params.resultText.trim();\n"
    "\tif (!resultText) return false;\n"
    "\tif (sessionKey) {\n"
    "\t\tconst burstCount = noteExecFollowupBurst(sessionKey);\n"
    "\t\tif (burstCount > EXEC_FOLLOWUP_BURST_MAX) {\n"
    "\t\t\tlog.warn(`Suppressing exec approval followup burst for ${sessionKey} (${burstCount} in 10min window)`);\n"
    "\t\t\treturn false;\n"
    "\t\t}\n"
    "\t\tif (burstCount >= EXEC_FOLLOWUP_BURST_WARN) resultText += \"\\n\\n[gateway guard] This session has received \" + burstCount + \" async command completions in the last 10 minutes. Stop launching commands, summarize progress so far, and reply to the user now.\";\n"
    "\t}\n"
)

# --- Parche 7: workspaces de la flota en los media roots ---------------------
# CAUSA REAL de "Local media path is not under an allowed directory" con
# archivos DENTRO del workspace (memoria xmpp-media-send-broken): los roots
# por defecto traen $STATE/workspace (singular, layout vanilla) pero esta
# flota usa $STATE/workspaces/<agente>. El workspace del agente solo se añade
# cuando el caller resuelve agentId — el CLI y varios paths ws no lo hacen.
# Añadir el padre workspaces/ cubre todos los callers.
MEDIA_ROOTS_APPLIED_MARK = 'path.join(resolvedStateDir, "workspaces")'
MEDIA_ROOTS_OLD = (
    '\t\tpath.join(resolvedStateDir, "workspace"),\n'
    '\t\tpath.join(resolvedStateDir, "sandboxes")\n'
)
MEDIA_ROOTS_NEW = (
    '\t\tpath.join(resolvedStateDir, "workspace"),\n'
    '\t\tpath.join(resolvedStateDir, "workspaces"),\n'
    '\t\tpath.join(resolvedStateDir, "sandboxes")\n'
)

# --- Parche 8: xmpp entra a NATIVE_APPROVAL_CHANNELS ------------------------
# CAUSA RAÍZ del "approval loop" (turno reintenta el mismo exec mientras
# espera aprobación, choca contra el guard single-pending-approval-per-session):
# xmpp no estaba en esta lista fija, así que shouldAwaitGatewayApprovalInline()
# nunca esperaba in-línea la decisión para turnos originados en XMPP -- el
# turno terminaba en approval-pending y dependía de un followup async frágil.
# Requisito: el plugin XMPP debe tener su nativeRuntime de aprobaciones
# registrado (approval-handler.runtime.ts + registerChannelRuntimeContext en
# monitor.ts, ver openspec/changes/xmpp-native-approval-runtime) ANTES de
# aplicar este parche, o el turno esperaría in-línea sin que nada resuelva la
# card. Verificado en incidente real 2026-07-18 22:38-22:52 UTC (Clawdio,
# sesiones 525314f7/c952ea53/f3d2a4ce en bucle).
NATIVE_APPROVAL_CHANNELS_APPLIED_MARK = '"whatsapp",\n\t"xmpp"'
NATIVE_APPROVAL_CHANNELS_OLD = (
    '"slack",\n'
    '\t"telegram",\n'
    '\t"whatsapp"\n'
    '];'
)
NATIVE_APPROVAL_CHANNELS_NEW = (
    '"slack",\n'
    '\t"telegram",\n'
    '\t"whatsapp",\n'
    '\t"xmpp"\n'
    '];'
)

# --- Parche 9: puerto local determinista para RPC de approvals -------------
# localPortOverride conserva la autenticación local y evita que la resolución
# implícita use el puerto default cuando este gateway escucha en 19100.
APPROVAL_LOCAL_PORT_APPLIED_MARK = 'method.startsWith("exec.approval.") ? { localPortOverride:'
APPROVAL_LOCAL_PORT_OLD = (
    '\t\t\turl: gateway.url,\n'
    '\t\t\ttoken: gateway.token,\n'
)
APPROVAL_LOCAL_PORT_NEW = (
    '\t\t\turl: gateway.url,\n'
    '\t\t\t...method.startsWith("exec.approval.") ? { localPortOverride: Number.parseInt(process.env.OPENCLAW_GATEWAY_PORT ?? "19100", 10) } : {},\n'
    '\t\t\ttoken: gateway.token,\n'
)

# --- Parche 10: cierre acotado del cliente RPC -----------------------------
# stopAndWait puede no respetar su timeout y deja callGateway pendiente aun
# después de recibir la respuesta. Una carrera externa garantiza el retorno.
GATEWAY_CLIENT_STOP_APPLIED_MARK = "forcedStopTimer = setTimeout(resolve, 1100)"
GATEWAY_CLIENT_STOP_OLD = (
    "async function stopGatewayClient(client) {\n"
    "\ttry {\n"
    "\t\tawait client.stopAndWait({ timeoutMs: 1e3 });\n"
    "\t} catch {\n"
    "\t\tclient.stop();\n"
    "\t}\n"
    "}"
)
GATEWAY_CLIENT_STOP_NEW = (
    "async function stopGatewayClient(client) {\n"
    "\tlet forcedStopTimer;\n"
    "\ttry {\n"
    "\t\tawait Promise.race([\n"
    "\t\t\tclient.stopAndWait({ timeoutMs: 1e3 }).catch(() => {}),\n"
    "\t\t\tnew Promise((resolve) => {\n"
    "\t\t\t\tforcedStopTimer = setTimeout(resolve, 1100);\n"
    "\t\t\t})\n"
    "\t\t]);\n"
    "\t} finally {\n"
    "\t\tif (forcedStopTimer) clearTimeout(forcedStopTimer);\n"
    "\t\tclient.stop();\n"
    "\t}\n"
    "}"
)

# --- Parche 11: approvals no esperan la barrera de event-loop --------------
# El RPC corre dentro del propio gateway; la barrera de readiness puede no
# resolverse y evita hasta el handshake. El runtime token limita el bypass a
# llamadas internas autenticadas de approvals.
APPROVAL_DIRECT_START_APPLIED_MARK = "const startReadiness = opts.approvalRuntimeToken"
APPROVAL_DIRECT_START_OLD = (
    "\t\tstartGatewayClientWhenEventLoopReady(client, {\n"
    "\t\t\ttimeoutMs: safeTimerTimeoutMs,\n"
    "\t\t\tsignal: startAbort.signal\n"
    "\t\t}).then((readiness) => {"
)
APPROVAL_DIRECT_START_NEW = (
    "\t\tconst startReadiness = opts.approvalRuntimeToken ? (client.start(), Promise.resolve({\n"
    "\t\t\tready: true,\n"
    "\t\t\taborted: false\n"
    "\t\t})) : startGatewayClientWhenEventLoopReady(client, {\n"
    "\t\t\ttimeoutMs: safeTimerTimeoutMs,\n"
    "\t\t\tsignal: startAbort.signal\n"
    "\t\t});\n"
    "\t\tstartReadiness.then((readiness) => {"
)

# --- Parche 12: timeout de aprobación reducido a 5 minutos ------------------
# DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 18e5 (30 min) es demasiado largo para
# nuestro entorno: una card de aprobación que el usuario no ve bloquea el turno
# del agente 30 minutos. Con 5 min el agente expira antes y puede retomar
# conversación. Usado junto con el re-prompt de los 2/3 del tiempo y el comando
# /abort (native-commands.ts, commands.ts) para escape manual.
#
# Por qué un parche al bundle y no configuración: el core NO expone ninguna
# clave de config para este timeout (ExecApprovalsDefaults solo tiene security,
# ask, askFallback, autoAllowSkills). El único override es `timeoutMs`
# por-request (exec-approval-Bj1D1xVl.js:158, fallback ternario), pero el
# llamador lo hardcodea en bash-tools-D7H1rgMh.js:107 sin ruta de config que lo
# alcance. Verificado 2026-07-19. Si upstream agrega una clave de config,
# retirar este parche.
#
# NO bajar en paralelo el fallback de los clientes (GTK
# _APPROVAL_ACTION_FALLBACK_MAX_AGE_MS, Android APPROVAL_FALLBACK_MAX_AGE_MS,
# ambos 30 min): ese fallback solo aplica cuando el gateway OMITE
# expires-at-ms, y acortarlo oculta la card sin cancelar el pending del
# gateway, dejando la sesión bloqueada con "approval already pending"
# (ver chat_window.py:2772-2776). Con expires-at-ms presente —el caso normal—
# los clientes ya se alinean solos con este valor.
# TRAMPA DE RE-APLICACIÓN: find_file() solo considera candidato un archivo que
# contenga OLD o APPLIED_MARK. Históricamente OLD fue el estado ya parcheado
# (6e5 con comentario propio) porque el bundle en producción nunca estaba
# limpio; desde la reinstalación limpia de 2026.7.35 (2026-09-26) el dist
# vuelve de fábrica (18e5) y OLD apunta de nuevo al valor de fábrica. Si se
# parte de un bundle heredado (6e5), el anchor no matchea: aplicar 6e5->3e5 a
# mano o ampliar OLD. Verificar SIEMPRE el valor efectivo post-deploy
# (grep 3e5 en dist) en lugar de confiar en la salida del script.
APPROVAL_TIMEOUT_APPLIED_MARK = "DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 3e5;"
APPROVAL_TIMEOUT_OLD = (
    "const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 18e5;"
)
APPROVAL_TIMEOUT_NEW = (
    "// Fleet timeout: 5 min (was 30 min). See apply-openclaw-patches.py 12.\n"
    "const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 3e5;"
)

# --- Parche 13: preservar sessionId al rotar sesión de cron aislado ---------
# Auditoría 2026-07-20: Bob disparó manualmente el cron bob-slack-radar con
# sessionTarget "isolated" (resolveCronSession con forceNew=true). Cada
# disparo aislado crea sessionId nuevo vía sanitizeFreshCronSessionEntry, que
# construye una entry desde cero copiando solo un whitelist deliberado de
# preferencias de usuario — sin incluir jamás el sessionId anterior ni
# usageFamilySessionIds. Un exec approval pedido durante ese run queda con
# expectedSessionId = el sessionId del run efímero; cuando la decisión llega
# (o expira), el guard de rebound (parches 1-2 arriba) resuelve la sesión
# "actual" de esa clave y no encuentra ningún registro que contenga el id
# viejo — a diferencia de la rotación de `main` (compactación), que SÍ
# encadena el id anterior en usageFamilySessionIds antes de descartarlo
# (session-store: "next.usageFamilySessionIds = [...entry.usageFamilySessionIds
# ?? [], entry.sessionId, sessionId]"). Resultado: "Dropping stale exec
# approval followup ... session rebound" en loop cada vez que el cron corre,
# indistinguible en el log de un /reset real pero sin ninguna sesión legítima
# contra la cual reconciliar.
#
# Esta entrada AGREGA el mismo encadenamiento a sanitizeFreshCronSessionEntry,
# sin tocar el whitelist de campos de preferencia (que es intencional: un run
# aislado SÍ debe empezar "limpio" en todo lo demás). Aditivo y de bajo riesgo:
# solo hace que el id viejo quede en una lista que el guard de rebound ya sabe
# leer (reboundKnownIds incluye storeKeys de la propia clave), en vez de
# desaparecer sin dejar rastro.
SESSION_ROLLOVER_FAMILY_APPLIED_MARK = "isolatedRunFamilyIds"
SESSION_ROLLOVER_FAMILY_OLD = (
    "function sanitizeFreshCronSessionEntry(entry, options) {\n"
    "\tconst next = {};\n"
    "\tcopySessionFields(next, entry, FRESH_CRON_CARRIED_PREFERENCE_FIELDS);\n"
    "\tif (options.preserveAmbientContext) copySessionFields(next, entry, AMBIENT_SESSION_CONTEXT_FIELDS);\n"
)
SESSION_ROLLOVER_FAMILY_NEW = (
    "function sanitizeFreshCronSessionEntry(entry, options) {\n"
    "\tconst next = {};\n"
    "\tcopySessionFields(next, entry, FRESH_CRON_CARRIED_PREFERENCE_FIELDS);\n"
    "\tif (options.preserveAmbientContext) copySessionFields(next, entry, AMBIENT_SESSION_CONTEXT_FIELDS);\n"
    "\tif (entry?.sessionId) {\n"
    "\t\tconst isolatedRunFamilyIds = Array.from(new Set([...(entry.usageFamilySessionIds ?? []), entry.sessionId]));\n"
    "\t\tnext.usageFamilySessionIds = isolatedRunFamilyIds;\n"
    "\t\tnext.usageFamilyKey = entry.usageFamilyKey ?? entry.sessionId;\n"
    "\t}\n"
)

# --- Parche 12: /elevated full|off también fija exec security/ask ----------
# CAUSA: /elevated NUNCA bypasea aprobaciones a menos que exec-approvals.json
# ya sea permisivo (security:"full"/ask:"off") de forma persistente en el
# host -- confirmado con la doc oficial (docs/tools/exec-approvals.md,
# sección "Session-only shortcut": "/elevated full is a break-glass shortcut
# that skips exec approvals only when both the requested policy and the
# host approvals file resolve to security:full and ask:off. A stricter host
# file, such as ask:always, still prompts."). Además /elevated solo tiene
# efecto para agentes SANDBOXED (docs/tools/elevated.md: "Elevated mode only
# changes behavior when the agent is sandboxed. For unsandboxed agents, exec
# already runs on the host.") -- esta flota no corre ningún agente en
# sandbox, así que /elevated era, tal como estaba, un comando sin efecto
# real sobre las aprobaciones, sin importar cómo se configurara
# exec-approvals.json (ver incidente 2026-07-25/26: intentar "arreglarlo"
# abriendo defaults.security/ask globalmente dejó a los 7 agentes sin
# aprobación de exec en absoluto durante horas, sin relación real con
# /elevated).
#
# El mecanismo real de "toggle temporal por sesión sin depender del host
# file" ya existe nativamente y es independiente de elevated:
# /exec security=full ask=off (docs/tools/exec-approvals.md: "/exec
# security=full is a session-level convenience for authorized operators and
# skips approvals by design"). Confirmado en el propio dist que
# sessionEntry.execSecurity/execAsk (los mismos campos que persiste /exec)
# son los que realmente resuelve exec-defaults-*.js
# (`normalizeExecSecurity(sessionEntry?.execSecurity)`), con precedencia de
# sesión sobre los defaults del agente -- no toca exec-approvals.json ni
# ningún default global, así que no repite el incidente de julio.
#
# Este parche hace que /elevated full (alias /elev full) además fije
# sessionEntry.execSecurity="full"/execAsk="off" en la misma rama donde ya
# se persiste sessionEntry.elevatedLevel, y que /elevated off restaure
# security="allowlist"/ask="on-miss" (el default seguro que usa toda la
# flota). /elevated ask (alias de "on") no toca exec: sigue respetando la
# política de fondo, igual que antes. Efecto: /elevated (y su alias /elev)
# recupera la semántica esperada (on/off/ask/full) en un sistema sin
# sandbox, sin necesitar que el operador recuerde escribir /exec a mano.
ELEVATED_ALIAS_APPLIED_MARK = 'sessionEntry.execSecurity = "full"; sessionEntry.execAsk = "off"'
ELEVATED_ALIAS_OLD = (
    "\t\tif (directives.hasElevatedDirective && directives.elevatedLevel) {\n"
    "\t\t\tsessionEntry.elevatedLevel = directives.elevatedLevel;\n"
    "\t\t\televatedChanged = elevatedChanged || directives.elevatedLevel !== prevElevatedLevel && directives.elevatedLevel !== void 0;\n"
    "\t\t}\n"
)
ELEVATED_ALIAS_NEW = (
    "\t\tif (directives.hasElevatedDirective && directives.elevatedLevel) {\n"
    "\t\t\tsessionEntry.elevatedLevel = directives.elevatedLevel;\n"
    "\t\t\televatedChanged = elevatedChanged || directives.elevatedLevel !== prevElevatedLevel && directives.elevatedLevel !== void 0;\n"
    '\t\t\tif (directives.elevatedLevel === "full") { sessionEntry.execSecurity = "full"; sessionEntry.execAsk = "off"; }\n'
    '\t\t\telse if (directives.elevatedLevel === "off") { sessionEntry.execSecurity = "allowlist"; sessionEntry.execAsk = "on-miss"; }\n'
    "\t\t}\n"
)


# Parche "approval-handler-tick-quiet" RETIRADO 2026-09-26.
# Silenciaba el latido console.error de approval-handler-event (tick/health
# cada 30 s = ~60 MB/mes de openclaw.error.log, 97.6% ruido). Upstream eliminó
# esa línea: en el dist 2026.7.35 no queda ningún console.error en
# approval-handler*.js (verificado con grep 2026-09-26). No queda nada que
# aplicar; si el ruido reaparece en una versión futura, re-anclar aquí.


PATCHES = [
    ("gateway-rebound-guard", GW_APPLIED_MARK, GW_OLD, GW_NEW),
    ("direct-rebound-guard", DD_APPLIED_MARK, DD_OLD, DD_NEW),
    ("exec-followup-main-route", FOLLOWUP_ROUTE_APPLIED_MARK,
     FOLLOWUP_ROUTE_OLD, FOLLOWUP_ROUTE_NEW),
    ("approval-pending-stop-turn", APPROVAL_STOP_APPLIED_MARK,
     APPROVAL_STOP_OLD, APPROVAL_STOP_NEW),
    # "single-pending-approval" retirado 2026-07-20: ver el comentario del
    # Parche 5 arriba — premisa refutada en ambos sentidos, no queda nada que
    # aplicar ni revertir.
    ("media-roots-fleet-workspaces", MEDIA_ROOTS_APPLIED_MARK,
     MEDIA_ROOTS_OLD, MEDIA_ROOTS_NEW),
    ("xmpp-native-approval-channel", NATIVE_APPROVAL_CHANNELS_APPLIED_MARK,
     NATIVE_APPROVAL_CHANNELS_OLD, NATIVE_APPROVAL_CHANNELS_NEW),
    ("approval-local-gateway-port", APPROVAL_LOCAL_PORT_APPLIED_MARK,
     APPROVAL_LOCAL_PORT_OLD, APPROVAL_LOCAL_PORT_NEW),
    ("gateway-client-bounded-stop", GATEWAY_CLIENT_STOP_APPLIED_MARK,
     GATEWAY_CLIENT_STOP_OLD, GATEWAY_CLIENT_STOP_NEW),
    ("approval-direct-client-start", APPROVAL_DIRECT_START_APPLIED_MARK,
     APPROVAL_DIRECT_START_OLD, APPROVAL_DIRECT_START_NEW),
    # Restaurado 2026-07-19: se había quitado de esta lista sin registro de
    # decisión. Verificado que el anchor sigue coincidiendo byte a byte con
    # openclaw 2026.7.1, que el bundle instalado NO lo tenía aplicado (se
    # perdió en una reinstalación), y que no existe equivalente nativo:
    # loopDetection compara hashes de tool-calls idénticos intra-turno, esto
    # limita frecuencia de despertares inter-turno. Ortogonales.
    # La causa raíz (todo exec exitoso re-despierta la sesión completa,
    # bash-tools sendExecApprovalFollowupResult; solo los denegados tienen
    # supresión) es upstream y no resoluble por config, así que el paliativo
    # sigue haciendo falta.
    ("exec-followup-burst-breaker", FOLLOWUP_BURST_APPLIED_MARK,
     FOLLOWUP_BURST_OLD, FOLLOWUP_BURST_NEW),
    ("approval-timeout-reduced", APPROVAL_TIMEOUT_APPLIED_MARK,
     APPROVAL_TIMEOUT_OLD, APPROVAL_TIMEOUT_NEW),
    ("cron-isolated-session-family-chain", SESSION_ROLLOVER_FAMILY_APPLIED_MARK,
     SESSION_ROLLOVER_FAMILY_OLD, SESSION_ROLLOVER_FAMILY_NEW),
    ("elevated-full-sets-exec-security", ELEVATED_ALIAS_APPLIED_MARK,
     ELEVATED_ALIAS_OLD, ELEVATED_ALIAS_NEW),
]


def node_check(path):
    r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    return r.returncode == 0, r.stderr.strip()


def check_version():
    """Precheck de versión: falla cerrado si `openclaw` instalado no coincide
    con EXPECTED_OPENCLAW_VERSION. Los 11 parches localizan su anchor por
    contenido, no por versión — un upgrade puede mover el código sin que
    find_file() lo distinga de "ya aplicado" o "no aplica más". Sin este
    gate, un upgrade de `openclaw` podría dejar parches críticos (el guard de
    rebound, el breaker de ráfaga) sin aplicar y el servicio arrancaría igual,
    silenciosamente degradado."""
    installed = installed_openclaw_version()
    if installed is None:
        return False, "no se pudo leer la versión instalada desde " + OPENCLAW_PACKAGE_JSON
    if installed != EXPECTED_OPENCLAW_VERSION:
        return False, (
            f"openclaw instalado={installed} but esperado={EXPECTED_OPENCLAW_VERSION}; "
            "los anchors de los parches no están verificados contra esta versión"
        )
    return True, installed


def evaluate_patches():
    """Corre la detección de candidatos (find_file) para los 11 parches sin
    escribir nada. Devuelve una lista de dicts con status por parche:
    'pending' (candidato encontrado, no aplicado aún), 'applied' (ya
    aplicado), 'ambiguous' (0 o >1 candidatos, ver find_file)."""
    results = []
    for name, applied_mark, old, new in PATCHES:
        found = find_file(name, old, applied_mark)
        if not found:
            results.append({"name": name, "status": "ambiguous"})
            continue
        path, src, already = found
        if already:
            results.append({"name": name, "status": "applied", "path": path})
            continue
        results.append({
            "name": name, "status": "pending", "path": path, "src": src,
            "old": old, "new": new,
        })
    return results


def apply_patches(evaluated):
    """Escribe los parches en estado 'pending' de evaluate_patches(). Devuelve
    (changed: bool, skipped: list[str]) — skipped incluye tanto los
    'ambiguous' de la evaluación como los que fallan node --check o matchean
    old más de una vez al momento de escribir."""
    changed = False
    skipped = [r["name"] for r in evaluated if r["status"] == "ambiguous"]
    for r in evaluated:
        name = r["name"]
        if r["status"] == "ambiguous":
            continue
        if r["status"] == "applied":
            # No imprimir acá: report_status() ya cubre este caso al final,
            # sin duplicar la línea.
            continue
        path, src, old, new = r["path"], r["src"], r["old"], r["new"]
        n = src.count(old)
        if n != 1:
            print(f"  ! {name}: bloque original matchea {n} veces en "
                  f"{path.split('/')[-1]}; upstream cambió, salto", flush=True)
            skipped.append(name)
            continue
        patched = src.replace(old, new)
        # El temp debe conservar la extensión .js: el paquete es ESM y
        # `node --check` decide el parser por la extensión (.patch-tmp lo
        # rechaza con ERR_UNKNOWN_FILE_EXTENSION).
        tmp = path[:-3] + ".patch-tmp.js"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(patched)
        ok, err = node_check(tmp)
        if not ok:
            print(f"  ! {name}: node --check falló, NO aplico: {err}", flush=True)
            subprocess.run(["rm", "-f", tmp])
            skipped.append(name)
            continue
        subprocess.run(["mv", tmp, path])
        print(f"  + {name}: aplicado a {path.split('/')[-1]}", flush=True)
        changed = True
    return changed, skipped


def report_status(evaluated, applied_names):
    """Reporta el estado final de los 11 parches sin omisiones: aplicado /
    saltado-con-motivo / ambiguo. applied_names son los que apply_patches()
    efectivamente escribió en esta corrida (además de los que ya venían
    aplicados)."""
    print(f"apply-openclaw-patches: reporte final ({len(PATCHES)} parches)", flush=True)
    for r in evaluated:
        name = r["name"]
        if name in applied_names:
            print(f"  + {name}: aplicado", flush=True)
        elif r["status"] == "applied":
            print(f"  = {name}: ya aplicado", flush=True)
        elif r["status"] == "ambiguous":
            print(f"  ! {name}: ambiguo (ver detalle arriba)", flush=True)
        else:
            print(f"  ! {name}: saltado-con-motivo (ver detalle arriba)", flush=True)


def main():
    precheck_only = "--precheck-only" in sys.argv[1:]

    version_ok, version_detail = check_version()
    if not version_ok:
        print(f"apply-openclaw-patches: PRECHECK FALLÓ (versión): {version_detail}",
              flush=True)
        return 1
    print(f"apply-openclaw-patches: versión openclaw OK ({version_detail})", flush=True)

    evaluated = evaluate_patches()
    ambiguous = [r["name"] for r in evaluated if r["status"] == "ambiguous"]

    if precheck_only:
        report_status(evaluated, applied_names=[])
        if ambiguous:
            print("apply-openclaw-patches: PRECHECK FALLÓ "
                  f"({len(ambiguous)} parche(s) ambiguo(s)): "
                  + ", ".join(ambiguous), flush=True)
            return 1
        print("apply-openclaw-patches: precheck OK, listo para apply", flush=True)
        return 0

    changed, skipped = apply_patches(evaluated)
    applied_names = [
        r["name"] for r in evaluated
        if r["status"] == "pending" and r["name"] not in skipped
    ]
    report_status(evaluated, applied_names)
    # Antes esta línea sólo distinguía "hubo cambios" de "todo al día", y un
    # parche sin candidato (anchor obsoleto) caía silenciosamente en el
    # segundo caso — exactamente el bug que dejó "single-pending-approval"
    # reportando falso "al día" durante un día entero. Ahora "al día" sólo se
    # imprime si TODOS los parches se evaluaron y ninguno necesitaba cambios;
    # cualquier parche saltado por falta de candidato aparece explícito.
    if skipped:
        print("apply-openclaw-patches: "
              f"{len(skipped)} parche(s) NO evaluado(s) (ver '!' arriba): "
              + ", ".join(skipped), flush=True)
    print("apply-openclaw-patches: "
          + ("cambios aplicados" if changed else "sin cambios nuevos que aplicar"),
          flush=True)
    # Además del parche del guard, limpia sesiones de canal XMPP huérfanas para
    # que los approvals no queden anclados a sessionIds muertos (ver docstring
    # de purge_orphan_channel_sessions).
    try:
        purge_orphan_channel_sessions()
    except Exception as err:  # nunca abortar el arranque por la purga
        print(f"  ! purge de sesiones fallo (ignorado): {err}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
