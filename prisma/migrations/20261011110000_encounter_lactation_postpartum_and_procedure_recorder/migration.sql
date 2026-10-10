-- encounter_lactation_postpartum_and_procedure_recorder
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio:
-- propone borrar las columnas generadas, los índices GIN y BRIN, los índices
-- únicos parciales y los disparadores, porque schema.prisma no puede
-- describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. EN-260 (D-202.1): LA PUÉRPERA DE TRES MESES, A CUALQUIER EDAD
-- ═══════════════════════════════════════════════════════════════════════════
--
-- D-202, aceptada por el autor el 10-10-2026: el MSP da el hierro con ácido
-- fólico a la lactante «hasta los tres meses post-parto», sin edad. Se
-- mantiene la mujer de 10 a 49 y se pregunta además la lactancia a la mujer
-- de cualquier edad cuya ficha —o una ficha que ésta absorbió, como
-- `encounter_is_pregnant`— tenga un registro PREGNANT TERMINADO: `ends_on`
-- antes de la fecha clínica de la atención (en America/Guayaquil) y no antes
-- de tres meses de calendario. Con `ends_on` el mismo día o después sigue
-- embarazada (`encounter_is_pregnant`), no puérpera.
--
-- Un dato en un sitio: `encounter_asks_lactation` es a quién se le pregunta,
-- y la leen el bloque H (`encounter_nutrition_applies`) y el hierro con
-- ácido fólico (`encounter_is_lactating` → `encounter_supplement_applies`).
-- Los rechazos se llaman como antes (encounter.constraints.ts).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 2. EN-247 (D-201): QUIÉN REGISTRÓ EL PROCEDIMIENTO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La anotación tardía se identifica con su fecha y su AUTOR («Registrado el
-- … por …, tras el alta»). `recorded_at` ya dice cuándo; `recorded_by_id`
-- dice quién lo tecleó, con el reloj de la aplicación y la sesión del
-- servicio. Nulo en lo registrado antes: ese dato no está en la fila y no se
-- inventa (la bitácora lo tiene, y no es la historia). Los dos no cambian
-- después: lo que dicen es de quién responde de la fila; y toda fila NUEVA
-- los lleva (`encounter_procedure_recorded`), también desde psql. Al quitar,
-- el archivo los guarda tal cual (`encounter_procedure_retraction_matches`):
-- restaurar es registrar de nuevo (EN-246) y la fila restaurada es de quien
-- la restaura, pero quién tecleó la original sigue en el archivo.
--
-- Ninguna fila guardada se toca, y ningún `now()`.
-- Después: pnpm migrations:check && pnpm db:deploy

-- ── 1. La puérpera ─────────────────────────────────────────────────────────

CREATE FUNCTION encounter_is_postpartum(p_encounter_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM encounter e
      JOIN patient p ON p.id = e.patient_id OR p.merged_into_id = e.patient_id
      JOIN patient_priority_group g ON g.patient_id = p.id
     WHERE e.id = p_encounter_id
       AND g.group_code = 'PREGNANT'
       AND g.ends_on IS NOT NULL
       AND g.ends_on < (e.started_at AT TIME ZONE 'America/Guayaquil')::date
       AND g.ends_on >= ((e.started_at AT TIME ZONE 'America/Guayaquil')::date
                         - interval '3 months')::date
  );
$$;

