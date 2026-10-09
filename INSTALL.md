# Instalar `@openclaw/xmpp` sobre OpenClaw estándar

Guía de instalación + prompt para un agente implementador. Objetivo: montar
este transporte XMPP en una instalación **estándar** de OpenClaw (la que
instala `npm i -g openclaw`), con un servidor **Prosody** propio, crear la
cuenta **dueña** (el operador humano) y una cuenta por **agente**, conectar los
agentes que ya existen en el gateway y arrancar con **defaults sanos que
replican lo que ya hace el transporte nativo de Telegram**.

Si lo que buscás es operar el gateway `claudio-w` (que corre una build
parcheada), esto no es eso: ese gateway tiene una capa de parches de core (ver
sección 8). Acá se documenta cómo reproducir el transporte en limpio.

---

## Prompt para el agente implementador

Copiar el bloque siguiente tal cual en la tarea del agente que va a hacer la
instalación. Asume que la persona ya tiene (o puede conseguir) un servidor con
Prosody y las cuentas XMPP de los agentes.

```text
Vas a instalar el plugin de canal XMPP `@openclaw/xmpp` sobre una instalación
ESTÁNDAR de OpenClaw, con un servidor Prosody propio. El plugin vive en el repo
icarito/openclaw-xmpp y NO está publicado en npm: se instala clonando el
repositorio y apuntando OpenClaw a esa ruta.

Contexto de partida que debés confirmar vos mismo (no asumir):
- Versión de OpenClaw instalada: necesita pluginApi >= 2026.7.1. Verificá con
  `openclaw --version` y compará con `openclaw.compat.pluginApi` de package.json.
- Un servidor XMPP (Prosody recomendado) con: un VirtualHost y una cuenta
  (JID + contraseña) por cada agente que vaya a hablar por XMPP; una cuenta
  dueña (el operador humano) que será admin y aprobador; `mod_mam` en el
  VirtualHost; un componente MUC con `muc_mam`; y un componente de subida
  XEP-0363 (`http_file_share`) si se van a enviar archivos.
- El estado de OpenClaw (OPENCLAW_STATE_DIR / ~/.openclaw) y el archivo
  `openclaw.json` que edita el gateway.

Pasos:
0. Trazabilidad: confirmá con evidencia (versión, disco, logs, mensaje real),
   no asumido. No toques un gateway de producción existente sin autorización:
   esto es una instalación nueva.
1. Cloná el repo en una ruta estable, p.ej. /opt/openclaw-xmpp:
   git clone https://github.com/icarito/openclaw-xmpp.git
   (dejá el checkout en el tag estable más reciente, no en una rama de trabajo)
2. Instalá dependencias del plugin: `npm install` dentro de la ruta clonada.
3. Registrá el plugin en openclaw.json:
   - plugins.load.paths += ["/opt/openclaw-xmpp"]
   - plugins.entries.xmpp.enabled = true
4. Provisioná las cuentas en Prosody (sección 4): la cuenta dueña + una cuenta
   por agente. NO uses nombres genéricos compartidos.
5. Configurá `channels.xmpp` (sección 5): una cuenta por agente con
   jid/password/mucDomain y dmPolicy:"allowlist" + allowFrom con el JID de la
   cuenta dueña. NO uses dmPolicy:"open" en producción.
6. Por cada cuenta, agregá un binding de ruta
   {"type":"route","agentId":"<agente>","match":{"channel":"xmpp","accountId":"<cuenta>"}}
   para que los mensajes de ese JID caigan en el agente correcto. Una cuenta
   por agente; no compartas JID entre agentes.
7. (Opcional, solo si querés OMEMO) creá un venv de Python 3 e instalá
   `omemo==2.1.0` y `twomemo[xml]==2.1.0` (ver omemo2-requirements.txt), y
   exportá OPENCLAW_OMEMO2_PYTHON=<ruta al python del venv>.
8. Aplicá los defaults sanos de la sección 6. No inventes valores nuevos: usá
   los de la tabla, que ya replican Telegram.
9. Reiniciá el gateway y verificá (sección 9): disco#info de MAM, arranque de
   la conexión (log `xmpp`), y un mensaje real de ida y vuelta entre la cuenta
   dueña y el JID de un agente.
10. Si querés paridad completa de aprobaciones con Telegram, aplicá los parches
    de core de la sección 8 (script versionado en scripts/openclaw-core-patches).
    Sin ellos el canal funciona, pero las cards usan el camino asíncrono y el
    timeout es de 30 min en vez de 5.

Reglas:
- No comitees secretos (JID/passwords) en el repo; usá passwordFile o el
  archivo de config del gateway (fuera de git).
- Una cuenta de canal por agente. No compartas un JID entre agentes.
- Verificá con evidencia real (disco, logs, mensaje end-to-end), no asumido.
```

