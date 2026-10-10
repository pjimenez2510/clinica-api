-- encounter_vaccination_dose_risk_group
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio:
-- propone borrar las columnas generadas, los índices GIN y BRIN, los índices
-- únicos parciales y los disparadores, porque schema.prisma no puede
-- describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-093. EL GRUPO DE RIESGO VA EN CADA DOSIS, NO EN LA ATENCIÓN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- D-195.8, aceptada el 09-10-2026 con la investigación: en HL7 FHIR cada
-- `Immunization` es una dosis administrada y lleva su propia
-- `programEligibility`; el grupo va con la dosis y no con la visita. Con un
-- grupo por atención (la columna 74 del formulario), dT adulto, SR o fiebre
-- amarilla junto a un HB adulto no compartían ninguno, y a una trabajadora de
-- salud vacunada de dT y HB adulto en la misma visita había que partirla en
-- dos atenciones. Qué grupo lleva la columna 74, o si la fila se parte, lo
-- decide la exportación (H9).
--
-- SIN RELLENO, A PROPÓSITO (condición del autor, 09-10-2026: en desarrollo
-- los datos se pueden borrar). La tabla se VACÍA: `TRUNCATE` no dispara la
-- guarda por fila (`program_block_guard` rechaza el DELETE) ni archiva nada.
-- Las versiones ya archivadas en `record_version` conservan su forma vieja
-- —con `risk_group` arriba—, y la exportación al titular quita las dos
-- formas (record-version-subjects.ts).
--
-- La forma nueva de cada dosis: {"code": "67", "dose": "FIRST",
-- "riskGroup": "AGES_AT_RISK"} — las TRES claves siempre, `riskGroup` null
-- cuando la vacuna no pide grupo. Las reglas del instructivo, dosis por dosis
-- (`vaccine_admitted_risk_groups`, sin cambios): con una de las cinco vacunas
-- con regla, el grupo es obligatorio y de los suyos; en las demás, vacío.
-- Embarazada y puérpera, no en un hombre.
--
-- Qué se llama cada rechazo (encounter.constraints.ts), todos
-- VALIDATION_FAILED en `doses`: `encounter_vaccination_doses_shape`,
-- `_vaccine_in_force`, `_vaccine_distinct`, `_risk_group_required`,
-- `_risk_group_not_asked`, `_risk_group_not_admitted`, `_risk_group_sex`.
-- Después: pnpm migrations:check && pnpm db:deploy

TRUNCATE "encounter_vaccination";

ALTER TABLE "encounter_vaccination" DROP COLUMN "risk_group";

CREATE OR REPLACE FUNCTION encounter_vaccination_valid()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  clinical_day date;
  patient_sex  text;
  dose         jsonb;
  codes        text[] := '{}';
  admitted     vaccine_risk_group[];
  risk_group   vaccine_risk_group;
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
       OR (SELECT count(*) FROM jsonb_object_keys(dose)) <> 3
       OR jsonb_typeof(dose -> 'code') IS DISTINCT FROM 'string'
       OR (dose ->> 'dose') IS NULL
       OR NOT (dose ->> 'dose') = ANY (ARRAY['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SINGLE'])
       OR NOT (dose ? 'riskGroup')
       OR jsonb_typeof(dose -> 'riskGroup') NOT IN ('null', 'string')
       OR (jsonb_typeof(dose -> 'riskGroup') = 'string'
           AND NOT (dose ->> 'riskGroup') = ANY (enum_range(NULL::vaccine_risk_group)::text[])) THEN
      RAISE EXCEPTION 'encounter_vaccination_doses_shape: each dose is a vaccine code, a dose of the catalogue and its risk group'
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

    admitted := vaccine_admitted_risk_groups(dose ->> 'code');
    risk_group := (dose ->> 'riskGroup')::vaccine_risk_group;
    IF admitted IS NULL AND risk_group IS NOT NULL THEN
      RAISE EXCEPTION 'encounter_vaccination_risk_group_not_asked: this vaccine asks for no risk group'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'encounter_vaccination_risk_group_not_asked';
    END IF;
    IF admitted IS NOT NULL AND risk_group IS NULL THEN
      RAISE EXCEPTION 'encounter_vaccination_risk_group_required: this vaccine asks for its risk group'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'encounter_vaccination_risk_group_required';
    END IF;
    IF admitted IS NOT NULL AND NOT risk_group = ANY (admitted) THEN
      RAISE EXCEPTION 'encounter_vaccination_risk_group_not_admitted: the vaccine does not admit that risk group'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'encounter_vaccination_risk_group_not_admitted';
    END IF;
    IF patient_sex = 'MALE' AND risk_group IN ('PREGNANT', 'POSTPARTUM') THEN
      RAISE EXCEPTION 'encounter_vaccination_risk_group_sex: a man is neither pregnant nor postpartum'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'encounter_vaccination_risk_group_sex';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

COMMENT ON TABLE "encounter_vaccination" IS
  'EN-093. Bloque I del RDACAA (columnas 55 a 74): las vacunas de la atención '
  '(catálogo VACCINE, código = columna), cada dosis con su grupo de riesgo '
  '(D-195.8), con las reglas del instructivo en trg_encounter_vaccination_valid. '
  'Versionada en record_version (EN-249). El grupo del HB adulto es dato '
  'protegido: la API no lo muestra ni lo deja escribir sin record:protected '
  '(EN-261).';
