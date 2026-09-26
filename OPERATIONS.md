# XMPP gateway operations

## Approval modes: one concept, three scopes

There is one question -- "let this agent/session/command run without asking
me" -- answered at three different scopes, not three competing mechanisms.
Pick the row that matches how much you want relaxed and for how long:

| Scope | Mechanism | Persistence | Restart needed? |
|---|---|---|---|
| This conversation, for N minutes | `elevated` (below) | session store + durable record, survives a gateway restart | No |
| Specific commands, permanently | `exec-approvals.json` allowlist (below) | file | Yes |
| This agent, permanently | direct edit of `exec-approvals.json`/`openclaw.json` | file | Yes |

Nothing here is a fallback for something broken -- each row solves a
genuinely different situation, and none of them starts an agent turn, so
changing approval policy can never itself trigger an approval loop.

This used to be four scopes across four mechanisms (`approval-bypass`,
`approval-mode`, the core-native `elevated`, and the allowlist), with the
first three overlapping in confusing ways -- `approval-bypass` and
`approval-mode` were plugin-invented duplicates of the session-scoped and
agent-wide cases the core-native `elevated` mechanism already covered.
`xmpp-elevated-session-command` consolidated on `elevated` as the only
session-scoped bypass exposed by this plugin, and retired the other two: the
agent-wide, permanent case is served just as well by editing
`exec-approvals.json`/`openclaw.json` directly (as already done for the
production fix on 2026-07-26), without a dedicated XMPP command that
required the same manual gateway restart anyway.

### `elevated`

The ad-hoc command node documented in detail below:

- `elevated`: session-scoped, temporary policy relaxation. Sets
  `elevatedLevel` to `"full"` directly on the invoking session's entry in
  the session store (in-process, via `getSessionEntry`/`patchSessionEntry`
  from `openclaw/plugin-sdk/session-store-runtime`) -- no config file write,
  no restart. This is the same `SessionEntry.elevatedLevel` the OpenClaw
  core already reads every turn to resolve `bypassApprovals`; this plugin
  does not invent a parallel exec-policy field. Auto-reverts after a
  configurable number of minutes (default 10, max 60) via an in-memory timer
  in the plugin process; can also be turned off early. The expiration and
  pre-bypass `elevatedLevel` are ALSO persisted in the session store
  (`pluginExtensions.xmpp.elevatedBypass`): if the gateway restarts while a
  bypass is active, a sweep on plugin load reverts any bypass whose
  expiration has already passed, restoring the recorded pre-bypass level --
  fail-closed, not fail-open.

**Prerequisite outside this plugin's control**: `elevatedLevel:"full"` only
actually bypasses approvals if the agent's `exec-approvals.json` does not
have `security`/`ask` explicitly set to something that blocks it (e.g.
`security:"allowlist"`, `ask:"on-miss"` win over the elevated override). If
`elevated on` reports success but exec commands still show an approval card,
check that file's `defaults` (or the agent's own override) before assuming
this command is broken -- this exact bug was found and fixed in production
on 2026-07-26.

`elevated status` returns both a human-readable note and a structured
XEP-0004 `type="result"` form (`active`, `mode`, `expires-at-ms`,
`remaining-seconds`) attached to the same XEP-0050 command result -- clients
that want to consume the state programmatically should read the form fields,
not parse the note text.

Available through XEP-0050 when the client targets the gateway's full
resource JID, and through the universal textual fallback:

```text
/oc elevated on 10
/oc elevated status
/oc elevated off
```

`elevated` supported `mode` values:

- `on`: activate the bypass for this session, for `minutes` (default 10, max
  60). Always sets `elevatedLevel:"full"` -- the core's other levels
  (`on`/`ask`) are not exposed as options here, since this command answers a
  binary "bypassed or not" question, not a level picker (see
  `xmpp-elevated-session-command` design.md D2 for the rationale).
- `off`: revert immediately and cancel the pending auto-reversion timer.
- `status`: report whether a bypass is active for this session and, if so,
  the remaining time.