---

## 1. Qué es y qué se obtiene

`@openclaw/xmpp` es un canal de OpenClaw (igual que Telegram o IRC):

- DM 1:1 y salas MUC, con `dmPolicy`/`groupPolicy`/allowlists por cuenta.
- Comandos nativos (`/compact`, `/clear`, `/model`, etc.) expuestos como
  comandos ad-hoc XEP-0050/XEP-0004, más el fallback textual `/oc <cmd>`.
- Cards de aprobación de exec, `elevated` de sesión, streaming de progreso.
- Fiabilidad de entrega (XEP-0198 con spool), historial XEP-0313 (MAM),
  acuses XEP-0184/0333, replies XEP-0461 y reacciones XEP-0444.
- OMEMO (XEP-0384) legacy y v2 mediante un sidecar Python.

## 2. Requisitos

| Componente | Mínimo | Probado en |
|---|---|---|
| OpenClaw | `pluginApi >= 2026.7.1` (`openclaw.compat.pluginApi`) | 2026.7.35 |
| Node/npm | según OpenClaw | — |
| Prosody | 0.12+ con community modules | 13.0.1 (Debian 13) |
| Python (solo OMEMO2) | 3.10+ | 3.13 |

El plugin no está publicado en npm ni en ClawHub (`release.publishToNpm=false`,
`publishToClawHub=false`); se instala por ruta desde el repo. `package.json`
declara `minHostVersion >= 2026.6.9`.

## 3. Servidor: Prosody

Un ejemplo mínimo y verificado de configuración por dominio. Los módulos Lua
propios (`mod_expo_push`, `mod_push_hints_filter`) son **opcionales** y solo
sirven a clientes con push; ver `prosody-modules/README.md`.

```lua
-- /etc/prosody/prosody.cfg.lua (fragmento)
plugin_paths = { "/usr/local/lib/prosody/modules" }  -- solo si usás los Lua propios

admins = { "operador@example.org" }   -- la cuenta dueña (sección 4.1)

modules_enabled = {
  "disco"; "roster"; "saslauth"; "tls"; "carbons"; "pep"; "private";
  "smacks";            -- XEP-0198 stream management (lo usa el spool)
  "ping";              -- XEP-0199 keepalive
  "mam";               -- XEP-0313 archivo 1:1
  "vcard4"; "vcard_legacy"; "blocklist"; "limits"; "version"; "time"; "uptime";
  "s2s";               -- federación (opcional)
}
authentication = "internal_hashed"
allow_registration = false
c2s_ports = { 5222 }
http_ports = { 5280 }
https_ports = { 5281 }
archive_expires_after = "4w"   -- retención 1:1; ajustá a history.windowMs

VirtualHost "example.org"
  modules_enabled = { "mam" }
  archive_query_full = true
  default_archive_policy = "roster"   -- o "always" si querés archivar todo
  archive_expires_after = "never"     -- o "4w"/"1w"; debe ser >= history.windowMs
  c2s_require_encryption = true
  ssl = { key = ".../example.org.key"; certificate = ".../example.org.crt" }

Component "conference.example.org" "muc"
  restrict_room_creation = "local"
  modules_enabled = { "muc_mam" }      -- XEP-0313 en salas
  muc_log_by_default = true
  -- Defaults compatibles con OMEMO en grupo: salas no anónimas (JIDs reales).
  muc_room_default_members_only = true
  muc_room_default_public_jids = true
  muc_room_default_public = false
  ssl = { key = "..."; certificate = "..." }

Component "upload.example.org" "http_file_share"   -- XEP-0363
  http_external_url = "https://upload.example.org/"
  http_file_share_size_limit = 10 * 1024 * 1024
  http_file_share_expires_after = "1w"
  ssl = { key = "..."; certificate = "..." }
```

