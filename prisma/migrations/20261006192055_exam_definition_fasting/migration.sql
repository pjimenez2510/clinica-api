-- exam_definition_fasting
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy



-- QUÉ GARANTIZA (ORD-129, D-137 A resuelta por el autor el 06-10-2026):
--
-- «Pide ayuno» y sus horas son un dato del examen, y no el comienzo del texto
-- de su preparación. La línea destacada de la orden («Venga con 8 horas de
-- ayuno como mínimo…») sale de aquí: un ayuno redactado de otro modo («Venir
-- sin desayunar») ya no se pierde.
--
--   1. `requires_fasting`, sí o no, por defecto no.
--   2. `fasting_hours`, las horas MÍNIMAS, de 1 a 24, opcional: sin ellas la
--      orden dice «Venga en ayunas».
--   3. Horas sólo con «Pide ayuno»: unas horas en un examen sin ayuno serían
--      un dato que nadie imprime y que contradice al otro.
--
-- RELLENO: cada examen cuya preparación EMPIEZA por «Ayuno» —la regla con la
-- que hasta hoy se imprimía la línea destacada (ORD-125)— queda con «Pide
-- ayuno», y sus horas son el primer número de la preparación si está entre 1 y
-- 24 («Ayuno de 8 a 12 horas» → 8: lo mínimo que el paciente cumple). El texto
-- de la preparación no se toca: se sigue imprimiendo entero bajo su examen.
-- Probado sobre una copia de la base del autor antes de aplicarlo.
--
-- PARA DESHACERLA: DROP de las dos columnas (las restricciones caen con ellas).

ALTER TABLE "exam_definition"
  ADD COLUMN "requires_fasting" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "fasting_hours" SMALLINT,
  ADD CONSTRAINT "exam_definition_fasting_hours_needs_fasting"
    CHECK ("fasting_hours" IS NULL OR "requires_fasting"),
  ADD CONSTRAINT "exam_definition_fasting_hours_range"
    CHECK ("fasting_hours" IS NULL OR "fasting_hours" BETWEEN 1 AND 24);

UPDATE "exam_definition"
   SET "requires_fasting" = true,
       "fasting_hours" = (
         SELECT CASE WHEN m[1]::int BETWEEN 1 AND 24 THEN m[1]::smallint END
           FROM regexp_match("patient_preparation", '([0-9]{1,2})') AS m
       )
 WHERE btrim("patient_preparation") ~* '^ayuno';
