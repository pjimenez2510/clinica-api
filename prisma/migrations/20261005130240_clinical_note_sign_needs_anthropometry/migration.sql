-- clinical_note_sign_needs_anthropometry
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-217 (D-132 B): LOS SIGNOS SE GUARDAN SIN LA ANTROPOMETRÍA, Y LA FIRMA LA EXIGE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El instructivo RDACAA (p. 44) hace obligatorios el peso, la talla y el
-- perímetro cefálico del menor de 5 años, y D-129 el peso y la talla de la
-- embarazada (EN-063). Hasta aquí se exigían AL GUARDAR la toma, y si la
-- gestante no se podía pesar tampoco quedaba su presión arterial —la cifra que
-- alerta de preeclampsia—, o se tecleaba un peso inventado. D-132 B: la toma se
-- guarda, la pantalla avisa, y lo que falta se exige al FIRMAR la 002.
--
-- UNA FUNCIÓN para la respuesta de la toma, para la firma y para este
-- disparador: `encounter_anthropometry_pending` devuelve lo que falta, con los
-- nombres de campo de la API. Tres sitios que repitieran «menor de 5 o
-- embarazada en la fecha clínica» discreparían el día que uno cambie.
--
--   · Menor de 5: la edad CONGELADA de la atención (EN-008, `age_years`).
--   · Embarazada: un registro PREGNANT de la ficha o de una ficha que absorbió
--     (PA-055), vigente en la FECHA CLÍNICA de la atención —el día en
--     `America/Guayaquil`—, con los dos extremos incluidos. Es la lectura que
--     hacía `isPregnantOn` en el adaptador, que esta función sustituye.
--   · Sin toma, falta todo lo obligatorio.
--
-- SÓLO CUANDO LA FIRMA DA EL ALTA, y por eso es DIFERIDO, como
-- `trg_clinical_note_sign_needs_diagnosis` (EN-020): interrumpir también
-- firma la 002 con lo escrito y no da el alta, y no exige nada.
--
-- No toca datos: sólo mira el paso de borrador a firmada de aquí en adelante.

CREATE FUNCTION encounter_anthropometry_pending(p_encounter_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  WITH attention AS (
    SELECT e.id,
           e.patient_id,
           (e.age_years IS NOT NULL AND e.age_years < 5) AS under_five,
           (e.started_at AT TIME ZONE 'America/Guayaquil')::date AS clinical_day
      FROM encounter e
     WHERE e.id = p_encounter_id
  ), who AS (
    SELECT a.under_five,
           EXISTS (SELECT 1
                     FROM patient_priority_group g
                     JOIN patient p ON p.id = g.patient_id
                    WHERE (p.id = a.patient_id OR p.merged_into_id = a.patient_id)
                      AND g.group_code = 'PREGNANT'
                      AND g.starts_on <= a.clinical_day
                      AND (g.ends_on IS NULL OR g.ends_on >= a.clinical_day)
                  ) AS pregnant,
           v.weight_kg, v.height_cm, v.head_circumference_cm
      FROM attention a
      LEFT JOIN encounter_vitals v ON v.encounter_id = a.id
  )
  SELECT coalesce(array_remove(ARRAY[
           CASE WHEN (under_five OR pregnant) AND weight_kg IS NULL
                THEN 'weightKg' END,
           CASE WHEN (under_five OR pregnant) AND height_cm IS NULL
                THEN 'heightCm' END,
           CASE WHEN under_five AND head_circumference_cm IS NULL
                THEN 'headCircumferenceCm' END
         ], NULL), '{}'::text[])
    FROM who;
$$;

-- El nombre va PRIMERO en el mensaje: es como `database-problem.ts` lee qué
-- regla saltó en un disparador.
CREATE FUNCTION clinical_note_sign_needs_anthropometry()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF encounter_has_discharge(NEW.encounter_id)
     AND cardinality(encounter_anthropometry_pending(NEW.encounter_id)) > 0 THEN
    RAISE EXCEPTION
      'clinical_note_sign_needs_anthropometry: signing the consultation note discharges the attention, and the mandatory anthropometry is missing'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-217, EN-063, D-132.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_clinical_note_sign_needs_anthropometry
  AFTER UPDATE OF status ON clinical_note
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.status = 'DRAFT' AND NEW.status = 'SIGNED' AND NEW.form_code = '002')
  EXECUTE FUNCTION clinical_note_sign_needs_anthropometry();