Notas:

- **MAM es la fuente de verdad del historial.** Sin `mod_mam` el plugin
  degrada (fail-closed) al comportamiento anterior y el catch-up de
  reconexión queda apagado. Verificalo al conectar con disco#info (sección 9).
- La retención real manda: si `archive_expires_after = "1w"`, poné
  `history.windowMs` <= 7 días, o subí la retención.
- Los módulos Lua propios se despliegan a mano en
  `/usr/local/lib/prosody/modules/` y se cargan añadidos a `modules_enabled`
  (ver `prosody-modules/README.md`). Recordá `systemctl restart prosody`
  (SIGHUP no recarga módulos nuevos de forma confiable).

---

## 4. Provisioning del servidor: cuenta dueña y cuentas de agentes

El modelo es el mismo que el de Telegram, traducido a XMPP: **una cuenta dueña
(el operador humano) y una cuenta por agente**. La cuenta dueña es la que
aprueba exec, recibe las cards y manda; las cuentas de agentes solo hablan.

### 4.1 La cuenta dueña

Es el JID del operador humano (en la instalación de referencia:
`sebastian@hablar.fuentelibre.org`). Tiene tres roles:

1. **Admin de Prosody** (para `prosodyctl`, ad-hoc de administración).
2. **Aprobador**: recibe las cards de exec-approval y los avisos.
3. **Allowlist**: es el único JID en `allowFrom` de cada agente (por defecto).

```bash
# Registrala en el VirtualHost
sudo prosodyctl register operador example.org '<password-fuerte>'

# Y declarala admin en /etc/prosody/prosody.cfg.lua:
#   admins = { "operador@example.org" }
sudo systemctl reload prosody   # o restart
```

Consejo: creá una cuenta por persona que vaya a operar. No uses la misma cuenta
que la de un agente.

### 4.2 Las cuentas de agentes

Una cuenta por agente (en la referencia: `clawdio`, `bob`, `odiseo`, `rolando`,
`hiori`, …). El nombre del JID suele coincidir con el `accountId` del canal:

```bash
# Una cuenta por agente, contraseña aleatoria, sin reusar nombres
for a in clawdio bob odiseo rolando hiori; do
  pw="$(openssl rand -base64 24)"
  sudo prosodyctl register "$a" example.org "$pw"
  echo "$a  $pw"          # guardá esto en tu gestor de secretos
done
```

Alternativa sin versionar el secreto: escribí la salida a un archivo raíz-only
(`chmod 600`) y usá `passwordFile` en la config del plugin (sección 5.2).

Verificá las cuentas (`prosodyctl mod_roster`/`prosodyctl shell` o un login de
prueba) antes de arrancar el gateway.

### 4.3 Salas MUC

Con `muc_room_default_members_only = true`, **cada JID que entra a una sala debe
ser miembro/afiliado**; si el agente no está afiliado, el join falla. Dos
opciones:

- **Recomendado (OMEMO en grupo)**: creá la sala desde el cliente de la cuenta
  dueña (que queda owner), activá *members-only* + *non-anonymous*, y agregá
  como miembros al operador y a los JIDs de los agentes que la usarán. Luego
  listá la sala en `mucRooms` del agente (y en `allowFrom`/`groups`).
- **Más simple**: dejá `muc_room_default_members_only = false` (salas abiertas
  por defecto) y confiá en `groupPolicy`/`allowFrom` del plugin. Menos seguro.

Ejemplo desde el servidor con la cuenta dueña:

```text
/oc …        # los comandos ad-hoc del plugin
# o desde un cliente XMPP del operador: crear la sala, invitar a los agentes,
# y en configuración de la sala: "Solo miembros" = sí, "Anónima" = no.
```

### 4.4 (Opcional) Firewall de contactos

