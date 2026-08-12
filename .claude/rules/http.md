---
paths:
  - "src/**/*.controller.ts"
  - "src/**/dto/**/*.ts"
  - "src/shared/http/**/*.ts"
  - "src/**/*.guard.ts"
  - "src/**/*.interceptor.ts"
---

# Capa HTTP: controladores, DTO, guards

## Cerrado por defecto

- **Toda ruta declara su permiso.** Una ruta sin declaración se rechaza, y una
  prueba recorre las rutas que NestJS registró de verdad y falla si alguna no lo
  declara, si nombra un permiso inexistente o si creció la superficie pública.
- El alcance por sede se comprueba **además** del rol. Un usuario con el permiso
  correcto sobre una sede que no es la suya recibe `SITE_SCOPE_DENIED`.
- Añadir un endpoint es añadir su declaración de permiso en el mismo commit. No
  «después».

## Contrato de errores

- RFC 9457 con `application/problem+json`.
- `title` legible por humanos y `code` estable en inglés, **separados**. El
  cliente ramifica por `code`; el usuario lee `title`.
- Errores por campo en `errors[]` para validación de dominio y de esquema.
- Los códigos derivados del estado (`NOT_FOUND`, `PAYLOAD_TOO_LARGE`) y los del
  mapeo de PostgreSQL (`PRACTITIONER_SLOT_TAKEN`) **no** entran en el catálogo
  congelado: tienen sus propias tablas, que ya son la enumeración.

## Qué nunca sale en una respuesta ni en un log

- Nombre, documento, motivo de consulta o cualquier dato clínico de un paciente
  en un mensaje de error.
- La diferencia entre cuenta inexistente, inactiva y bloqueada: eso enumera al
  personal de la clínica. Las tres responden igual.
- **Nunca se interpolan variables en una llamada de log.** Hay regla de ESLint.
  El logger poda PHI por lista blanca y falla cerrado; interpolar la esquiva.

## Mensajes al usuario

En español, dirigidos a quien los lee —recepcionista, médico, cajera—, diciendo
**qué hacer**, no qué falló internamente. «Ese horario ya está ocupado por otra
cita», no «constraint violation on agenda_entry». Ver ADR-005.

## DTO

- La validación de entrada es una frontera, no una formalidad: lo que no valida
  el DTO acaba validándolo la base con un mensaje peor.
- El DTO no es el modelo de dominio. Que coincidan hoy no obliga a que coincidan
  mañana.
