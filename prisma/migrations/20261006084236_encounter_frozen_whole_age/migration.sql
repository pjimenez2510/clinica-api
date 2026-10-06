-- encounter_frozen_whole_age
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy


-- QUÉ GARANTIZA (EN-221, ORD-127; D-138.1, resuelta por el autor):
--
-- Que la atención congele la EDAD ENTERA EN DÍAS hasta su fecha clínica en
-- Ecuador, y si la fecha de nacimiento era ESTIMADA, con el mismo disparador
-- que ya congela años, meses y días sueltos. La bandera de laboratorio elige
-- el rango con ellas: corregir después la fecha de la ficha no cambia la edad
-- con que se clasifica una corrección del informe, y una fecha estimada no
-- elige un rango en días o en meses.
--
-- `age_days` no sirve para esto: es el resto tras años y meses (0–30), lo que
-- imprimen el 010 y la receta.
--
-- EL RELLENO: las atenciones existentes toman la fecha de nacimiento de la
-- ficha de HOY, que es la mejor que hay (la que usaba la bandera hasta ahora),
-- y su marca de estimada. Es un UPDATE de dos columnas nuevas: ningún
-- disparador de `encounter` mira esas columnas (los de UPDATE son por columna:
-- agenda, codificación y código de verificación), así que no hay que apagar
-- nada. Una fecha posterior a la atención da edad desconocida (NULL), como
-- hacía el código. Probado antes sobre una copia de la base del autor.

ALTER TABLE "encounter"
  ADD COLUMN IF NOT EXISTS "age_in_days" INTEGER,
  ADD COLUMN IF NOT EXISTS "age_estimated" BOOLEAN NOT NULL DEFAULT false;

UPDATE "encounter" e
   SET "age_in_days" = CASE
         WHEN p."birth_date" > (e."started_at" AT TIME ZONE 'America/Guayaquil')::date
         THEN NULL
         ELSE (e."started_at" AT TIME ZONE 'America/Guayaquil')::date - p."birth_date"
       END,
       "age_estimated" = p."birth_date_estimated"
  FROM "patient" p
 WHERE p."id" = e."patient_id";

CREATE OR REPLACE FUNCTION encounter_freeze_age()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_birth     date;
  v_estimated boolean;
  v_age       interval;
  v_date      date;
BEGIN
  v_date := (NEW.started_at AT TIME ZONE 'America/Guayaquil')::date;

  SELECT birth_date, birth_date_estimated INTO v_birth, v_estimated
    FROM patient WHERE id = NEW.patient_id;

  IF v_birth > v_date THEN
    RAISE EXCEPTION 'encounter starts before the patient was born'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_age := age(v_date, v_birth);
  NEW.age_years  := extract(year  from v_age)::int;
  NEW.age_months := extract(month from v_age)::int;
  NEW.age_days   := extract(day   from v_age)::int;
  -- EN-221. The whole age in days, and whether the date was an estimate.
  NEW.age_in_days   := v_date - v_birth;
  NEW.age_estimated := coalesce(v_estimated, false);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION encounter_age_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."age_in_days" IS DISTINCT FROM OLD."age_in_days"
     OR NEW."age_estimated" IS DISTINCT FROM OLD."age_estimated" THEN
    RAISE EXCEPTION 'La edad congelada de una atención no cambia (EN-221)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_encounter_age_frozen ON "encounter";
CREATE TRIGGER trg_encounter_age_frozen
  BEFORE UPDATE OF "age_in_days", "age_estimated" ON "encounter"
  FOR EACH ROW EXECUTE FUNCTION encounter_age_frozen();
