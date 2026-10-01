-- exam_definition_tariff_code
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- QUÉ GARANTIZA (ORD-004): que la prestación del tarifario de una línea de
-- orden sea una propiedad del EXAMEN y no algo que el cliente envía al lado.
-- Hasta ahora cada línea llevaba dos identificadores —el ordenable y el
-- concepto del tarifario— y nada impedía emparejarlos mal: una biometría
-- facturada como glucosa.
--
-- POR QUÉ UN CÓDIGO Y NO `concept_id`. El tarifario se VERSIONA: cada
-- publicación crea filas nuevas de `catalog_concept` y retira las anteriores
-- (`valid_period`). Un `concept_id` en el examen apuntaría a una versión y se
-- quedaría retirado en la siguiente publicación sin que nadie lo tocara. El
-- código es estable; el concepto VIGENTE en la fecha clínica de la atención se
-- resuelve al emitir, dentro de la transacción (prisma-service-order.repository).
--
-- NULL es legítimo y significa «este examen no tiene prestación»: no se puede
-- pedir hasta que el catálogo la tenga, y se rechaza con
-- CATALOG_CONCEPT_NOT_FOUND en lugar de emitir una orden que no se puede cobrar.

ALTER TABLE "exam_definition"
  ADD COLUMN IF NOT EXISTS "tariff_code" VARCHAR(32);

-- Los exámenes que ya existen toman la prestación del mismo código, que es como
-- la semilla de desarrollo deriva el tarifario (seed-clinical-catalogues.mts).
UPDATE "exam_definition" ed
   SET "tariff_code" = ed."code"
 WHERE ed."tariff_code" IS NULL
   AND EXISTS (
     SELECT 1
       FROM "catalog_concept" cc
       JOIN "catalog_system" cs ON cs."id" = cc."system_id"
      WHERE cs."code" = 'TARIFF' AND cc."code" = ed."code"
   );
