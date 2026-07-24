## ADDED Requirements

### Requirement: Transcripción automática de audio entrante por XMPP
El plugin XMPP SHALL transcribir el primer adjunto de audio de un mensaje
entrante usando el runtime de transcripción del core de OpenClaw
(`transcribeFirstAudio`) antes de despachar la respuesta del agente, para
todas las cuentas XMPP configuradas.

#### Scenario: Mensaje con adjunto de audio soportado
- **WHEN** llega un mensaje XMPP con un adjunto de audio en un formato
  soportado (p. ej. Opus/OGG de nota de voz) y `tools.media.audio.enabled`
  es `true` en la config del gateway
- **THEN** el plugin invoca `transcribeFirstAudio` con el path local del
  adjunto ya descargado y anexa el transcripto resultante al contexto del
  mensaje entrante antes de que el agente genere su respuesta

#### Scenario: Transcripción deshabilitada globalmente
- **WHEN** llega un mensaje XMPP con adjunto de audio pero
  `tools.media.audio.enabled` es `false` en la config del gateway
- **THEN** el plugin no invoca la transcripción y el flujo de inbound
  continúa igual que hoy (sin transcripto)

### Requirement: Degradación no bloqueante ante fallo de transcripción
El plugin XMPP SHALL continuar el flujo normal de inbound y despacho de
respuesta aunque la transcripción de audio falle o no esté disponible,
sin abortar el turno ni propagar la excepción.

#### Scenario: Proveedor de transcripción falla
- **WHEN** `transcribeFirstAudio` lanza una excepción o excede el timeout
  configurado (proveedor caído, rate-limit, audio corrupto)
- **THEN** el plugin registra el error en el log (nivel verbose) y despacha
  la respuesta del agente sin transcripto, como si el audio no hubiera
  tenido transcripción disponible

#### Scenario: Adjunto de audio no soportado o demasiado pequeño
- **WHEN** el adjunto de audio no cumple el tamaño mínimo o formato
  soportado por `transcribeFirstAudio`
- **THEN** la función retorna `undefined` y el plugin despacha la
  respuesta del agente sin transcripto, sin generar error visible

### Requirement: Eco de transcripción configurable
El plugin XMPP SHALL enviar de vuelta al remitente un eco de texto del
transcripto cuando `tools.media.audio.echoTranscript` esté activo en la
config del gateway, usando el mecanismo de envío de mensajes nativo del
plugin XMPP.

#### Scenario: Eco habilitado
- **WHEN** la transcripción de un audio entrante se resuelve exitosamente
  y `tools.media.audio.echoTranscript` es `true`
- **THEN** el plugin envía un mensaje de vuelta al remitente en el mismo
  chat mostrando el texto transcrito

#### Scenario: Eco deshabilitado
- **WHEN** la transcripción de un audio entrante se resuelve exitosamente
  pero `tools.media.audio.echoTranscript` es `false` o no está definido
- **THEN** el plugin no envía ningún mensaje de eco; el transcripto solo
  se anexa al contexto interno que recibe el agente

### Requirement: Cobertura uniforme por cuenta XMPP
El comportamiento de transcripción automática SHALL aplicar de forma
idéntica a todas las cuentas XMPP configuradas en el gateway, sin requerir
configuración adicional por cuenta.

#### Scenario: Distintas cuentas reciben audio
- **WHEN** dos cuentas XMPP distintas (p. ej. `bob` y `clawdio`) reciben
  cada una un mensaje con adjunto de audio soportado
- **THEN** ambas transcripciones se resuelven de la misma forma, usando la
  misma configuración global `tools.media.audio`, sin diferencias de
  comportamiento entre cuentas