En la instalación de referencia, las cuentas de agentes están protegidas por
`mod_firewall` (community module): solo los JIDs en el roster del agente pueden
hablarle; las solicitudes de desconocidos se descartan y se avisa al operador.
El registro versionado está en `/etc/prosody/firewall/agents.pfw` (fuera de
este repo). Ejemplo del patrón:

```lua
-- en prosody.cfg.lua: modules_enabled += "firewall";
--                     firewall_scripts = { "/etc/prosody/firewall/agents.pfw" };
%ZONE agents: clawdio@example.org, bob@example.org
%ZONE local: example.org, conference.example.org, upload.example.org

::deliver
ENTERING: local
ENTERING: agents
KIND: message
NOT IN ROSTER?
LOG=[firewall-agentes] Mensaje externo rebotado: $<@from> -> $<@to>
BOUNCE=policy-violation (Contacto no autorizado por el administrador)
```

Es hardening, no requisito. Para autorizar un contacto:
`sudo prosodyctl shell "roster subscribe_both <agente>@example.org <contacto>@otro.org"`.

---

## 5. Instalar el plugin y conectar los agentes

### 5.1 Instalación

```bash
git clone https://github.com/icarito/openclaw-xmpp.git /opt/openclaw-xmpp
cd /opt/openclaw-xmpp
git checkout <tag-estable>       # p.ej. v2026.9.2, no una rama de trabajo
npm install
```

En `openclaw.json` del gateway:

```json
{
  "plugins": {
    "load": { "paths": ["/opt/openclaw-xmpp"] },
    "entries": { "xmpp": { "enabled": true } }
  }
}
```

### 5.2 Modelo de conexión de agentes

La regla es simple y es la misma que usa Telegram: **una cuenta de canal por
agente, y un binding de ruta que ata esa cuenta al agente**. El `accountId` es
el nombre lógico (p.ej. `clawdio`); el agente se resuelve por el binding.

```json
{
  "channels": {
    "xmpp": {
      "enabled": true,
      "service": "xmpp://example.org:5222",
      "mucDomain": "conference.example.org",
      "dmPolicy": "allowlist",
      "allowFrom": ["operador@example.org"],
      "capabilities": { "inlineButtons": "dm" },
      "streaming": { "mode": "partial" },
      "accounts": {
        "clawdio": {
          "jid": "clawdio@example.org",
          "passwordFile": "/etc/openclaw/secrets/clawdio.pass",
          "mucDomain": "conference.example.org",
          "dmPolicy": "allowlist",
          "allowFrom": ["operador@example.org"]
        },
        "bob": {
          "jid": "bob@example.org",
          "password": "…",
          "mucDomain": "conference.example.org",
          "dmPolicy": "allowlist",
          "allowFrom": ["operador@example.org"]
        }
      }
    }
  },
  "bindings": [
    { "type": "route", "agentId": "clawdio", "match": { "channel": "xmpp", "accountId": "clawdio" } },
    { "type": "route", "agentId": "bob",     "match": { "channel": "xmpp", "accountId": "bob" } }
  ]
}
```

Campos por cuenta (todos opcionales salvo `jid`/`password`):

| Campo | Descripción | Default |
|---|---|---|
| `jid` | JID completo del agente | — (o `XMPP_JID` para la cuenta `default`) |
| `password` / `passwordFile` | Secreto; `passwordFile` evita versionarlo | — |
| `service` | URI de conexión | `xmpp://127.0.0.1:5222` (o `XMPP_SERVICE`) |
| `resource` | Recurso XMPP | `openclaw-<accountId>` |
| `mucDomain` | Dominio de salas | — (o `XMPP_MUC_DOMAIN`) |
| `mucRooms` | Salas a unir al conectar | `[]` |
| `dmPolicy` | `pairing` \| `allowlist` \| `open` \| `disabled` | `pairing` |
| `allowFrom` | Permitidos en DM | `[]` |
| `groupPolicy` | `open` \| `allowlist` \| `disabled` | `allowlist` |
| `groups` | Config por sala (mention, tools, allowFrom) | `{}` |
| `approvalDmJid` | Redirige cards de aprobación de una sala a un DM del operador | — |
| `omemo` | Ver 5.3 | off |

