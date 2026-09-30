---
description: Redacta o amplía el SPEC.md de un módulo en formato EARS, trazado a los REQ de sistema
argument-hint: "<módulo>  (p. ej. agenda, encounter, prescription)"
allowed-tools: Read, Write, Edit, Grep, Glob, Bash
---

Módulo objetivo: **$1**

Estado actual del repositorio:

- Módulos con especificación: !`ls -d src/modules/*/SPEC.md 2>/dev/null | sed 's|src/modules/||;s|/SPEC.md||' | tr '\n' ' ' || echo "ninguno"`
- Módulos sin ella: !`for d in src/modules/*/; do m=$(basename $d); [ -f "$d/SPEC.md" ] || printf "%s " "$m"; done`

## Qué hacer

1. **Leer primero, escribir después.** Antes de redactar nada:
   - `../clinica-docs/REQUISITOS.md` — qué `REQ-###` debe refinar este módulo.
     Un requisito de módulo que no refina ningún REQ o es infraestructura, o
     falta el REQ.
   - `prisma/schema.prisma` y las migraciones — **qué garantiza ya la base**.
     Un requisito que repite un `EXCLUDE` existente se escribe citándolo; uno
     que necesita un campo inexistente se marca `> **Falta esquema.**`.
   - `src/modules/agenda/SPEC.md` como referencia de formato.

2. **Redactar en EARS.** Palabras clave fijadas: `CUANDO`, `MIENTRAS`,
   `SI … ENTONCES`, `DONDE`, y `DEBERÁ` como única obligación. Identificadores
   `<PREFIJO>-###` correlativos, que **nunca se reutilizan**.

3. **Secciones obligatorias**: alcance y fuera de alcance · vocabulario ·
   entregas priorizadas e independientemente comprobables · requisitos ·
   criterios de éxito `SC-###` medibles · supuestos · códigos de error nuevos ·
   niveles de prueba · preguntas abiertas con `[NECESITA ACLARACIÓN]` **junto al
   requisito que bloquean**.

4. **Nace en `**Estado:** borrador`.** Pasa a `vigente` solo cuando cada
   requisito tenga una prueba que lo nombre, porque en ese momento el CI empieza
   a exigirlo.

5. **Actualizar `../clinica-docs/REQUISITOS.md`**: rellenar la columna
   «Refinado en» de cada REQ que este módulo cubra, y correr `pnpm rtm:write`.

## El nombre del archivo

Siempre `SPEC.md`. **Nunca `spec.md` dentro de `src/modules/`**: este sistema de
archivos no distingue mayúsculas y destruiría el `SPEC.md`. Un hook lo bloquea.

## Lo que no debe pasar

- Requisitos que no se pueden verificar («intuitivo», «rápido», «visualmente
  claro»). Si no se puede escribir la prueba, no es un requisito.
- Presentación en la spec del backend. Cómo se ve es de `clinica-web`.
- Referenciar en lugar de enumerar. «Los grupos prioritarios de la
  Constitución» no especifica nada; la lista sí.
- Inventar normativa. Si no está en `ESPECIFICACION-SISTEMA-CLINICA-ECUADOR.md`
  ni se ha verificado en la fuente, se marca como pendiente de verificar.
