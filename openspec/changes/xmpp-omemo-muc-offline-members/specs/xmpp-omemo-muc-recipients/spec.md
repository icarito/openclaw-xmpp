## ADDED Requirements

### Requirement: Destinatarios completos de OMEMO MUC
El plugin SHALL incluir los dispositivos de todos los `member`, `admin` y `owner` de una MUC no anónima al cifrar mensajes grupales, aunque no estén conectados en ese momento.

#### Scenario: Propietario ausente
- **WHEN** el propietario no figura entre los ocupantes presentes pero sí en la lista de afiliaciones
- **THEN** el mensaje saliente incluye una clave para cada dispositivo compatible del propietario

### Requirement: Fallo visible ante roster o cifrado incompleto
El plugin SHALL rechazar el envío cuando no pueda obtener una de las tres listas o no pueda cifrar para todos los dispositivos destinatarios, sin degradar silenciosamente a texto plano ni publicar un sobre parcial.

#### Scenario: Lista de propietarios no disponible
- **WHEN** la consulta IQ de propietarios falla
- **THEN** el envío devuelve un error y no publica el mensaje grupal
