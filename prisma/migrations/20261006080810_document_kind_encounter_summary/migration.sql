-- document_kind_encounter_summary
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy


-- QUÉ GARANTIZA (DOC-113): que el resumen de la atención sea una clase de
-- documento con su plantilla versionada, como la receta, la orden y el
-- certificado.
--
-- EN UNA MIGRACIÓN PROPIA porque un valor nuevo de un enum no se puede usar en
-- la misma transacción que lo añade, y la siguiente lo usa al publicar su
-- plantilla.
--
-- No abre ninguna puerta a archivarlo: `document_render_kind_matches_subject`
-- exige la columna de sujeto de cada clase, y esta no tiene ninguna, así que
-- ninguna fila de `document_render` puede ser de esta clase (DOC-111).

ALTER TYPE "document_kind" ADD VALUE IF NOT EXISTS 'ENCOUNTER_SUMMARY';