The current server preset intentionally does not put file readers such as `cat`
into `safeBins`; those should go through the reviewer or human approval so
secret reads do not become a static allowlist bypass.

### Reducing cards with a per-agent read-only allowlist

An agent that frequently investigates code (greps/finds through a codebase,
reads files) will otherwise get one approval card per command under
`tools.exec.mode: "auto"`, because the reviewer only auto-approves
`risk:"low"` decisions and any `medium`/`high`/`unknown` falls back to a
human card. There is no configurable risk threshold on the reviewer itself
(its schema only accepts `model`/`timeoutMs`) -- the supported lever is a
permanent per-agent allowlist entry in `exec-approvals.json`:

```python
import json, time, uuid

CONFIG_PATH = "/opt/claudio-w/openclaw-home/exec-approvals.json"
AGENT_ID = "clawdio"  # replace with the target agent
READ_ONLY_BINS = ["/usr/bin/grep", "/usr/bin/find", "/usr/bin/cat", "/usr/bin/head", "/usr/bin/wc"]

with open(CONFIG_PATH) as f:
    data = json.load(f)

agents = data.setdefault("agents", {})
allowlist = agents.setdefault(AGENT_ID, {}).setdefault("allowlist", [])
existing = {e.get("pattern") for e in allowlist}
now_ms = int(time.time() * 1000)

for pattern in READ_ONLY_BINS:
    if pattern in existing:
        continue
    allowlist.append({
        "id": str(uuid.uuid4()),
        "pattern": pattern,
        "source": "allow-always",
        "lastUsedAt": now_ms,
    })

with open(CONFIG_PATH, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
```

Resolve binary paths with `which <bin>` on the target host first -- patterns
match the resolved path (or the basename, for patterns without a path
separator), not an unresolved command name. Back up `exec-approvals.json`
before editing (this is production state, not versioned config), and restart
`claudio-w-openclaw.service` afterward -- this file is read at process start,
same as `openclaw.json`. This scales to any agent on any OpenClaw deployment
that has its own `exec-approvals.json`, not only claudio-w's.

For a faster, temporary alternative that doesn't touch this file at all, use
`elevated` (above) for a short investigation window instead of permanently
widening the allowlist.

A direct edit of `exec-approvals.json`/`openclaw.json` (agent-wide,
permanent) requires restarting `claudio-w-openclaw.service` for the running
gateway process to pick it up. `elevated` never requires a restart.

## Approval cards

Approval cards are sent as XEP-0050 command items with `expires-at-ms`. Clients
must render command items as the sticky action surface, not duplicate them as
quick buttons inside the message bubble. Stale approval actions should disappear
from live UI and from restored local history.

## Agent avatars

Agents should use the gateway method `xmpp.avatar.set` instead of shelling out.
Parameters:

- `source`: local image path or HTTP(S) URL. PNG, JPEG, GIF, and WebP are
  accepted.
- `accountId`: optional XMPP account id, such as `clawdio`, `bob`, or `odiseo`.

If `source` is under `/agents/<id>/` or `/workspaces/<id>/`, the gateway infers
`accountId=<id>` automatically. `main` maps to `clawdio`.

The gateway publishes both XEP-0084 and XEP-0153 avatar data, then telemetry
presence re-announces the avatar hash so clients refresh their roster cache.

## Servidor XMPP: MAM, retención y preflight

El plugin no guarda historial propio: **el archivo del servidor es la fuente
de verdad** (XEP-0313). Para que el catch-up de reconexión y la lectura de
historial de clientes funcionen, el host debe cumplir:

- `mod_mam` habilitado en la cuenta (archivo 1:1).
- `mod_mam` / `muc_mam` habilitado en el dominio MUC (archivo de salas).
- Retención suficiente: el default de Prosody es **1 semana**
  (`archive_expires_after = "1w"`, `muc_log_expires_after = "1w"`). El
  plugin no pretende recuperar más allá de la retención real.

