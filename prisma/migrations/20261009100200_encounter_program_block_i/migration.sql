-- encounter_program_block_i
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio:
-- propone borrar las columnas generadas, los índices GIN y BRIN, los índices
-- únicos parciales y los disparadores, porque schema.prisma no puede
-- describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-093. EL BLOQUE I DEL RDACAA: VACUNAS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Columnas 55 a 74 (instructivo RDACAA 2.0, pp. 56 a 58 del PDF). La fila del
-- formulario tiene una columna por vacuna con su dosis, y UN grupo de riesgo
-- (columna 74). Aquí, igual: una fila por atención con sus dosis y un grupo,
-- versionada entera en `record_version` (EN-249) — por eso las dosis van en
-- la fila como `jsonb` y no en una tabla hija, cuya corrección no archivaría
-- nada.
--
-- LA VACUNA ES UN CATÁLOGO (`VACCINE`, sembrado por `seed-rdacaa.mts`), con el
-- número de su columna del formulario como código: el esquema de vacunación
-- cambia por acuerdo ministerial y no debe costar una migración. Por eso el
-- disparador exige que cada código sea un concepto de `VACCINE` vigente en la
-- fecha clínica, como el CIE-10 del diagnóstico (EN-042).
--
-- LAS REGLAS DE COHERENCIA DEL INSTRUCTIVO, «criterios de registro», p. 57:
--   67 dT adulto        → edades en riesgo, embarazadas
--   73 influenza        → edades en riesgo, embarazadas, puérperas, personal
--                         de la salud, enfermedades crónicas, privados de
--                         libertad, discapacidad
--   70 HB adulto        → personal de la salud, privados de libertad, viviendo
--                         con VIH, trabajadores sexuales, otros (D-195.2)
--   69 SR, 62 fiebre a. → edades en riesgo, viajeros
-- Con una de las cinco el grupo es obligatorio y vale para todas las de la
-- atención; sin ninguna va vacío, como en la herramienta del ministerio, que
-- además impide embarazada y puérpera en un hombre. «Embarazadas» lo nombran
-- los criterios y el catálogo impreso no lo numera (D-195.1).
--
-- Qué se llama cada rechazo (encounter.constraints.ts), todos VALIDATION_FAILED:
--  · `encounter_vaccination_doses_shape` — `doses` no es una lista de
--    {code, dose} con dosis del catálogo → en `doses`.
--  · `encounter_vaccination_vaccine_in_force` — un código que no es una vacuna
--    vigente ese día → en `doses`.
--  · `encounter_vaccination_vaccine_distinct` — la misma vacuna dos veces.
--  · `encounter_vaccination_risk_group_required` / `_not_asked` /
--    `_not_admitted` / `_sex` → en `riskGroup`.
-- Después: pnpm migrations:check && pnpm db:deploy

CREATE TYPE "vaccine_risk_group" AS ENUM (
  'AGES_AT_RISK', 'POSTPARTUM', 'HEALTH_WORKER', 'CHRONIC_DISEASE',
  'DEPRIVED_OF_LIBERTY', 'DISABILITY', 'LIVING_WITH_HIV', 'SEX_WORKER',
  'TRAVELLER', 'OTHER', 'PREGNANT'
);

