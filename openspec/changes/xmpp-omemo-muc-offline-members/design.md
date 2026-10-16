## Context

El código actual deriva los destinatarios de presencias MUC (`getRoomOccupantJids`). La consulta real con la cuenta Operator confirmó que Prosody devuelve las tres listas XEP-0045 en `engineering`, incluido el propietario ausente, sin elevar privilegios. XEP-0384 §5.8.1 exige la unión de miembros, administradores y propietarios, incluso desconectados.

## Decision

Consultar las tres afiliaciones con IQ `muc#admin` en cada envío; no cachear para evitar listas obsoletas tras cambios de afiliación. Unir la lista con los ocupantes presentes, excluir el propio JID y deduplicar. Si una consulta falla o una clave no se puede cifrar, abortar el envío y comunicar el error al llamador; nunca publicar un sobre OMEMO parcial ni degradar a texto plano por ese motivo.

## Verification

Prueba unitaria con propietario ausente, fallo de consulta y JID inválido; TypeScript sin errores. Después de desplegar, una respuesta real en `engineering` mientras Sebastián está ausente debe incluir su JID y dispositivos en las cabeceras OMEMO archivadas. No leer ni imprimir contenido ni material de claves.
