-- analyte_active_name_unique
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy


-- QUÉ GARANTIZA (orders/SPEC.md ORD-104; revisión de `fix/atencion-examenes`).
--
-- Dos determinaciones activas no se llaman igual. Hoy un resultado se ata a su
-- determinación por el NOMBRE que congeló (`observation_result.analyte_display`,
-- ORD-031: falta la columna de identificador), y la completitud de una línea
-- (ORD-039) y la corrección de un informe (ORD-055) comparan por ese nombre.
-- Dos activas con el mismo nombre se confundirían en las dos. Sin distinguir
-- mayúsculas ni espacios de los extremos; una desactivada libera el nombre.

CREATE UNIQUE INDEX "analyte_definition_active_name_unique"
  ON "analyte_definition" (lower(btrim("name")))
  WHERE "active";
