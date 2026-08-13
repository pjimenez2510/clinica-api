---
description: Puerta de calidad antes de marcar un entregable como [x] en el ROADMAP
argument-hint: "<qué entregable>  (p. ej. \"E1 de agenda\")"
allowed-tools: Read, Edit, Grep, Glob, Bash, Task
---

Entregable: **$ARGUMENTS**

Estado del árbol de trabajo:

!`git status --porcelain -uall -- src prisma test | head -30`

Verificación:

!`pnpm verify 2>&1 | tail -12`

## La puerta

Un entregable pasa a `[x]` **solo si todo esto se cumple de verdad**. No se
marca por «ya funciona en mi máquina», y no se marca a medias.

1. **`pnpm verify` en verde.** Sale arriba; si falla, no hay nada más que
   discutir.
2. **`pnpm test:integration` en verde** si se tocó la base de datos. Toda
   garantía que hace cumplir PostgreSQL necesita su prueba contra PostgreSQL
   real: un doble no demuestra que el constraint exista.
3. **Trazabilidad.** Si el módulo tiene `SPEC.md` en estado `vigente`, cada
   requisito tiene una prueba que lo nombra. Si sigue en `borrador`, decidir
   explícitamente si este entregable lo promueve.
4. **`pnpm rtm`** al día, y la columna «Refinado en» de `REQUISITOS.md`
   actualizada con lo que este entregable cubrió.
5. **Contrato de errores**: todo código nuevo está en el catálogo congelado y
   tiene prueba de su código, estado HTTP y mensaje.
6. **Autorización**: toda ruta nueva declara su permiso, y la prueba de rutas
   pasa.
7. **Revisión adversarial sobre el diff.** Lanzar el subagente
   `revisor-clinico`, y también los revisores de seguridad y de cobertura si el
   cambio los toca. **Lo que confirmen se corrige antes de marcar `[x]`**, no
   después.
8. **Semilla de desarrollo al día.** Si la entrega añadió pantallas o estados
   nuevos, `prisma/seed-*.mts` debe dejar datos con los que probarlos a mano
   (idempotente, y solo desarrollo). Una pantalla que nadie puede abrir con
   datos reales es una pantalla que nadie prueba.
9. **ROADMAP actualizado** con lo que de verdad quedó hecho, y la deuda que
   quedó abierta anotada donde se vea.

## Al terminar

Reportar con honestidad: qué quedó hecho, qué se dejó fuera y por qué, y qué
hallazgos de la revisión se corrigieron. Si algo no se pudo cerrar, decirlo en
lugar de marcarlo.

**No commitear ni hacer push** salvo que el usuario lo pida. Los commits no
mencionan a Claude ni a ninguna IA.
