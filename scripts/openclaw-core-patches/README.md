# Parches al core de OpenClaw (paridad de aprobaciones XMPP)

`apply-openclaw-patches.py` re-aplica, de forma idempotente, un conjunto de
parches al bundle `dist` de OpenClaw. Son **necesarios solo para la paridad
completa de aprobaciones de exec** con el transporte nativo de Telegram; sin
ellos el canal XMPP funciona, pero las cards usan el camino asíncrono (frágil)
y el timeout es de 30 min en vez de 5. El detalle de cada parche está en el
propio archivo y en `INSTALL.md` §6.

Este directorio es el registro versionado del script; en la instalación de
referencia corre desde `/opt/claudio-w/scripts/apply-openclaw-patches.py` como
`ExecStartPre` del servicio del gateway.

## Requisitos

- `openclaw` instalado en el host, **en la versión contra la que se verificaron
  los anchors** (por defecto `2026.7.35`). Un upgrade mueve el código que los
  anchors buscan y el precheck **falla cerrado** si la versión no coincide.
- Python 3 y `node` en el `PATH` (el script valida cada parche con
  `node --check` antes de escribirlo).

## Uso

```bash
# Detectar rutas de una instalación estándar
export OPENCLAW_ROOT="$(npm root -g)/openclaw"
export OPENCLAW_DIST="$OPENCLAW_ROOT/dist"
export OPENCLAW_PACKAGE_JSON="$OPENCLAW_ROOT/package.json"
export OPENCLAW_AGENTS_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents"

# 1. Solo verificar (no escribe nada). Falla si la versión no coincide o hay
#    anchors ambiguos.
python3 apply-openclaw-patches.py --precheck-only

# 2. Aplicar
python3 apply-openclaw-patches.py
```

En un servicio systemd, como `ExecStartPre` (así lo hace la instalación de
referencia):

```ini
[Service]
ExecStartPre=/usr/bin/python3 /opt/tu-ruta/apply-openclaw-patches.py --precheck-only
ExecStartPre=/usr/bin/python3 /opt/tu-ruta/apply-openclaw-patches.py
```

## Variables de entorno

| Variable | Default (referencia claudio-w) | Qué es |
|---|---|---|
| `OPENCLAW_DIST` | `/opt/claudio-w/npm-global/lib/node_modules/openclaw/dist` | Directorio `dist` del paquete openclaw |
| `OPENCLAW_PACKAGE_JSON` | `/opt/claudio-w/npm-global/lib/node_modules/openclaw/package.json` | `package.json` del paquete openclaw (para el precheck de versión) |
| `OPENCLAW_AGENTS_DIR` | `/opt/claudio-w/openclaw-home/agents` | `$STATE/agents`; usado por la purga de sesiones de canal huérfanas |
| `EXPECTED_OPENCLAW_VERSION` | `2026.7.35` | Versión contra la que se verificaron los anchors |

## Advertencias

- **Un upgrade de OpenClaw exige revisar los anchors.** El precheck de versión
  es la única red: si actualizás `openclaw`, ajustá `EXPECTED_OPENCLAW_VERSION`
  y re-verificá que cada parche siga encontrando su bloque (mirá el reporte
  final: un `!` significa "sin candidato / ambiguo", no "al día").
- **Modifica archivos de un paquete de terceros.** Un `npm i -g openclaw`
  reinstala el bundle limpio y los parches se re-aplican en el próximo arranque
  (por eso van en `ExecStartPre`). Nunca lo corras contra un `dist` que no
  controles.
- **No es un fork ni un reemplazo del core.** Son parches quirúrgicos y
  reversibles; si upstream incorpora el comportamiento, el parche queda
  obsoleto y hay que retirarlo (varios ya se retiraron así).