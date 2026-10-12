-- ai_suggestion_review
--
-- Escrito a mano. feat/ia-a1-procedencia-if-match, correcciones de la revisión
-- del 11-10-2026 (código, seguridad y clínica). Una migración aparte y no una
-- reescritura de `20261025000700`: feat/ia-d1-cie10 ya la trajo tal cual.
--
-- 1. EL DIAGNÓSTICO SIN CLAVE FORÁNEA (D-243 §3). Quitar un diagnóstico lo
--    BORRA de `encounter_diagnosis` y lo copia, con el mismo id, a
--    `encounter_diagnosis_retraction` (EN-180). Con la clave RESTRICT, un
--    diagnóstico propuesto y aceptado no se podría quitar nunca, y el
--    equivocado seguiría en la atención y en el RDACAA; con SET NULL la
--    propuesta olvidaría a qué se aceptó (P1). Sin clave, el disparador
--    `ai_suggestion_record_in_its_encounter` comprueba al decidir que el
--    diagnóstico existe y es de la atención (lo lee de `encounter_diagnosis`:
--    si no está, el encuentro leído es NULL y se rechaza), y después el id
--    sigue llevando a su retiro.
--
-- 2. EL INTENTO, DE LA MISMA ATENCIÓN Y QUE RESPONDIÓ (AS-020). Una propuesta
--    que señalara el intento de otra atención llevaría «de dónde salió» a la
--    conversación —y al `ai_exchange`— de otro paciente (P2). Sólo al
--    insertar: después esas columnas no cambian (`ai_suggestion_decided_once`).
--
-- 3. Nota sobre `20261025000700`: su comentario dice que `a_…` corre antes
--    que los demás disparadores; corre antes de los que congelan la fila
--    entera (`prescription_frozen`, `service_order_guard_status`,
--    `trg_clinical_note_immutable`), no antes de otros `a_…` de la tabla, que
--    no leen la revisión.
BEGIN;

ALTER TABLE "ai_suggestion"
  DROP CONSTRAINT "ai_suggestion_encounter_diagnosis_id_fkey";

CREATE OR REPLACE FUNCTION ai_suggestion_record_in_its_encounter()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  record_encounter UUID;
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
