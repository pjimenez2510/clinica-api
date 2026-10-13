-- note_question_purpose
--
-- Escrito a mano. Revisiones de feat/ia-c3-completar-nota (12-10-2026): una
-- revisión «Para completar la nota» sale de un intento que respondió a ESA
-- pregunta (`purpose = 'note-questions'`), no del intento de un borrador o de
-- una receta de la misma atención: la bitácora de quién preguntó qué queda
-- bien atribuida (AS-121).
BEGIN;

CREATE OR REPLACE FUNCTION note_question_check_run_of_its_encounter()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_encounter UUID;
  run_outcome   TEXT;
  run_purpose   TEXT;
BEGIN
  SELECT "encounter_id", "outcome", "purpose" INTO run_encounter, run_outcome, run_purpose
    FROM "ai_run" WHERE "id" = NEW."ai_run_id";
  IF run_encounter IS DISTINCT FROM NEW."encounter_id"
     OR run_outcome IS DISTINCT FROM 'ok'
     OR run_purpose IS DISTINCT FROM 'note-questions' THEN
    RAISE EXCEPTION 'note_question_check_run_of_its_encounter: the attempt is not an answer of this attention to its questions'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'note_question_check_run_of_its_encounter',
            HINT = 'AS-121. La revisión sale del intento que respondió a las preguntas en su propia atención.';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