### 5.3 OMEMO (opcional)

Para OMEMO 2 (namespace moderno, `protocol: "dual"` usa legacy + v2 a la vez)
el plugin lanza un sidecar Python. Prepará el venv una vez:

```bash
python3 -m venv /opt/openclaw-xmpp/omemo2-venv
/opt/openclaw-xmpp/omemo2-venv/bin/pip install -r omemo2-requirements.txt
export OPENCLAW_OMEMO2_PYTHON=/opt/openclaw-xmpp/omemo2-venv/bin/python
```

y por cuenta:

```json
"omemo": { "enabled": true, "protocol": "dual", "requireEncryption": false, "deviceLabel": "Clawdio" }
```

Sin `OPENCLAW_OMEMO2_PYTHON` el plugin busca por defecto
`/opt/claudio-w/openclaw-home/omemo2-venv/bin/python`; en una instalación
estándar **siempre** exportá la variable. `requireEncryption: false` mantiene
el canal usable con pares que todavía no hablan OMEMO (igual que `dual` en
producción).

---

## 6. Defaults sanos (paridad Telegram)

Estos son los valores que el plugin resuelve cuando no configurás las secciones
`reliability`/`history`/`hooks` (`src/config-defaults.ts`). Son seguros por
defecto: una capa deshabilitada o un servidor sin soporte nunca rompe el chat.

| Flag | Default | Efecto / paridad Telegram |
|---|---|---|
| `reliability.spool.enabled` | `true` | Spool persistente de salientes no reconocidos (XEP-0198/0184). Paridad con el spool durable de Telegram. |
| `reliability.spool.resendOnReconnect` | `true` | Reenvía pendientes al abrir sesión o tras resume fallido. |
| `reliability.debounce.enabled` | `true` | Fusiona ráfagas del mismo remitente en un turno (ventana 1.5 s). Es el `inbound-debounce` de Telegram. |
| `reliability.burstBreaker.enabled` | `true` | Freno estructural de cadenas de salida (6 turnos / 12 msgs por 10 s → pausa 60 s). Anti-fuga de tokens. |
| `reliability.dispatchDedupe.enabled` | `true` | Dedupe durable de despacho, TTL 7 días. Paridad con Telegram; un replay tras reinicio no re-ejecuta turnos. |
| `history.catchup` | `false` | Catch-up MAM al reconectar. Requiere `mod_mam`; activalo si querés recuperar mensajes perdidos. |
| `history.spawnTurns` | `false` | Modo observacional (el replay es contexto, no turnos). Dejalo en `false` salvo que quieras que cada mensaje recuperado dispare el modelo. |
| `history.windowMs` | 7 d | Ventana máxima de catch-up. Debe ser <= retención real del archivo. |
| `history.maxPages` | `4` | Tope de páginas RSM por consulta. |
| `history.mucMaxStanzas` | `0` | Control explícito de historial en el join de MUC (el catch-up va por MAM). |
| `hooks.receipts` | `true` | XEP-0184 en finales durables; responde a los recibidos. |
| `hooks.pepEvents` | `false` | Publica nodos PEP `urn:openclaw:hooks:*`. Opt-in; solo si tus clientes los consumen. |
| `hooks.reactions` | `false` | Emite reacciones XEP-0444 (DM siempre, MUC no anónimo). Opt-in. |

Perfil recomendado para una instalación que quiere comportamiento Telegram
completo (MAM incluido):

```json
{
  "reliability": {
    "spool": { "enabled": true, "resendOnReconnect": true },
    "debounce": { "enabled": true },
    "burstBreaker": { "enabled": true },
    "dispatchDedupe": { "enabled": true }
  },
  "history": { "catchup": true, "spawnTurns": false, "windowMs": 604800000, "maxPages": 4, "mucMaxStanzas": 0 },
  "hooks": { "receipts": true, "pepEvents": false, "reactions": false }
}
```

Sección transversal recomendada: `capabilities.inlineButtons: "dm"` y
`streaming.mode: "partial"` (los mismos que producción, y equivalentes a la
experiencia de streaming de Telegram).

