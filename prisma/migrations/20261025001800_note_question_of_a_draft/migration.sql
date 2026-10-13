-- note_question_of_a_draft
--
-- Escrito a mano. Revisión de C3 (12-10-2026): una revisión de «Para completar
-- la nota» pedida justo antes de firmar tarda hasta 45 s y, al volver, guardaba
-- sus preguntas y su `note_question_check` sobre una nota ya firmada.
--
-- AS-124. Una pregunta, y la revisión que la trae, sólo se guardan mientras la
-- 002 de su atención está en borrador. La nota se lee FOR SHARE: una firma que
-- se cruza con el guardado o espera a que termine (la revisión llegó antes de
-- firmar) o ya ganó, y entonces la fila vuelve a leerse firmada y se rechaza.
-- Nunca quedan las dos.
BEGIN;

CREATE OR REPLACE FUNCTION note_question_of_a_draft()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1
     FROM "clinical_note"
    WHERE "encounter_id" = NEW."encounter_id"
      AND "form_code" = '002'
      AND "status" = 'DRAFT'
      FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'note_question_of_a_draft: the consultation note of this attention is not a draft'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'note_question_of_a_draft',
            HINT = 'AS-124. Las preguntas para completar la nota sólo se guardan con la 002 en borrador.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "note_question_check_of_a_draft"
  BEFORE INSERT ON "note_question_check"
  FOR EACH ROW EXECUTE FUNCTION note_question_of_a_draft();

CREATE TRIGGER "ai_suggestion_note_question_of_a_draft"
  BEFORE INSERT ON "ai_suggestion"
  FOR EACH ROW WHEN (NEW."kind" = 'note-question')
  EXECUTE FUNCTION note_question_of_a_draft();

COMMIT;
