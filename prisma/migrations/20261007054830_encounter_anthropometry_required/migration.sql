-- encounter_anthropometry_required
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- EN-063 (enmienda de feat/f03-cierre-interfaz). QUÉ MEDIDAS EXIGE UNA
-- ATENCIÓN, ANTES DE QUE HAYA TOMA.
--
-- `encounter_anthropometry_pending` respondía «qué falta de la toma», y la
-- pantalla sólo podía saberlo DESPUÉS de guardar la primera. Para que la
-- casilla diga «obligatorio para firmar» mientras se teclea hace falta la otra
-- mitad de la misma pregunta: qué se exige, con independencia de lo medido.
--
-- UNA SOLA REGLA, NO DOS. La condición (edad congelada < 5 años, registro
-- PREGNANT de la ficha o de una absorbida vigente en la fecha clínica de la
-- atención en America/Guayaquil, extremos incluidos; D-129: a la embarazada
-- no se le exige el perímetro cefálico) se mueve tal cual a
-- `encounter_anthropometry_required`, y `pending` pasa a ser «lo exigido que
-- falta en la toma» encima de ella. Así el aviso de la pantalla, la respuesta
-- de la toma, la firma (`trg_clinical_note_sign_needs_anthropometry`) y la
-- corrección tras el alta siguen leyendo la misma regla.
--
-- `pending` conserva firma, tipo y orden del resultado (weightKg, heightCm,
-- headCircumferenceCm): CREATE OR REPLACE no toca los disparadores que la
-- llaman. Única diferencia: para una atención inexistente devuelve '{}' en
-- lugar de NULL, que los disparadores (`cardinality(...) > 0`) y el adaptador
-- (`?? []`) ya leían igual.
--
-- Después: pnpm migrations:check && pnpm db:deploy

CREATE FUNCTION encounter_anthropometry_required(p_encounter_id uuid)
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
                  ) AS pregnant
      FROM attention a
  )
  SELECT coalesce(array_remove(ARRAY[
           CASE WHEN under_five OR pregnant THEN 'weightKg' END,
           CASE WHEN under_five OR pregnant THEN 'heightCm' END,
           CASE WHEN under_five THEN 'headCircumferenceCm' END
         ], NULL), '{}'::text[])
    FROM who;
$$;

CREATE OR REPLACE FUNCTION encounter_anthropometry_pending(p_encounter_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(array_agg(r.field ORDER BY r.position), '{}'::text[])
    FROM unnest(encounter_anthropometry_required(p_encounter_id))
         WITH ORDINALITY AS r(field, position)
    LEFT JOIN encounter_vitals v ON v.encounter_id = p_encounter_id
   WHERE (r.field = 'weightKg' AND v.weight_kg IS NULL)
      OR (r.field = 'heightCm' AND v.height_cm IS NULL)
      OR (r.field = 'headCircumferenceCm' AND v.head_circumference_cm IS NULL);
$$;