---

## 7. La mejor integración posible

Resumen de la topología que usa la instalación de referencia y que conviene
replicar. Es "la mejor" en el sentido de máxima paridad con el canal nativo de
Telegram, no de máxima cantidad de knobs.

**Topología**

- **Un proceso de gateway, N cuentas de canal, 1 binding por cuenta.** OpenClaw
  corre un gateway por deployment; los "agentes" son entradas de config
  (`agents.<id>`), no contenedores. Asigná a cada agente su propia cuenta XMPP
  y su propio binding `channel=xmpp, accountId=<cuenta>`. No compartas JID.
- **Cuenta dueña = operador.** Es el `allowFrom` de cada agente, el
  `approvalDmJid` de las cuentas que entran a salas, y el admin de Prosody.
  Es quien recibe y resuelve aprobaciones.
- **MAM como historial.** El plugin no cachea historial; `mod_mam` es la fuente
  de verdad. Activalo y poné `history.catchup: true` para recuperar mensajes
  tras reconexión/reinicio. Ajustá `history.windowMs` a la retención real.
- **Fiabilidad por defecto, sin tocar.** Spool, debounce, burst breaker y
  dedupe durable ya vienen en `true`; son la defensa anti-fuga de tokens.
- **`capabilities.inlineButtons: "dm"` + `streaming.mode: "partial"`.** Cards
  de aprobación y streaming de progreso con la misma sensación que Telegram.
- **`approvalDmJid` en cuentas de sala.** Sin esto, las cards de aprobación
  originadas en un MUC son visibles para todos los ocupantes; con esto se
  redirigen al DM del operador (solo cambia el destino, no la lógica).
- **Aprobaciones in-line: parches de core (sección 8).** Es lo único que no se
  consigue solo con config, y lo que separa "funciona" de "idéntico a
  Telegram" en el ciclo de aprobación de exec.

**Roster y aislamiento**

- Cargá la cuenta dueña en el roster de cada agente (`subscribe_both`) para que
  sea el único remitente autorizado, y usá `mod_firewall` (sección 4.4) si
  querés bloquear contactos entrantes de la federación.
- En DM, `dmPolicy: "allowlist"` con la cuenta dueña es el default seguro;
  `"pairing"` es aceptable solo durante el alta.
- En salas, `groupPolicy: "allowlist"` + `groups.<sala>` explícitos.

**Qué evitar**

- `dmPolicy: "open"` en producción (exige `allowFrom: ["*"]`, y abre el agente
  a cualquiera).
- Reusar un JID entre agentes (mezcla sesiones y rompe el ruteo).
- Apuntar `plugins.load.paths` a un checkout de una rama de trabajo (fijá tag).
- Versionar contraseñas: usá `passwordFile` o el config del gateway fuera de
  git.
- Correr los parches de core contra un `dist` que no controles.

**Extensiones de cliente**

El contrato para clientes ad-hoc (los clientes GTK, Cheogram, etc.) está
congelado en `HOOKS.md`: nodes XEP-0050 (`status`, `credit`, `context`,
`compact`, `reset`, `new`, `model`, `abort`, `elevated`, `cmd:*`, `q:*`),
forms XEP-0004, `expires-at-ms`, caps XEP-0115, MAM, PEP y receipts/markers/
replies/reactions. Si escribís un cliente nuevo, implementá contra ese
documento.

---

## 8. Aprobaciones: parches al core

El canal funciona en un OpenClaw estándar. Pero la paridad **de aprobaciones**
con Telegram depende de una capa de parches aplicada al bundle `dist` de
OpenClaw. **Ya está versionada en este repo**:
`scripts/openclaw-core-patches/apply-openclaw-patches.py` (+ su `README.md`).
En la instalación de referencia vive en
`/opt/claudio-w/scripts/apply-openclaw-patches.py` y se corre en `ExecStartPre`
del servicio, con 13 parches aplicados y `EXPECTED_OPENCLAW_VERSION = 2026.7.35`
(falla cerrado si la versión instalada no coincide).

