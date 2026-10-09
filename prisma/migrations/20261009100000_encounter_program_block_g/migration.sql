-- encounter_program_block_g
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio:
-- propone borrar las columnas generadas, los índices GIN y BRIN, los índices
-- únicos parciales y los disparadores, porque schema.prisma no puede
-- describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-090, EN-091. EL BLOQUE G DEL RDACAA: DATOS OBSTÉTRICOS Y LABORATORIO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Columnas 39 a 50 del formulario (instructivo RDACAA 2.0, pp. 50 a 53 del
-- PDF). Una fila por atención, como el CEO-D: se corrige en su sitio y la
-- versión anterior va entera a `record_version` (EN-249). La fila no tiene
-- nada secreto, así que archivarla entera es seguro.
--
-- Y DOS PIEZAS COMUNES A LOS CUATRO BLOQUES DE PROGRAMA (G, H, I y J), que
-- las migraciones siguientes enganchan a sus tablas:
--
--  · `program_block_guard()` — un bloque sólo se escribe con la atención
--    abierta o suspendida, y nunca se borra (EN-249).
--  · `program_block_keeps_its_author()` — quien lo registró, y cuándo, no
--    cambia al corregirlo: la corrección lleva su propio sello.
--
-- `encounter_is_pregnant(id)` es la regla de «embarazada ese día» de EN-063
-- (`encounter_anthropometry_required`), sacada a una función para que el
-- bloque G la lea igual: el registro PREGNANT de la ficha, o de una ficha que
-- ésta absorbió, vigente en la fecha clínica de la atención en
-- America/Guayaquil, extremos incluidos. Lectura EN VIVO hasta que EN-099
-- tenga catálogo (D-134.3 §2).
--
-- Qué se llama cada rechazo y qué responde la API (encounter.constraints.ts):
--  · `encounter_obstetric_applies` — la paciente no está embarazada en la
--    fecha clínica → PROGRAM_BLOCK_NOT_APPLICABLE (422).
--  · `encounter_obstetric_weeks_range` — semanas fuera de 1..42 →
--    VALIDATION_FAILED en `gestationalWeeks`.
--  · `encounter_obstetric_lmp_for_fum` — método FUM sin fecha → en
--    `lastMenstrualPeriod`.
--  · `encounter_obstetric_lmp_range` — la FUM después de la fecha clínica, o
--    más de 300 días antes (42 semanas y 6 días) → en `lastMenstrualPeriod`.
--  · `program_block_frozen` / `program_block_immutable` — 42501, como el
--    tamizaje: el servicio ya lo dijo con ENCOUNTER_ALREADY_CLOSED.
-- Después: pnpm migrations:check && pnpm db:deploy

-- ── Piezas comunes ─────────────────────────────────────────────────────────

CREATE FUNCTION encounter_is_pregnant(p_encounter_id uuid)
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
       AND g.starts_on <= (e.started_at AT TIME ZONE 'America/Guayaquil')::date
       AND (g.ends_on IS NULL
            OR g.ends_on >= (e.started_at AT TIME ZONE 'America/Guayaquil')::date)
  );
$$;

CREATE FUNCTION program_block_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  encounter_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'program_block_immutable: % is corrected, never deleted', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;

  SELECT e.status::text INTO encounter_status
    FROM encounter e WHERE e.id = NEW.encounter_id;
  -- No attention: the foreign key refuses it.
  IF FOUND AND encounter_status NOT IN ('OPEN', 'ON_HOLD') THEN
    RAISE EXCEPTION 'program_block_frozen: the attention no longer accepts new content (%)', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.encounter_id IS DISTINCT FROM OLD.encounter_id THEN
    RAISE EXCEPTION 'program_block_immutable: % does not move to another attention', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION program_block_keeps_its_author()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.recorded_by_id IS DISTINCT FROM OLD.recorded_by_id
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'program_block_keeps_its_author: who recorded % and when does not change', TG_TABLE_NAME
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'program_block_keeps_its_author';
  END IF;
  RETURN NEW;
END;
$$;

-- ── Bloque G ───────────────────────────────────────────────────────────────

-- Listas cortas y cerradas del instructivo: enum, no catálogo.
CREATE TYPE "obstetric_risk" AS ENUM ('LOW', 'HIGH', 'IMMINENT');
CREATE TYPE "gestational_age_method" AS ENUM ('LMP', 'ULTRASOUND', 'CLINICAL');
-- (+) · (−) · SD, sin dato. El tercero es el que un booleano perdería.
CREATE TYPE "syphilis_result" AS ENUM ('POSITIVE', 'NEGATIVE', 'NO_DATA');
CREATE TYPE "partner_treatment" AS ENUM ('YES', 'NO', 'NOT_DONE');
CREATE TYPE "bacteriuria_result" AS ENUM ('NORMAL', 'ABNORMAL', 'NOT_DONE');

