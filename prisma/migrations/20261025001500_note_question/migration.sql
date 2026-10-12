-- note_question
--
-- Escrito a mano. C3 (PLAN-ASISTENTE-IA §7): «Para completar la nota».
--
-- 1. UNA PREGUNTA ES UNA PROPUESTA QUE NUNCA SE ACEPTA (AS-121). `ai_suggestion`
--    admite la clase `note-question`; `ai_suggestion_accepted_links_its_record`
--    ya la deja sin aceptar, porque su `CASE` no la nombra y cae en `false`:
--    una pregunta no es un dato de la historia (P1). Se descarta («No hace
--    falta») o la sustituye la revisión siguiente.
--
-- 2. CADA REVISIÓN QUE RESPONDIÓ, SIN TEXTO (AS-121, AS-124). Qué tramo de la
--    transcripción leyó, la huella de lo que la nota tenía escrito y cuántas
--    preguntas guardó y descartó. Es lo que dice cuál es la revisión vigente,
--    también cuando no dejó ninguna pregunta, y lo que evita llamar otra vez
--    con lo mismo (AS-123). La línea de la conversación no se guarda aquí
--    (AS-058): se relee de `transcript_segment` por su tramo.
BEGIN;

ALTER TABLE "ai_suggestion" DROP CONSTRAINT "ai_suggestion_kind_known";
ALTER TABLE "ai_suggestion" ADD CONSTRAINT "ai_suggestion_kind_known" CHECK ("kind" IS NOT NULL AND "kind" IN (
  'note-section', 'diagnosis', 'prescription-item', 'order-item', 'note-question'));

CREATE TABLE "note_question_check" (
  "id"           UUID          NOT NULL DEFAULT uuidv7(),
  "encounter_id" UUID          NOT NULL,
  -- The attempt that answered: the questions of this review cite the same one.
  "ai_run_id"    UUID          NOT NULL,
  -- The end of the last segment the review read, in the listening's clock.
  "up_to_ms"     INTEGER       NOT NULL,
  -- SHA-256, in lowercase hex, of what the note had written when it was read.
  "note_digest"  VARCHAR(64)   NOT NULL,
  "asked"        SMALLINT      NOT NULL,
  "dropped"      SMALLINT      NOT NULL,
  "requested_by" UUID          NOT NULL,
  -- The application's clock, never now() (the e2e move it).
  "checked_at"   TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "note_question_check_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "note_question_check_encounter_id_fkey" FOREIGN KEY ("encounter_id")
    REFERENCES "encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "note_question_check_ai_run_id_fkey" FOREIGN KEY ("ai_run_id")
    REFERENCES "ai_run" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "note_question_check_requested_by_fkey" FOREIGN KEY ("requested_by")
    REFERENCES "app_user" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "note_question_check_stretch_known" CHECK ("up_to_ms" >= 0),
  -- AS-120. Five at most on screen.
  CONSTRAINT "note_question_check_asked_at_most_five" CHECK ("asked" BETWEEN 0 AND 5),
  CONSTRAINT "note_question_check_dropped_counted" CHECK ("dropped" >= 0),
  -- A digest and nothing else: no text of the note fits in this column.
  CONSTRAINT "note_question_check_digest_is_one" CHECK ("note_digest" ~ '^[0-9a-f]{64}$')
);

-- AS-122. The current review is the latest of its attention.
CREATE INDEX "note_question_check_encounter_checked_idx"
  ON "note_question_check" ("encounter_id", "checked_at");

-- AS-121. The attempt answered (`ok`) in this same attention: a review that
-- pointed at another one would lead «de dónde salió» to another patient's
-- conversation, as AS-020 guards for `ai_suggestion`.
CREATE OR REPLACE FUNCTION note_question_check_run_of_its_encounter()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_encounter UUID;
  run_outcome   TEXT;
BEGIN
  SELECT "encounter_id", "outcome" INTO run_encounter, run_outcome
    FROM "ai_run" WHERE "id" = NEW."ai_run_id";
  IF run_encounter IS DISTINCT FROM NEW."encounter_id"
     OR run_outcome IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'note_question_check_run_of_its_encounter: the attempt is not an answer of this attention'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'note_question_check_run_of_its_encounter',
            HINT = 'AS-121. La revisión sale del intento que respondió en su propia atención.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "note_question_check_run_of_its_encounter"
  BEFORE INSERT ON "note_question_check"
  FOR EACH ROW EXECUTE FUNCTION note_question_check_run_of_its_encounter();

-- AS-121. What a review read is what it read: never rewritten nor deleted.
CREATE OR REPLACE FUNCTION note_question_check_is_kept()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'note_question_check_is_kept: a review is never rewritten nor deleted'
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'AS-121. Una revisión nueva se añade; la anterior queda.';
END;
$$;

CREATE TRIGGER "note_question_check_is_kept"
  BEFORE UPDATE OR DELETE ON "note_question_check"
  FOR EACH ROW EXECUTE FUNCTION note_question_check_is_kept();

CREATE TRIGGER "note_question_check_never_truncated"
  BEFORE TRUNCATE ON "note_question_check"
  FOR EACH STATEMENT EXECUTE FUNCTION record_version_insert_only();

COMMIT;
