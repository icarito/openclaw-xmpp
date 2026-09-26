# Audit: MAM & OMEMO

Auditar el plugin completo de XMPP para:

## MAM (XEP-0313)
- ¿Está implementado? ¿Dónde?
- ¿Se recuperan mensajes perdidos tras desconexión?
- ¿Hay paginación RSM (XEP-0059)?
- ¿Hay búsqueda de historial?
- ¿Interactúa correctamente con OMEMO y carbons (XEP-0280)?

## OMEMO (XEP-0384)
- ¿Soporta legacy + v2?
- ¿Maneja desincronización de ratchet cuando se pierden mensajes (sin MAM)?
- ¿MUC OMEMO funciona en salas anónimas y no-anónimas?
- ¿Verificación de fingerprints/de confianza?
- ¿Multi-dispositivo?
- ¿Rotación de pre-keys correcta?

## Entregable
Un reporte en `docs/features/audit-mam-omemo-report.md` con:
1. Hallazgos por subsistema
2. Riesgos clasificados (crítico/alto/medio/bajo)
3. Recomendaciones priorizadas
4. Plan de remediación sugerido

No modificar código. Solo lectura y reporte.
