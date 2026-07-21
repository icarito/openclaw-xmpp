# Módulos Prosody

Módulos Lua que corren dentro del propio servidor Prosody
(`hablar.fuentelibre.org`), no en el proceso Node del plugin. Se despliegan
manualmente por SSH — no hay pipeline de build ni CI que los sincronice; este
directorio es el registro versionado de lo que corre en producción, la copia
real vive en `/usr/local/lib/prosody/modules/` del servidor.

- **`mod_expo_push.lua`**: puente entre XEP-0357 (cloud_notify) y Expo Push
  Service, usado por el cliente Android. Incluye una ventana de coalescing
  (`expo_push_coalesce_seconds`, default 8s) que agrupa varios push
  consecutivos del mismo remitente en una sola notificación.
- **`mod_push_hints_filter.lua`**: hace que `urn:xmpp:hints` (`<no-store/>`,
  `<no-permanent-store/>`) también suprima push/almacenamiento offline, no
  solo el archivado MAM (que ya lo respeta vía `mod_mam` stock). El gateway
  marca cada edición intermedia de streaming XEP-0308 con este hint — sin
  este módulo, esas ediciones igual disparaban push si el destinatario
  estaba desconectado en ese instante.

## Deploy

```bash
scp prosody-modules/*.lua icarito@187.127.47.38:/tmp/
ssh icarito@187.127.47.38
sudo cp /tmp/mod_*.lua /usr/local/lib/prosody/modules/
sudo chown root:root /usr/local/lib/prosody/modules/mod_*.lua
sudo chmod 644 /usr/local/lib/prosody/modules/mod_*.lua
# agregar "push_hints_filter" a modules_enabled en /etc/prosody/prosody.cfg.lua
# si es la primera vez que se carga ese módulo
sudo prosodyctl check config
sudo systemctl restart prosody   # reload (SIGHUP) NO carga módulos nuevos de forma confiable
```

Verificar en `/var/log/prosody/prosody.log` tras el restart: debe aparecer
`Expo push bridge loaded ... (coalesce window: Ns)` y `push_hints_filter
loaded`.
