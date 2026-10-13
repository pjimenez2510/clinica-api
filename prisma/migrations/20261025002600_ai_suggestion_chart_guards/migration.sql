-- ai_suggestion_chart_guards
--
-- Escrito a mano. fix/asistente-ajustes-medico, revisión de seguridad
-- (AS-265, AS-266). Lo que el servicio comprueba al aceptar una propuesta de
-- la ficha, garantizado también por la base:
--
-- 1. El registro lo hizo quien decide y después de proponerse: un registro de
--    otro profesional, o anterior, no es lo que esta propuesta propuso.
-- 2. Un registro responde a UNA propuesta: dos enlazadas al mismo contarían
--    dos veces lo aceptado.
BEGIN;

CREATE UNIQUE INDEX "ai_suggestion_one_per_patient_allergy"
  ON "ai_suggestion"("patient_allergy_id") WHERE "patient_allergy_id" IS NOT NULL;
CREATE UNIQUE INDEX "ai_suggestion_one_per_patient_allergy_absence"
  ON "ai_suggestion"("patient_allergy_absence_id") WHERE "patient_allergy_absence_id" IS NOT NULL;
CREATE UNIQUE INDEX "ai_suggestion_one_per_patient_history"
  ON "ai_suggestion"("patient_history_id") WHERE "patient_history_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION ai_suggestion_chart_record_is_the_answer()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  record_author UUID;
  record_at     TIMESTAMPTZ;
BEGIN
  IF OLD."status" <> 'PROPOSED' THEN
    RETURN NEW;
  END IF;
  IF NEW."patient_allergy_id" IS NOT NULL THEN
    SELECT "recorded_by", "recorded_at" INTO record_author, record_at
      FROM "patient_allergy" WHERE "id" = NEW."patient_allergy_id";
  ELSIF NEW."patient_allergy_absence_id" IS NOT NULL THEN
    SELECT "asserted_by", "asserted_at" INTO record_author, record_at
      FROM "patient_allergy_absence" WHERE "id" = NEW."patient_allergy_absence_id";
  ELSIF NEW."patient_history_id" IS NOT NULL THEN
    SELECT "recorded_by", "recorded_at" INTO record_author, record_at
      FROM "patient_history" WHERE "id" = NEW."patient_history_id";
  ELSE
    RETURN NEW;
  END IF;
  IF record_author IS DISTINCT FROM NEW."decided_by" OR record_at < NEW."proposed_at" THEN
    RAISE EXCEPTION 'ai_suggestion_chart_record_is_the_answer: the record is not the one the proposal was accepted as'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'ai_suggestion_chart_record_is_the_answer',
            HINT = 'AS-265. Una propuesta de la ficha se acepta con el registro que hizo quien decide, después de proponerse.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ai_suggestion_chart_record_is_the_answer"
  BEFORE UPDATE ON "ai_suggestion"
  FOR EACH ROW EXECUTE FUNCTION ai_suggestion_chart_record_is_the_answer();

COMMIT;
