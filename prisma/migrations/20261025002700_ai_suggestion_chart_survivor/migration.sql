-- ai_suggestion_chart_survivor
--
-- Escrito a mano. fix/asistente-ajustes-medico, revisión de código (I3). Una
-- atención abierta sobre una ficha que después se unificó registra en la
-- ficha vigente (D-169.2, EN-238): el registro de la ficha que acepta una
-- propuesta puede ser de la ficha de la atención o de la que la absorbió.
BEGIN;

CREATE OR REPLACE FUNCTION ai_suggestion_record_in_its_encounter()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  record_encounter UUID;
  record_patient   UUID;
  run_encounter    UUID;
  run_outcome      TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "encounter_id", "outcome" INTO run_encounter, run_outcome
      FROM "ai_run" WHERE "id" = NEW."ai_run_id";
    IF run_encounter IS DISTINCT FROM NEW."encounter_id"
       OR run_outcome IS DISTINCT FROM 'ok' THEN
      RAISE EXCEPTION 'ai_suggestion_run_of_its_encounter: the attempt is not an answer of this attention'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'ai_suggestion_run_of_its_encounter',
              HINT = 'AS-020. La propuesta sale del intento que respondió en su propia atención.';
    END IF;
  END IF;

  -- On UPDATE, only when the decision links a record: the one it linked is
  -- not re-checked later, so a diagnosis removed after acceptance stays named.
  IF TG_OP = 'UPDATE' AND OLD."status" <> 'PROPOSED' THEN
    RETURN NEW;
  END IF;

  IF NEW."patient_allergy_id" IS NOT NULL
     OR NEW."patient_allergy_absence_id" IS NOT NULL
     OR NEW."patient_history_id" IS NOT NULL THEN
    IF NEW."patient_allergy_id" IS NOT NULL THEN
      SELECT "patient_id" INTO record_patient FROM "patient_allergy" WHERE "id" = NEW."patient_allergy_id";
    ELSIF NEW."patient_allergy_absence_id" IS NOT NULL THEN
      SELECT "patient_id" INTO record_patient FROM "patient_allergy_absence" WHERE "id" = NEW."patient_allergy_absence_id";
    ELSE
      SELECT "patient_id" INTO record_patient FROM "patient_history" WHERE "id" = NEW."patient_history_id";
    END IF;
    -- D-169.2. The screen records on the chart that absorbed the attention's
    -- one (EN-238): that chart is the patient's too.
    IF record_patient IS NULL OR record_patient NOT IN (
         SELECT p."id" FROM "encounter" e JOIN "patient" p ON p."id" = e."patient_id"
          WHERE e."id" = NEW."encounter_id"
         UNION
         SELECT p."merged_into_id" FROM "encounter" e JOIN "patient" p ON p."id" = e."patient_id"
          WHERE e."id" = NEW."encounter_id" AND p."merged_into_id" IS NOT NULL) THEN
      RAISE EXCEPTION 'ai_suggestion_record_in_its_encounter: the accepted record is of another patient'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'ai_suggestion_record_in_its_encounter',
              HINT = 'AS-266. Una propuesta de la ficha enlaza un registro del paciente de su atención.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."clinical_note_id" IS NOT NULL THEN
    SELECT "encounter_id" INTO record_encounter FROM "clinical_note" WHERE "id" = NEW."clinical_note_id";
  ELSIF NEW."encounter_diagnosis_id" IS NOT NULL THEN
    SELECT "encounter_id" INTO record_encounter FROM "encounter_diagnosis" WHERE "id" = NEW."encounter_diagnosis_id";
  ELSIF NEW."prescription_id" IS NOT NULL THEN
    SELECT "encounter_id" INTO record_encounter FROM "prescription" WHERE "id" = NEW."prescription_id";
  ELSIF NEW."service_order_id" IS NOT NULL THEN
    SELECT "encounter_id" INTO record_encounter FROM "service_order" WHERE "id" = NEW."service_order_id";
  ELSE
    RETURN NEW;
  END IF;

  IF record_encounter IS DISTINCT FROM NEW."encounter_id" THEN
    RAISE EXCEPTION 'ai_suggestion_record_in_its_encounter: the accepted record belongs to another attention'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'ai_suggestion_record_in_its_encounter',
            HINT = 'AS-021. Una propuesta enlaza a lo que se guardó en su propia atención.';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
