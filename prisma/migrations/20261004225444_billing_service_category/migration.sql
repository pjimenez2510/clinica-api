-- billing_service_category
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- QUÉ GARANTIZA (billing/SPEC.md B11, BI-185 y BI-186; revisión de usabilidad
-- del autor del 04-10-2026: «catálogos en vez de texto libre»).
--
--  · La categoría de una prestación deja de ser texto libre y pasa a ser una
--    fila de `billable_service_category`. El texto producía «Laboratorio»,
--    «laboratorio» y «Lab.» en el mismo informe, y no decía qué estructura
--    admite la prestación.
--  · Toda prestación apunta a una categoría (`category_id` NOT NULL), y una
--    categoría que alguna prestación usa no se borra (`RESTRICT`): se
--    desactiva, como la prestación misma (BI-014).
--  · El nombre es único sin distinguir mayúsculas
--    (`billable_service_category_name_unique`, sobre `lower(name)`).
--  · La clase es una de seis (`billable_service_category_kind_is_known`):
--    las de una orden (`service_order_category`: LABORATORY, IMAGING,
--    PROCEDURE) más CONSULTATION, SUPPLY y OTHER. Texto y no enum, por la misma
--    razón que `visit_sequence` aquí: el catálogo económico evoluciona sin
--    depender de un tipo del esquema clínico.
--
-- LOS DATOS QUE YA HAY. Cada nombre distinto de la columna vieja (sin
-- distinguir mayúsculas ni espacios) se convierte en una categoría; uno vacío,
-- en «Sin categoría». Su clase sale PRIMERO de lo que sus prestaciones ya
-- tienen atado —una consulta de especialidad, un procedimiento, un examen del
-- catálogo—, que son hechos, y sólo si no hay nada atado, de los cinco nombres
-- de la siembra (Consultas, Procedimientos, Laboratorio, Imagen, Insumos). El
-- resto queda OTHER, y se reclasifica en pantalla cuando nada de lo atado choca
-- (BI-187). No es inferir nada que decida un importe (BI-005): la clase sólo
-- dice qué estructura admite la prestación.
--
-- Y UN ÍNDICE PARA «POR COBRAR» (BI-181): las atenciones terminadas de una
-- sede por su fin. Sin él, la lista de caja recorre toda la historia de la sede.
--
-- Después: pnpm migrations:check && pnpm db:deploy

CREATE TABLE "billable_service_category" (
  "id"         UUID         NOT NULL DEFAULT uuidv7(),
  "name"       VARCHAR(60)  NOT NULL,
  "kind"       VARCHAR(16)  NOT NULL,
  "active"     BOOLEAN      NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "billable_service_category_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billable_service_category_kind_is_known" CHECK (
    "kind" IN ('CONSULTATION', 'PROCEDURE', 'LABORATORY', 'IMAGING', 'SUPPLY', 'OTHER')
  ),
  CONSTRAINT "billable_service_category_name_not_blank" CHECK (btrim("name") <> '')
);

CREATE UNIQUE INDEX "billable_service_category_name_unique"
  ON "billable_service_category" (lower("name"));

COMMENT ON TABLE "billable_service_category" IS
  'BI-185. The categories of the billable services, as a catalogue the clinic administers. Deactivated, never deleted while a service uses one.';
COMMENT ON COLUMN "billable_service_category"."kind" IS
  'BI-186, BI-187. What structure a service of this category admits: a consultation maps to a specialty, a procedure to a procedure concept, an exam is charged through exam_definition.';

-- Las categorías que ya existen, desde el texto.
CREATE TEMPORARY TABLE "category_text" AS
SELECT "service"."id" AS "service_id",
       COALESCE(NULLIF(btrim("service"."category"), ''), 'Sin categoría') AS "name",
       "service"."specialty_id" IS NOT NULL AS "is_consultation",
       "service"."procedure_concept_id" IS NOT NULL AS "is_procedure",
       EXISTS (SELECT 1 FROM "exam_definition" AS "exam"
                WHERE "exam"."billable_service_id" = "service"."id") AS "is_exam"
  FROM "billable_service" AS "service";

INSERT INTO "billable_service_category" ("name", "kind")
SELECT min("name"),
       CASE
         WHEN bool_or("is_consultation") THEN 'CONSULTATION'
         WHEN bool_or("is_procedure")    THEN 'PROCEDURE'
         WHEN bool_or("is_exam") AND lower(min("name")) = 'imagen' THEN 'IMAGING'
         WHEN bool_or("is_exam")         THEN 'LABORATORY'
         ELSE CASE lower(min("name"))
                WHEN 'consultas'      THEN 'CONSULTATION'
                WHEN 'procedimientos' THEN 'PROCEDURE'
                WHEN 'laboratorio'    THEN 'LABORATORY'
                WHEN 'imagen'         THEN 'IMAGING'
                WHEN 'insumos'        THEN 'SUPPLY'
                ELSE 'OTHER'
              END
       END
  FROM "category_text"
 GROUP BY lower("name");

ALTER TABLE "billable_service" ADD COLUMN "category_id" UUID;

UPDATE "billable_service" AS "service"
   SET "category_id" = "category"."id"
  FROM "category_text" AS "text", "billable_service_category" AS "category"
 WHERE "text"."service_id" = "service"."id"
   AND lower("category"."name") = lower("text"."name");

DROP TABLE "category_text";

ALTER TABLE "billable_service" ALTER COLUMN "category_id" SET NOT NULL;

ALTER TABLE "billable_service"
  ADD CONSTRAINT "billable_service_category_fk"
  FOREIGN KEY ("category_id") REFERENCES "billable_service_category"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Se lleva consigo `billable_service_by_category`, que la indexaba por texto, y
-- se rehace con el mismo nombre sobre la referencia: la lista del catálogo se
-- sigue pidiendo por categoría y nombre.
ALTER TABLE "billable_service" DROP COLUMN "category";

CREATE INDEX "billable_service_by_category"
  ON "billable_service" ("category_id", "name");

-- BI-181. Lo que caja tiene pendiente: atenciones terminadas de una sede, por
-- su fin. NO parcial a propósito: Prisma manda el `status IN (...)` con
-- parámetros, y con un plan genérico PostgreSQL no puede demostrar el
-- predicado de un índice parcial y no lo usaría. Las abiertas tienen `ended_at`
-- nulo y no estorban.
CREATE INDEX "encounter_ended_by_site"
  ON "encounter" ("site_id", "ended_at" DESC);