CREATE TABLE "encounter_obstetric" (
  "encounter_id" UUID PRIMARY KEY,

  -- Columnas 39 a 45: obligatorias cuando se registra el bloque.
  "risk"                   "obstetric_risk" NOT NULL,
  "birth_plan"             BOOLEAN NOT NULL,
  "transport_plan"         BOOLEAN NOT NULL,
  "planned_pregnancy"      BOOLEAN NOT NULL,
  "gestational_age_method" "gestational_age_method" NOT NULL,
  "last_menstrual_period"  DATE,
  "gestational_weeks"      SMALLINT NOT NULL,

  -- Columnas 46 a 50: optativas, una por examen y atención (D-195.4).
  "non_treponemal_test" "syphilis_result",
  "treponemal_test"     "syphilis_result",
  "syphilis_treatment"  "syphilis_result",
  "partner_treatment"   "partner_treatment",
  "bacteriuria"         "bacteriuria_result",

  "recorded_by_id" UUID NOT NULL,
  "recorded_at"    TIMESTAMPTZ(6) NOT NULL,
  "edited_by_id"   UUID,
  "edited_at"      TIMESTAMPTZ(6),

  CONSTRAINT "encounter_obstetric_encounter_id_fkey"
    FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "encounter_obstetric_recorded_by_id_fkey"
    FOREIGN KEY ("recorded_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "encounter_obstetric_edited_by_id_fkey"
    FOREIGN KEY ("edited_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  -- «Desde la primera semana hasta las 42 semanas de gestación».
  CONSTRAINT "encounter_obstetric_weeks_range"
    CHECK ("gestational_weeks" BETWEEN 1 AND 42),
  -- Con el método FUM, la FUM es el dato del método.
  CONSTRAINT "encounter_obstetric_lmp_for_fum"
    CHECK ("gestational_age_method" <> 'LMP' OR "last_menstrual_period" IS NOT NULL),
  CONSTRAINT "encounter_obstetric_edit_stamp_whole"
    CHECK (("edited_by_id" IS NULL) = ("edited_at" IS NULL))
);

COMMENT ON TABLE "encounter_obstetric" IS
  'EN-090, EN-091. Bloque G del RDACAA (columnas 39 a 50): sólo si la ficha '
  'tiene el registro PREGNANT vigente en la fecha clínica (trg_encounter_obstetric_applies). '
  'Versionada en record_version (EN-249).';

CREATE FUNCTION encounter_obstetric_applies()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  clinical_day date;
BEGIN
  SELECT (e.started_at AT TIME ZONE 'America/Guayaquil')::date
    INTO clinical_day
    FROM encounter e WHERE e.id = NEW.encounter_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NOT encounter_is_pregnant(NEW.encounter_id) THEN
    RAISE EXCEPTION 'encounter_obstetric_applies: the patient is not pregnant on the clinical date of the attention'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'encounter_obstetric_applies';
  END IF;

  -- La FUM es anterior a la atención, y no más de 42 semanas y 6 días.
  IF NEW.last_menstrual_period IS NOT NULL
     AND (NEW.last_menstrual_period > clinical_day
          OR NEW.last_menstrual_period < clinical_day - 300) THEN
    RAISE EXCEPTION 'encounter_obstetric_lmp_range: the last menstrual period is after the attention or more than 300 days before it'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'encounter_obstetric_lmp_range';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_obstetric_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "encounter_obstetric"
  FOR EACH ROW EXECUTE FUNCTION program_block_guard();

CREATE TRIGGER "trg_encounter_obstetric_applies"
  BEFORE INSERT OR UPDATE ON "encounter_obstetric"
  FOR EACH ROW EXECUTE FUNCTION encounter_obstetric_applies();

CREATE TRIGGER "trg_encounter_obstetric_keeps_its_author"
  BEFORE UPDATE ON "encounter_obstetric"
  FOR EACH ROW EXECUTE FUNCTION program_block_keeps_its_author();

-- EN-249. La fila anterior, entera, en `record_version`.
CREATE TRIGGER "trg_encounter_obstetric_record_version"
  BEFORE UPDATE ON "encounter_obstetric"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_archive('edited_by_id', 'edited_at', 'encounter_id');