Instalación en una máquina nueva (rutas de tu instalación estándar):

```bash
export OPENCLAW_ROOT="$(npm root -g)/openclaw"
export OPENCLAW_DIST="$OPENCLAW_ROOT/dist"
export OPENCLAW_PACKAGE_JSON="$OPENCLAW_ROOT/package.json"
export OPENCLAW_AGENTS_DIR="$OPENCLAW_STATE_DIR/agents"

python3 scripts/openclaw-core-patches/apply-openclaw-patches.py --precheck-only
python3 scripts/openclaw-core-patches/apply-openclaw-patches.py
```

Qué aporta cada parche (resumen; adaptá versión/rutas):

1. `gateway-rebound-guard` / `direct-rebound-guard` — el guard de followups de
   exec-approval compara `expectedSessionId` contra el id de la sesión de canal y
   a veces los descarta siendo válidos (divergen del `agent:<id>:main`). El parche
   tolera el id de main. Sin él: "Dropping stale exec approval followup" en bucle.
2. `exec-followup-main-route` — clave canónica de sesión para followups async
   bajo `dmScope=main`; evita una segunda transcripción sin contexto.
3. `approval-pending-stop-turn` — endurece el system prompt: si un exec
   devuelve approval-pending, el turno se detiene; no abre más approvals.
4. `media-roots-fleet-workspaces` — agrega `$STATE/workspaces` a los media
   roots.
5. `xmpp-native-approval-channel` — **el clave**: agrega `"xmpp"` a
   `NATIVE_APPROVAL_CHANNELS` (`slack, telegram, whatsapp`). Sin esto el turno
   originado en XMPP no espera la decisión in-line y cae al followup asíncrono
   frágil (loop de aprobación). Requiere que el plugin registre su
   `nativeRuntime` de aprobaciones (lo hace `src/approval-handler.runtime.ts` +
   `registerChannelRuntimeContext`).
6. `approval-local-gateway-port` — puerto local determinista para el RPC
   `exec.approval.*` (usa `OPENCLAW_GATEWAY_PORT`).
7. `gateway-client-bounded-stop` — cierre acotado del cliente RPC.
8. `approval-direct-client-start` — las aprobaciones internas no esperan la
   barrera de readiness del event loop.
9. `exec-followup-burst-breaker` — freno de ráfagas de followups de exec
   (fuga de tokens medida: 35 followups ≈ 2.9M tokens en 3 min).
10. `approval-timeout-reduced` — timeout de aprobación de exec 30 min → 5 min.
11. `cron-isolated-session-family-chain` — preserva la cadena de `sessionId` al
    rotar la sesión de un cron aislado (evita followups huérfanos).
12. `elevated-full-sets-exec-security` — `/elevated full` además fija
    `sessionEntry.execSecurity="full"`/`execAsk="off"`, y `off` restaura
    `allowlist`/`on-miss`. Necesario porque `/elevated` solo afecta agentes
    *sandboxed*, y esta flota no usa sandbox.

Cómo decidir: para un uso personal con pocas aprobaciones, un OpenClaw estándar
sin parches es aceptable (las cards usan el camino asíncrono y el timeout de 30
min). Para paridad operativa con Telegram —o si ves bucles de aprobación o
fugas de tokens— aplicá (al menos) los parches 5, 1, 2 y 9, adaptando versión y
rutas.

---

## 9. Verificación

```bash
# 1. Compila y tests del plugin (en el checkout)
npm install
npx tsc --noEmit
npx vitest run

# 2. El gateway levanta el canal
openclaw gateway run            # (o el servicio que uses)
# log esperado: conexión XMPP de cada cuenta, MUC join, preflight de features

# 3. Preflight de MAM (el plugin consulta disco#info al conectar).
#    El node XEP-0050 `status` responde, p.ej.:
#    "Server features: server MAM v2 yes, MUC conference.example.org MAM v2 yes."

# 4. End-to-end real: un mensaje de la cuenta dueña (Gajim/Cheogram) al JID del
#    agente y observá la respuesta del agente. Un ping vacío puede no disparar
#    turno: usá una pregunta con contenido.
```

