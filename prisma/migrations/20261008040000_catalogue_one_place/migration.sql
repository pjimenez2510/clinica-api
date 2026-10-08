-- catalogue_one_place
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- QUÉ GARANTIZA (D-179, ORD-163, SP-031, BI-158): un dato, un sitio.
--
--  · El EXAMEN y su PRESTACIÓN son la misma cosa. El nombre y el código del
--    tarifario se escribían en `exam_definition` y otra vez en
--    `billable_service`, y nada obligaba a que coincidieran: una «Glucosa en
--    ayunas» podía facturarse como «Glucosa» con otro código del MSP. Ahora
--    viven sólo en la prestación; todo examen tiene la suya y ninguna
--    prestación cobra dos exámenes (si no, los dos se llamarían igual).
--
--  · El TIPO DE ATENCIÓN es lo que se cobra. La consulta se ataba a mano a la
--    especialidad y a primera vez o subsecuente (`billable_service.specialty_id`
--    y `visit_sequence`); ahora el tipo lleva sus prestaciones, en orden, y la
--    primera es la que caja propone.
--
-- ⚠️ BORRA LOS EXÁMENES, Y ES A PROPÓSITO. Decisión del autor (D-179, 07-10-2026):
-- en desarrollo los datos se pueden borrar y la migración NO reconcilia
-- diferencias. Se borran `exam_definition` y `exam_definition_analyte`; las
-- determinaciones, sus rangos, las órdenes y los resultados se quedan (las
-- líneas de orden citan el examen por código, `test_code`, y la semilla lo
-- vuelve a crear con el mismo). Después: `pnpm db:seed` (o
-- `pnpm db:seed:specialties`, que corre la de facturación detrás).
-- Cuando haya producción, una migración así lleva relleno y prueba sobre copia.

-- ─── 1. El examen lee su nombre y su tarifario de la prestación ────────────

DELETE FROM "exam_definition_analyte";
DELETE FROM "exam_definition";

ALTER TABLE "exam_definition"
  DROP COLUMN "tariff_code",
  DROP COLUMN "name",
  ALTER COLUMN "billable_service_id" SET NOT NULL;

-- El código del tarifario del examen admitía 32 caracteres; el de la prestación,
-- 16. Ahora sólo existe el segundo, y se ensancha para no estrechar el primero.
ALTER TABLE "billable_service" ALTER COLUMN "tariff_code" TYPE VARCHAR(32);

CREATE UNIQUE INDEX "exam_definition_one_per_service"
  ON "exam_definition" ("billable_service_id");

COMMENT ON COLUMN "exam_definition"."billable_service_id" IS
  'ORD-163 (D-179.1). La prestacion que ES este examen: de ella salen su nombre '
  'y su codigo del tarifario. Obligatoria, y una prestacion cobra a lo sumo un '
  'examen (exam_definition_one_per_service).';

-- ─── 2. El tipo de atención lleva sus prestaciones ─────────────────────────

CREATE TABLE "service_type_billable_service" (
  "service_type_id"     UUID     NOT NULL,
  "billable_service_id" UUID     NOT NULL,
  "position"            SMALLINT NOT NULL DEFAULT 0,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "service_type_billable_service_pkey"
    PRIMARY KEY ("service_type_id", "billable_service_id"),
  -- Borrar un tipo (sólo si ninguna cita lo nombra, SP-025) se lleva el
  -- enlace; la prestación se queda, desactivada por la aplicación (SP-030),
  -- porque un precio o un cargo pueden nombrarla.
  CONSTRAINT "service_type_billable_service_type_fk"
    FOREIGN KEY ("service_type_id") REFERENCES "service_type"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "service_type_billable_service_service_fk"
    FOREIGN KEY ("billable_service_id") REFERENCES "billable_service"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "service_type_billable_service_position_range"
    CHECK ("position" >= 0)
);

-- SP-031. Una posición por tipo: «la primera» tiene que ser una sola.
CREATE UNIQUE INDEX "service_type_billable_service_one_per_position"
  ON "service_type_billable_service" ("service_type_id", "position");

CREATE INDEX "service_type_billable_service_by_service"
  ON "service_type_billable_service" ("billable_service_id");

COMMENT ON TABLE "service_type_billable_service" IS
  'SP-030, SP-031, BI-158 (D-179.3). Lo que se cobra por un tipo de atencion, en '
  'orden. La posicion 0 nace con el tipo, se renombra con el y es la consulta '
  'que caja propone.';

-- Las consultas de antes pasan a su tipo de atención: primera vez → «Primera
-- vez», subsecuente → «Control», los dos tipos de arranque (SP-020). Lo que no
-- encuentra su tipo se queda sin atar y la semilla lo ata o crea el suyo.
INSERT INTO "service_type_billable_service" ("service_type_id", "billable_service_id", "position")
SELECT DISTINCT ON ("type"."id") "type"."id", "service"."id", 0
  FROM "billable_service" AS "service"
  JOIN "service_type" AS "type"
    ON "type"."specialty_id" = "service"."specialty_id"
   AND lower("type"."name") = CASE "service"."visit_sequence"
                                WHEN 'FIRST_TIME' THEN 'primera vez'
                                ELSE 'control'
                              END
 WHERE "service"."specialty_id" IS NOT NULL
 ORDER BY "type"."id", "service"."code";

-- `billable_service_one_per_consultation` cae con la columna `specialty_id`.
ALTER TABLE "billable_service"
  DROP CONSTRAINT IF EXISTS "billable_service_consultation_states_both",
  DROP CONSTRAINT IF EXISTS "billable_service_visit_sequence_is_known",
  DROP CONSTRAINT IF EXISTS "billable_service_specialty_fk",
  DROP COLUMN "specialty_id",
  DROP COLUMN "visit_sequence";

COMMENT ON COLUMN "billable_service_category"."kind" IS
  'BI-186, BI-187. What structure a service of this category admits: a consultation is charged through service_type_billable_service, a procedure maps to a procedure concept, an exam is charged through exam_definition.';
