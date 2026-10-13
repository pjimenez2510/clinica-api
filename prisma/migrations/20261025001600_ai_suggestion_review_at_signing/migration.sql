-- ai_suggestion_review
--
-- E1 (PLAN-ASISTENTE-IA §7, AS-144, AS-145). When the consultation note is
-- signed, each section of the draft the physician had in front of them is
-- reviewed against what was signed: the signed note, what the proposal's
-- state was at that moment, and the distance (AS-022) between the proposed
-- text and the signed section. A table of its own and not columns of
-- `ai_suggestion`, which is immutable once decided (AS-023) and archives
-- every change in `record_version`: the review is a later fact about the
-- proposal, written once. No text (AS-146): ids, a state and a number.
BEGIN;

CREATE TABLE "ai_suggestion_review" (
  "suggestion_id"     UUID           NOT NULL,
  "clinical_note_id"  UUID           NOT NULL,
  "status_at_signing" VARCHAR(24)    NOT NULL,
  "distance"          DECIMAL(5,4)   NOT NULL,
  -- The application's clock, never now() (the e2e move it).
  "reviewed_at"       TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "ai_suggestion_review_pkey" PRIMARY KEY ("suggestion_id"),
  CONSTRAINT "ai_suggestion_review_suggestion_id_fkey" FOREIGN KEY ("suggestion_id")
    REFERENCES "ai_suggestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_suggestion_review_clinical_note_id_fkey" FOREIGN KEY ("clinical_note_id")
    REFERENCES "clinical_note"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- AS-145. The `IS NOT NULL` is not redundant: a CHECK that yields NULL passes.
  CONSTRAINT "ai_suggestion_review_distance_in_range" CHECK (
    "distance" IS NOT NULL AND "distance" >= 0 AND "distance" <= 1)
);

CREATE INDEX "ai_suggestion_review_clinical_note_id_idx"
  ON "ai_suggestion_review"("clinical_note_id");

-- AS-145. A section of a note, reviewed against a SIGNED note of its own
-- attention, with the state the proposal really has.
CREATE OR REPLACE FUNCTION ai_suggestion_review_coherent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  proposal_kind      TEXT;
  proposal_status    TEXT;
  proposal_encounter UUID;
  note_encounter     UUID;
  note_signed_at     TIMESTAMPTZ;
  note_form          TEXT;
  note_status        TEXT;
BEGIN
  SELECT "kind", "status", "encounter_id"
    INTO proposal_kind, proposal_status, proposal_encounter
    FROM "ai_suggestion" WHERE "id" = NEW."suggestion_id";
  SELECT "encounter_id", "signed_at", "form_code", "status"::text
    INTO note_encounter, note_signed_at, note_form, note_status
    FROM "clinical_note" WHERE "id" = NEW."clinical_note_id";

  IF proposal_kind IS DISTINCT FROM 'note-section' THEN
    RAISE EXCEPTION 'ai_suggestion_review_of_a_section: only a section of the note is reviewed at signing'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'ai_suggestion_review_of_a_section',
            HINT = 'AS-145.';
  END IF;
  -- The consultation note the draft writes into (002), as it was signed:
  -- SIGNED, or SUPERSEDED by an amendment since; never a retracted one.
  IF note_signed_at IS NULL
     OR note_form IS DISTINCT FROM '002'
     OR note_status NOT IN ('SIGNED', 'SUPERSEDED')
     OR note_encounter IS DISTINCT FROM proposal_encounter THEN
    RAISE EXCEPTION 'ai_suggestion_review_of_a_signed_note: the note is not the signed consultation note of this attention'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'ai_suggestion_review_of_a_signed_note',
            HINT = 'AS-145. Se revisa contra la nota firmada de la misma atención.';
  END IF;
  IF NEW."status_at_signing" IS DISTINCT FROM proposal_status THEN
    RAISE EXCEPTION 'ai_suggestion_review_states_the_decision: the state at signing is not the proposal''s'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'ai_suggestion_review_states_the_decision',
            HINT = 'AS-145. Lo que el médico hizo con la propuesta lo dice la propuesta.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ai_suggestion_review_coherent"
  BEFORE INSERT ON "ai_suggestion_review"
  FOR EACH ROW EXECUTE FUNCTION ai_suggestion_review_coherent();

-- AS-145. Written once: the review is what was measured at the signature.
CREATE OR REPLACE FUNCTION ai_suggestion_review_is_kept()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ai_suggestion_review_is_kept: a review is never changed nor deleted'
    USING ERRCODE = 'check_violation',
          CONSTRAINT = 'ai_suggestion_review_is_kept',
          HINT = 'AS-145.';
END;
$$;

CREATE TRIGGER "ai_suggestion_review_is_kept"
  BEFORE UPDATE OR DELETE ON "ai_suggestion_review"
  FOR EACH ROW EXECUTE FUNCTION ai_suggestion_review_is_kept();

-- The same refusal as `ai_suggestion_never_truncated`: a TRUNCATE … CASCADE
-- of the proposals reaches this table too, and says the same.
CREATE TRIGGER "ai_suggestion_review_never_truncated"
  BEFORE TRUNCATE ON "ai_suggestion_review"
  FOR EACH STATEMENT EXECUTE FUNCTION record_version_insert_only();

COMMIT;