Si `history.catchup` está en `true` y el `status` dice MAM no disponible:
revisá `modules_enabled`/`archive_expires_after` en el VirtualHost y que el
componente MUC cargue `muc_mam`.

## 10. Degradación y resolución de problemas

- **No aparece el canal**: `plugins.load.paths` debe apuntar a la raíz del
  repo (donde está `index.ts`), y `plugins.entries.xmpp.enabled=true`. También
  revisá que `openclaw.plugin.json` esté en esa raíz.
- **Cuenta no conecta**: `jid`/`password` mal, o `service` incorrecto. El
  default `xmpp://127.0.0.1:5222` solo sirve si Prosody escucha en localhost.
- **DM ignorado**: `dmPolicy:"allowlist"` sin el JID del interlocutor en
  `allowFrom`. En `pairing` el primer mensaje pide emparejamiento.
- **Grupo ignorado**: falta `mucDomain`, la sala no está en `mucRooms`, o
  `groupPolicy:"allowlist"` sin la sala en `groups`. Con salas *members-only*,
  verificá además que el JID del agente sea miembro (sección 4.3).
- **Aprobaciones colgadas / en bucle**: ver sección 8 (falta el parche 5 en un
  core no parcheado).
- **Sin push a móviles**: faltan los módulos Lua `mod_expo_push` /
  `mod_push_hints_filter` (opcionales).
- **OMEMO no arranca**: `OPENCLAW_OMEMO2_PYTHON` sin apuntar a un venv que
  tenga `omemo`/`twomemo` instalados.

## 11. Mapa de archivos relevantes del repo

| Archivo | Qué define |
|---|---|
| `package.json` (`openclaw` block) | entrypoint, `setupEntry`, canal, `compat.pluginApi`, versión de host |
| `openclaw.plugin.json` | activación, `channelConfigs`, env vars (`XMPP_JID`, …) |
| `index.ts` | registro del plugin (avatar RPC, hooks de sesión, barrido de bypasses) |
| `src/config-schema.ts` / `src/config-defaults.ts` | esquema y defaults de `reliability`/`history`/`hooks` |
| `src/accounts.ts` | resolución de cuentas, JID/password/service/resource |
| `src/omemo/omemo2.ts` | ruta del venv del sidecar (`OPENCLAW_OMEMO2_PYTHON`) |
| `prosody-modules/` | módulos Lua opcionales para push a móviles |
| `scripts/openclaw-core-patches/` | parches de paridad de aprobaciones (sección 8) |
| `OPERATIONS.md` | modos de aprobación, MAM, tabla de flags |
| `HOOKS.md` | contrato XEP-0050/XEP-0004/PEP/MAM para clientes ad-hoc |

---

## Anexo: estado verificado del gateway `claudio-w` (2026-10-09)

Revisión de solo-lectura del gateway de producción, para contraste:

- **Corre desde `/opt/claudio-w/repos/openclaw-xmpp`** (clon git en
  `v2026.9.1`, HEAD `07a5a5b`, árbol limpio), **no** desde
  `/opt/claudio-w/extensions-xmpp-src/` (copia stale de julio, ya no
  referenciada por `plugins.load.paths`). El README/CLAUDE.md viejos decían lo
  contrario; quedó corregido.
- **Repos actualizado**: el clone local y el del servidor están ambos en
  `07a5a5b` (`v2026.9.1`), igual que `origin/xmpp-first-class-channel`.
- **Prosody** 13.0.1 con VirtualHost `hablar.fuentelibre.org` (`mod_mam`,
  `archive_expires_after="never"`), componente MUC con `muc_mam`, componente
  `upload.*` XEP-0363, y `mod_expo_push`/`mod_push_hints_filter` locales.
- **OMEMO2** activo en las cuentas (`protocol:"dual"`), venv Python 3.13 con
  `omemo==2.1.0` + `twomemo==2.1.0`.
- **Parches de core**: 13, todos aplicados (`2026.7.35`), vía
  `/opt/claudio-w/scripts/apply-openclaw-patches.py`; ahora también
  versionados en `scripts/openclaw-core-patches/`.