-- ai_suggestion_chart
--
-- Escrito a mano. fix/asistente-ajustes-medico (AS-260 a AS-266, D-261).
--
-- LO QUE LA CONVERSACIÓN DICE DE LA FICHA, PROPUESTO COMO REGISTRO. El autor
-- leyó el libreto (13-10-2026): «Niega alergias… Madre hipertensa» quedaba
-- en prosa y arriba seguía «No consta ninguna alergia». Ahora el asistente
-- propone «Sin alergias conocidas», cada alergia y cada antecedente, y el
-- médico los registra con un ✓ por la ruta de siempre (P1).
--
-- 1. Tres clases nuevas: `chart-allergy`, `chart-no-allergy`, `chart-history`.
-- 2. Tres columnas para el registro aceptado, una por tabla de la ficha; el
--    CHECK de siempre exige exactamente una, la de su clase (AS-021, AS-266).
-- 3. El registro de la ficha no tiene atención: lo que se exige es que sea
--    del PACIENTE de la atención de la propuesta, al decidir (AS-266). Un
--    enlace a la alergia de otra persona contaría como aceptado lo que nadie
--    aceptó para este paciente.
BEGIN;

ALTER TABLE "ai_suggestion"
  ADD COLUMN "patient_allergy_id"         UUID,
  ADD COLUMN "patient_allergy_absence_id" UUID,
  ADD COLUMN "patient_history_id"         UUID,
  ADD CONSTRAINT "ai_suggestion_patient_allergy_id_fkey" FOREIGN KEY ("patient_allergy_id")
    REFERENCES "patient_allergy"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ai_suggestion_patient_allergy_absence_id_fkey" FOREIGN KEY ("patient_allergy_absence_id")
    REFERENCES "patient_allergy_absence"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ai_suggestion_patient_history_id_fkey" FOREIGN KEY ("patient_history_id")
    REFERENCES "patient_history"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ai_suggestion" DROP CONSTRAINT "ai_suggestion_kind_known";
ALTER TABLE "ai_suggestion" ADD CONSTRAINT "ai_suggestion_kind_known" CHECK ("kind" IS NOT NULL AND "kind" IN (
  'note-section', 'diagnosis', 'prescription-item', 'order-item', 'note-question',
  'chart-allergy', 'chart-no-allergy', 'chart-history'));

-- AS-021, AS-266. Accepted ⇔ exactly one record, and the one its kind names.
ALTER TABLE "ai_suggestion" DROP CONSTRAINT "ai_suggestion_accepted_links_its_record";
ALTER TABLE "ai_suggestion" ADD CONSTRAINT "ai_suggestion_accepted_links_its_record" CHECK (
  CASE WHEN "status" IN ('ACCEPTED', 'ACCEPTED_WITH_CHANGES') THEN
    num_nonnulls("clinical_note_id", "encounter_diagnosis_id", "prescription_id",
                 "service_order_id", "patient_allergy_id",
                 "patient_allergy_absence_id", "patient_history_id") = 1
    AND CASE "kind"
      WHEN 'note-section'      THEN "clinical_note_id" IS NOT NULL
      WHEN 'diagnosis'         THEN "encounter_diagnosis_id" IS NOT NULL
      WHEN 'prescription-item' THEN "prescription_id" IS NOT NULL
      WHEN 'order-item'        THEN "service_order_id" IS NOT NULL
      WHEN 'chart-allergy'     THEN "patient_allergy_id" IS NOT NULL
      WHEN 'chart-no-allergy'  THEN "patient_allergy_absence_id" IS NOT NULL
      WHEN 'chart-history'     THEN "patient_history_id" IS NOT NULL
      ELSE false
    END
  ELSE
    num_nonnulls("clinical_note_id", "encounter_diagnosis_id", "prescription_id",
                 "service_order_id", "patient_allergy_id",
                 "patient_allergy_absence_id", "patient_history_id") = 0
  END);

CREATE INDEX "ai_suggestion_patient_allergy_id_idx" ON "ai_suggestion"("patient_allergy_id");
CREATE INDEX "ai_suggestion_patient_allergy_absence_id_idx" ON "ai_suggestion"("patient_allergy_absence_id");
CREATE INDEX "ai_suggestion_patient_history_id_idx" ON "ai_suggestion"("patient_history_id");

-- AS-020, AS-021, AS-266. The attempt of its own attention; a record of the
-- attention, or — for the chart — of the attention's patient.
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
    IF record_patient IS DISTINCT FROM (SELECT "patient_id" FROM "encounter" WHERE "id" = NEW."encounter_id") THEN
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
