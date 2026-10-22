## Implementación

- [x] Consultar afiliaciones `member`, `admin` y `owner` antes de cifrar OMEMO MUC.
- [x] Incluir propietarios ausentes y rechazar consultas o claves incompletas.
- [x] Probar el caso del propietario ausente y los fallos de roster; ejecutar TypeScript.

## Producción

- [ ] Desplegar con respaldo y comprobar una respuesta real en la sala con el propietario ausente.
- [ ] Confirmar que la cabecera archivada incluye dispositivos de todos los afiliados y que Sebastián puede descifrarla.
