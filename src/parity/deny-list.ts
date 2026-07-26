// Deny-list motivada: por qué cada comando del registro nativo NO se expone
// hoy por XEP-0050.
//
// Antes esto era implícito -- `EXPOSED_NATIVE_COMMAND_KEYS` decía qué entra y
// los otros 41 quedaban afuera sin registro de por qué, lo que hacía imposible
// distinguir "no tiene sentido en XMPP" de "nadie lo revisó todavía". Cada
// entrada acá es una decisión escrita, y el test de paridad falla si aparece un
// comando que no esté ni expuesto ni denegado, forzando la decisión en cada
// upgrade de openclaw.
//
// Los motivos que empiezan con "FASE 3:" son candidatos activos a exponerse
// cuando se reemplace la allowlist por filtrado por tier -- no son rechazos.

export const DENY_REASONS: Record<string, string> = {
  // --- Ya cubiertos por otra vía en este plugin -------------------------------
  help: "Ya cubierto: TextualFallback expone `/oc help` y disco#items lista los comandos reales; un nodo XEP-0050 'help' duplicaría el listado que el propio protocolo ya provee.",
  commands: "Ya cubierto por disco#items, que ES el mecanismo de descubrimiento de comandos en XMPP. Exponerlo sería reimplementar el protocolo dentro de sí mismo.",
  approve: "Ya cubierto por la ruta nativa de approvals: `tryResolveXmppApprovalCommand` intercepta `/approve` antes del pipeline y lo resuelve vía gateway, porque la sesión está bloqueada esperando la decisión.",
  stop: "Ya cubierto por el nodo `abort` de este plugin (buildAbortAction), que reescribe a `/stop` porque el core no reconoce el literal `/abort`.",

  // --- Candidatos de la Fase 3 (menú por tier) --------------------------------
  status: "FASE 3: candidato directo. Sin argumentos, degrada perfecto a XEP-0050 sin formulario. Hoy existe un nodo `status` propio del plugin que habría que reconciliar con el del registro.",
  think: "FASE 3: candidato. Un solo argumento con choices → list-single de XEP-0004.",
  tools: "FASE 3: candidato. Listado sin argumentos.",
  skill: "FASE 3: bloqueado por el wire-up de skill commands. `listSkillCommandsForAgents`/`resolveSkillCommandInvocation` existen en el SDK, pero inbound.ts no pasa `skillCommands` a hasControlCommand/shouldHandleTextCommands, así que hoy no se detectarían como control commands. Ejercita además la ruta multi-campo (name+input).",
  goal: "FASE 3: candidato. Argumento de texto libre → text-single.",
  diagnostics: "FASE 3: candidato. Listado sin argumentos.",
  tasks: "FASE 3: candidato. Listado sin argumentos.",
  learn: "FASE 3: candidato con argumento de texto libre.",
  btw: "FASE 3: candidato con argumento de texto libre.",
  usage: "FASE 3: candidato. Reporte sin argumentos; se solapa parcialmente con el `/credit` local del plugin.",
  name: "FASE 3: candidato. Un argumento de texto → text-single.",
  verbose: "FASE 3: candidato. Toggle con choices → list-single.",
  fast: "FASE 3: candidato. Toggle con choices → list-single.",
  reasoning: "FASE 3: candidato. Choices → list-single.",
  models: "FASE 3: se solapa con el menú `/models` que el plugin ya implementa con botones inline (commands.ts). Decidir si el nodo del registro reemplaza esa implementación propia o convive.",
  elevated: "FASE 3 (xmpp-elevated-session-command): el plugin ya expone un nodo `elevated` propio (src/elevated-session.ts) que opera sobre el mismo SessionEntry.elevatedLevel del core, con TTL y persistencia fail-closed -- no es el nodo del registro nativo del core montado directo, sino una reimplementación con semántica on/off/status acotada (ver design.md D2: no expone los cuatro niveles del core, sólo full vs no-full). Sigue denegado en el sentido de 'no se monta el nodo nativo del registro', porque la necesidad ya está cubierta por la implementación propia del plugin.",
  whoami: "FASE 3: candidato. Sin argumentos.",
  session: "FASE 3: candidato, pero con subcomandos que hay que mapear a un formulario en vez de a texto posicional.",
  queue: "FASE 3: candidato. Inspección de cola sin argumentos.",
  trace: "FASE 3: candidato de diagnóstico, tier power.",
  steer: "FASE 3: candidato. Texto libre hacia un turno en curso; verificar interacción con el guard de sesión.",
  subagents: "FASE 3: candidato de listado.",
  agents: "FASE 3: candidato de listado.",

  // --- Requieren UI que este canal no renderiza -------------------------------
  tts: "Requiere superficie de media saliente por comando; el plugin ya entrega audio por XEP-0363 pero no tiene flujo de 'generá audio de esto' vía ad-hoc command. Necesita diseño, no wire-up mecánico.",
  send: "Asume selector de destinatario/canal (Telegram lo hace con menús de argumento). En XMPP habría que construir el formulario de destino a mano y el riesgo de mandar a un JID equivocado es alto.",
  acp: "Flujo interactivo multi-paso de binding; no degrada a un formulario de un solo submit.",
  activation: "Flujo de configuración con estado; asume UI de administración, no un ad-hoc command de una pasada.",

  // --- Tier power con superficie de cambio de configuración -------------------
  config: "Muta configuración persistente. Tier de confianza distinto al de un comando de chat: hoy la autorización del plugin es `allowFrom`, sin roles. Requiere decisión de diseño explícita antes de exponerlo.",
  plugins: "Administración del runtime de plugins; mismo problema de tier de confianza que `config`.",
  mcp: "Administración de servidores MCP; mismo problema de tier de confianza que `config`.",
  restart: "Reinicia el runtime. Exponerlo por chat sin un gate de rol es un pie de bala, sobre todo con 8 agentes compartiendo gateway.",
  exec: "Cambia la política de exec de la sesión. Se solapaba con `approval-bypass`/`approval-mode` de este plugin (ambos retirados en xmpp-elevated-session-command, Fase 3, en favor de `elevated`); sigue sin exponerse el nodo nativo del registro porque `elevated` ya cubre la necesidad real de bypass de sesión.",
  debug: "Diagnóstico de bajo nivel con salida verbosa que no encaja en el límite de body de XMPP (4000 chars) sin chunking dedicado.",
  focus: "Gestión de foco de agente; semántica poco clara fuera de la UI interactiva.",
  unfocus: "Contraparte de `focus`; misma razón.",

  // --- Salida incompatible con el transporte ----------------------------------
  "export-session": "Produce un artefacto de archivo, no un mensaje. Necesitaría subirse por XEP-0363 y devolverse como OOB; es trabajo de diseño, no exposición mecánica.",
  "export-trajectory": "Mismo caso que `export-session`: artefacto de archivo, no texto de chat.",
};

/** Comandos del registro deliberadamente no expuestos, con motivo escrito. */
export function isDenied(commandName: string): boolean {
  return Object.hasOwn(DENY_REASONS, commandName);
}