-- EN-260. A quién se le pregunta su propia lactancia (la columna 52 de su
-- fila): la mujer de 10 a 49 años por la edad congelada, o la puérpera.
CREATE FUNCTION encounter_asks_lactation(p_encounter_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM encounter e
      JOIN patient p ON p.id = e.patient_id
     WHERE e.id = p_encounter_id
       AND p.sex = 'FEMALE'
       -- Without a frozen age nothing is asked, as in `nutritionBandOf`; and
       -- an infant is asked the infant's questions even if a chart she
       -- absorbed by mistake carries a pregnancy (the infant's band wins).
       AND e.age_years IS NOT NULL
       AND (e.age_years BETWEEN 10 AND 49
            OR (e.age_years >= 1 AND encounter_is_postpartum(e.id)))
  );
$$;

CREATE OR REPLACE FUNCTION encounter_is_lactating(p_encounter_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT encounter_asks_lactation(p_encounter_id)
     AND EXISTS (
       SELECT 1
         FROM encounter_nutrition n
        WHERE n.encounter_id = p_encounter_id
          AND n.mother_breastfeeding
     );
$$;

CREATE OR REPLACE FUNCTION encounter_nutrition_applies()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  years  integer;
  months integer;
BEGIN
  SELECT e.age_years, e.age_months INTO years, months
    FROM encounter e
   WHERE e.id = NEW.encounter_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- EN-260. The woman of 10 to 49, or of any age after a pregnancy ended
  -- three months ago or less: only column 52, her own answer.
  IF encounter_asks_lactation(NEW.encounter_id) THEN
    IF NEW.exclusive_breastfeeding IS NOT NULL OR NEW.complementary_feeding IS NOT NULL THEN
      RAISE EXCEPTION 'encounter_nutrition_applies: the questions about the infant are not asked to the woman herself'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'encounter_nutrition_applies';
    END IF;
    RETURN NEW;
  END IF;

  IF years IS NULL OR months IS NULL OR years > 0 OR months > 8 THEN
    RAISE EXCEPTION 'encounter_nutrition_applies: the attention is neither of an infant of 8 months or less nor of a woman asked her own lactation'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'encounter_nutrition_applies';
  END IF;

  IF months <= 5 THEN
    IF NEW.complementary_feeding IS NOT NULL THEN
      RAISE EXCEPTION 'encounter_nutrition_applies: solid food is asked from 6 to 8 months'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'encounter_nutrition_applies';
    END IF;
    IF NEW.exclusive_breastfeeding IS NULL THEN
      RAISE EXCEPTION 'encounter_nutrition_exclusive_required: only breast milk is asked from 0 to 5 months'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'encounter_nutrition_exclusive_required';
    END IF;
  ELSE
    IF NEW.exclusive_breastfeeding IS NOT NULL THEN
      RAISE EXCEPTION 'encounter_nutrition_applies: only breast milk is asked from 0 to 5 months'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'encounter_nutrition_applies';
    END IF;
    IF NEW.complementary_feeding IS NULL THEN
      RAISE EXCEPTION 'encounter_nutrition_complementary_required: solid food is asked from 6 to 8 months'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'encounter_nutrition_complementary_required';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON TABLE "encounter_nutrition" IS
  'EN-092, EN-260. Bloque H del RDACAA (columnas 52 a 54): con la edad congelada '
  'de 8 meses cumplidos o menos, o —sólo la columna 52, su propia lactancia— '
  'de una mujer de 10 a 49 años o de cualquier edad con un embarazo terminado '
  'hace tres meses o menos (encounter_asks_lactation, D-202.1). Versionada en '
  'record_version (EN-249).';

-- ── 2. Quién registró el procedimiento ─────────────────────────────────────

ALTER TABLE "encounter_procedure"
  ADD COLUMN "recorded_by_id" UUID,
  ADD CONSTRAINT "encounter_procedure_recorded_by_id_fkey"
    FOREIGN KEY ("recorded_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "encounter_procedure_recorder_has_instant"
    CHECK ("recorded_by_id" IS NULL OR "recorded_at" IS NOT NULL);

-- El nombre va PRIMERO en el mensaje: es como `database-problem.ts` lee qué
-- regla saltó en un disparador.
CREATE FUNCTION encounter_procedure_keeps_its_recorder()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.recorded_by_id IS DISTINCT FROM OLD.recorded_by_id
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION
      'encounter_procedure_keeps_its_recorder: who recorded a procedure, and when, does not change'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-247.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_procedure_keeps_its_recorder"
  BEFORE UPDATE ON "encounter_procedure"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_procedure_keeps_its_recorder();

-- Toda fila nueva dice quién la registró y cuándo.
CREATE FUNCTION encounter_procedure_recorded()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.recorded_at IS NULL OR NEW.recorded_by_id IS NULL THEN
    RAISE EXCEPTION
      'encounter_procedure_recorded: a procedure is recorded with who typed it and when'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-247.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_procedure_recorded"
  BEFORE INSERT ON "encounter_procedure"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_procedure_recorded();

-- El archivo de lo quitado guarda también quién lo registró y cuándo.
ALTER TABLE "encounter_procedure_retraction"
  ADD COLUMN "recorded_at" TIMESTAMPTZ(6),
  ADD COLUMN "recorded_by_id" UUID,
  ADD CONSTRAINT "encounter_procedure_retraction_recorded_by_id_fkey"
    FOREIGN KEY ("recorded_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION encounter_procedure_retraction_admits()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  live encounter_procedure%ROWTYPE;
BEGIN
  SELECT * INTO live FROM encounter_procedure WHERE id = NEW.id;
  IF NOT FOUND
     OR live.encounter_id IS DISTINCT FROM NEW.encounter_id
     OR live.concept_id IS DISTINCT FROM NEW.concept_id
     OR live.procedure_code IS DISTINCT FROM NEW.procedure_code
     OR live.procedure_display IS DISTINCT FROM NEW.procedure_display
     OR live.quantity IS DISTINCT FROM NEW.quantity
     OR live.performed_at IS DISTINCT FROM NEW.performed_at
     OR live.note IS DISTINCT FROM NEW.note
     OR live.tariff_amount IS DISTINCT FROM NEW.tariff_amount
     OR live.edited_by_id IS DISTINCT FROM NEW.edited_by_id
     OR live.edited_at IS DISTINCT FROM NEW.edited_at
     OR live.recorded_at IS DISTINCT FROM NEW.recorded_at
     OR live.recorded_by_id IS DISTINCT FROM NEW.recorded_by_id THEN
    RAISE EXCEPTION
      'encounter_procedure_retraction_matches: the archive must be the procedure being removed, as it is'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-245.';
  END IF;

  IF NEW.restored_at IS NOT NULL OR NEW.restored_by_id IS NOT NULL
     OR NEW.restored_as_id IS NOT NULL THEN
    RAISE EXCEPTION
      'encounter_procedure_retraction_frozen: an archive is born not restored'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-246.';
  END IF;

  RETURN NEW;
END;
$$;