CREATE TABLE "encounter_vaccination" (
  "encounter_id" UUID PRIMARY KEY,

  -- [{"code": "67", "dose": "FIRST"}, …]. Vacía: corregida a «ninguna».
  "doses"      JSONB NOT NULL,
  "risk_group" "vaccine_risk_group",

  "recorded_by_id" UUID NOT NULL,
  "recorded_at"    TIMESTAMPTZ(6) NOT NULL,
  "edited_by_id"   UUID,
  "edited_at"      TIMESTAMPTZ(6),

  CONSTRAINT "encounter_vaccination_encounter_id_fkey"
    FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "encounter_vaccination_recorded_by_id_fkey"
    FOREIGN KEY ("recorded_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "encounter_vaccination_edited_by_id_fkey"
    FOREIGN KEY ("edited_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "encounter_vaccination_edit_stamp_whole"
    CHECK (("edited_by_id" IS NULL) = ("edited_at" IS NULL))
);

COMMENT ON TABLE "encounter_vaccination" IS
  'EN-093. Bloque I del RDACAA (columnas 55 a 74): las vacunas de la atención '
  '(catálogo VACCINE, código = columna) y su grupo de riesgo, con las reglas '
  'del instructivo en trg_encounter_vaccination_valid. Versionada en '
  'record_version (EN-249). El grupo del HB adulto es dato protegido: la API '
  'no lo muestra ni lo deja escribir sin record:protected.';

-- Los grupos que admite cada vacuna con regla; NULL si la vacuna no pide grupo.
CREATE FUNCTION vaccine_admitted_risk_groups(p_code text)
RETURNS vaccine_risk_group[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE p_code
    WHEN '67' THEN ARRAY['AGES_AT_RISK', 'PREGNANT']::vaccine_risk_group[]
    WHEN '73' THEN ARRAY['AGES_AT_RISK', 'PREGNANT', 'POSTPARTUM', 'HEALTH_WORKER',
                         'CHRONIC_DISEASE', 'DEPRIVED_OF_LIBERTY', 'DISABILITY']::vaccine_risk_group[]
    WHEN '70' THEN ARRAY['HEALTH_WORKER', 'DEPRIVED_OF_LIBERTY', 'LIVING_WITH_HIV',
                         'SEX_WORKER', 'OTHER']::vaccine_risk_group[]
    WHEN '69' THEN ARRAY['AGES_AT_RISK', 'TRAVELLER']::vaccine_risk_group[]
    WHEN '62' THEN ARRAY['AGES_AT_RISK', 'TRAVELLER']::vaccine_risk_group[]
  END
$$;

CREATE FUNCTION encounter_vaccination_valid()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  clinical_day date;
  patient_sex  text;
  dose         jsonb;
  codes        text[] := '{}';
  constrained  boolean := false;
  admitted     vaccine_risk_group[];
BEGIN
  SELECT (e.started_at AT TIME ZONE 'America/Guayaquil')::date, p.sex::text
    INTO clinical_day, patient_sex
    FROM encounter e JOIN patient p ON p.id = e.patient_id
   WHERE e.id = NEW.encounter_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF jsonb_typeof(NEW.doses) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'encounter_vaccination_doses_shape: doses is a list'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'encounter_vaccination_doses_shape';
  END IF;

  FOR dose IN SELECT value FROM jsonb_array_elements(NEW.doses) LOOP
    IF jsonb_typeof(dose) IS DISTINCT FROM 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(dose)) <> 2
       OR jsonb_typeof(dose -> 'code') IS DISTINCT FROM 'string'
       OR NOT (dose ->> 'dose') = ANY (ARRAY['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SINGLE'])
       OR (dose ->> 'dose') IS NULL THEN
      RAISE EXCEPTION 'encounter_vaccination_doses_shape: each dose is a vaccine code and a dose of the catalogue'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'encounter_vaccination_doses_shape';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM catalog_concept cc
        JOIN catalog_system cs ON cs.id = cc.system_id
       WHERE cs.code = 'VACCINE'
         AND cc.code = dose ->> 'code'
         AND cc.valid_period @> clinical_day
    ) THEN
      RAISE EXCEPTION 'encounter_vaccination_vaccine_in_force: a vaccine is not in the catalogue on the clinical date'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'encounter_vaccination_vaccine_in_force';
    END IF;

    IF (dose ->> 'code') = ANY (codes) THEN
      RAISE EXCEPTION 'encounter_vaccination_vaccine_distinct: the same vaccine twice in one attention'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'encounter_vaccination_vaccine_distinct';
    END IF;
    codes := codes || (dose ->> 'code');

    IF vaccine_admitted_risk_groups(dose ->> 'code') IS NOT NULL THEN
      constrained := true;
      IF NEW.risk_group IS NOT NULL
         AND NOT NEW.risk_group = ANY (vaccine_admitted_risk_groups(dose ->> 'code')) THEN
        RAISE EXCEPTION 'encounter_vaccination_risk_group_not_admitted: a vaccine of the attention does not admit that risk group'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'encounter_vaccination_risk_group_not_admitted';
      END IF;
    END IF;
  END LOOP;

  IF constrained AND NEW.risk_group IS NULL THEN
    RAISE EXCEPTION 'encounter_vaccination_risk_group_required: a vaccine of the attention asks for its risk group'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'encounter_vaccination_risk_group_required';
  END IF;
  IF NOT constrained AND NEW.risk_group IS NOT NULL THEN
    RAISE EXCEPTION 'encounter_vaccination_risk_group_not_asked: no vaccine of the attention asks for a risk group'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'encounter_vaccination_risk_group_not_asked';
  END IF;
  IF patient_sex = 'MALE' AND NEW.risk_group IN ('PREGNANT', 'POSTPARTUM') THEN
    RAISE EXCEPTION 'encounter_vaccination_risk_group_sex: a man is neither pregnant nor postpartum'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'encounter_vaccination_risk_group_sex';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_vaccination_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "encounter_vaccination"
  FOR EACH ROW EXECUTE FUNCTION program_block_guard();

CREATE TRIGGER "trg_encounter_vaccination_valid"
  BEFORE INSERT OR UPDATE ON "encounter_vaccination"
  FOR EACH ROW EXECUTE FUNCTION encounter_vaccination_valid();

CREATE TRIGGER "trg_encounter_vaccination_keeps_its_author"
  BEFORE UPDATE ON "encounter_vaccination"
  FOR EACH ROW EXECUTE FUNCTION program_block_keeps_its_author();

CREATE TRIGGER "trg_encounter_vaccination_record_version"
  BEFORE UPDATE ON "encounter_vaccination"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_archive('edited_by_id', 'edited_at', 'encounter_id');
