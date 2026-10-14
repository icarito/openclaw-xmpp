## Decisiones

- La factory del tool solo lo ofrece a `operator` por XMPP con cuenta
  `operator`; la ejecución vuelve a validar el contexto.
- En MUC se extrae el JID del sufijo confiable `nick <real-JID>`. Un nick sin
  ese sufijo nunca se interpreta como identidad.
- `start` requiere que `room_jid` coincida con el destino `channel:` actual.
  Solo el JID propietario puede iniciar o detener.
- El socket y el daemon son la frontera local de privilegio; el tool no recibe
  tokens ni construye comandos de shell.