El plugin sondea el disco#info del bare JID y del dominio MUC al conectar
(preflight, `src/preflight-features.ts`) y cachea si el servidor anuncia
`urn:xmpp:mam:2`. El resultado se ve en el node `status`:

```text
Server features: server MAM v2 yes, MUC conference.example.org MAM v2 yes.
```

### Verificar y habilitar en Prosody

```bash
# ¿Está cargado el módulo y con qué retención?
prosodyctl shell module:info('mam')
prosodyctl shell module:info('muc_mam')

# Config efectiva del archivo (1:1 y salas)
prosodyctl shell 'config.get("mam", "archive_expires_after")'
prosodyctl shell 'config.get("muc_mam", "muc_log_expires_after")'

# Comprobar que el servidor anuncia MAM por disco#info (desde un cliente o
# xmpp-console); el plugin lo hace igual al conectar.
```

Si la retención es menor que `history.windowMs`, ajusta la ventana del
plugin (o la retención del servidor) para que no soliciten más de lo que el
archivo conserva. `archive_expires_after = "never"` también es válido si se
quiere historial ilimitado.

### Degradación

Todo el catch-up es **fail-closed**:

- Si el preflight no ve `urn:xmpp:mam:2`, el catch-up se desactiva y queda el
  comportamiento anterior (guard de stanzas retrasadas + dedupe).
- Si el ancla del watermark fue purgada, se degrada a *fetch-latest*.
- Si una consulta MAM falla, se registra y el turno/canal sigue igual.

## Flags nuevos de configuración y degradación

Las secciones `reliability`, `history` y `hooks` de `channels.xmpp` (o por
cuenta) controlan las capas de fiabilidad, historial y hooks. Todos los
defaults son conservadores: una capa deshabilitada o un servidor sin soporte
nunca rompe el chat.

| Flag | Default | Qué hace | Cómo degrada |
|---|---|---|---|
| `reliability.spool.enabled` | `true` | Spool persistente de salientes no reconocidos (XEP-0198/XEP-0184). | Sin spool, el reenvío tras reconexión no existe; el resto del envío sigue. |
| `reliability.spool.resendOnReconnect` | `true` | Reenvía pendientes al abrir sesión nueva o tras resume fallido. | `false` conserva el spool pero no reenvía automáticamente. |
| `reliability.debounce.enabled` | `true` | Fusiona ráfagas del mismo remitente en un turno. | `false` = un turno por mensaje (comportamiento previo). |
| `reliability.burstBreaker.enabled` | `true` | Limita turnos/mensajes por destino y pausa cadenas de reintento. | `false` = sin freno estructural de salida. |
| `reliability.dispatchDedupe.enabled` | `true` | Dedupe durable de despacho (TTL 7d) para no re-ejecutar turnos. | `false` = dedupe solo en memoria durante el proceso. |
| `history.catchup` | `false` | Recupera historial MAM al reconectar. | Requiere MAM v2 en el servidor; sin él queda apagado. |
| `history.spawnTurns` | `false` | Convierte cada mensaje recuperado en turno. | `false` = modo observacional (solo contexto). |
| `history.windowMs` / `history.maxPages` / `history.mucMaxStanzas` | 7d / 4 / 0 | Ventana máxima, tope de páginas RSM y control de historial en el join MUC. | Ajustar a la retención real del servidor. |
| `hooks.receipts` | `true` | XEP-0184 en finales durables y respuesta a los recibidos. | `false` = sin acuses. |
| `hooks.pepEvents` | `false` | Publica los nodos PEP `urn:openclaw:hooks:*:0`. | `false` = clientes deben usar XEP-0050/status. |
| `hooks.reactions` | `false` | Emite reacciones XEP-0444 (DM siempre; MUC solo non-anonymous). | `false` = sin reacciones; entrantes se ignoran igual. |

Los defaults del burst breaker y del debounce viven en `src/config-defaults.ts`
y son la fuente de verdad compartida por el esquema zod y los resolvers de
runtime.

