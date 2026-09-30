-- ═══════════════════════════════════════════════════════════════════════════
-- THE ASSESSMENT ITSELF, SEPARATE FROM ITS OUTCOME
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A defect found reviewing `20260820052524_clinical_flow_states`, and it is
-- the difference between complying with art. 10 and only looking like it.
--
-- That migration recorded WHEN AN EMERGENCY WAS FLAGGED. But NULL then
-- conflates two entirely different facts:
--
--   * «someone assessed this patient on arrival and it was not an emergency»
--   * «nobody assessed anybody»
--
-- Ley 77 art. 10 obliges the establishment to state that «el estado de
-- emergencia del paciente será calificado … al momento de su arribo». What it
-- has to be able to prove is THAT THE CALL WAS MADE — the negatives just as
-- much as the positives. Recording only the positives proves nothing about the
-- patient who was waved through, which is precisely the patient art. 13 turns
-- into 12–18 months of prison.
ALTER TABLE "agenda_entry"
  ADD COLUMN "emergency_assessed_at"    TIMESTAMPTZ(6),
  ADD COLUMN "emergency_assessed_by_id" UUID;

ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_emergency_assessment_fk"
    FOREIGN KEY ("emergency_assessed_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT;

ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_emergency_assessment_names_who_and_when" CHECK (
    ("emergency_assessed_at" IS NULL) = ("emergency_assessed_by_id" IS NULL)
  );

-- Flagging an emergency without having assessed is incoherent: the flag is the
-- OUTCOME of the assessment, so the assessment has to exist first.
ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_emergency_flag_follows_assessment" CHECK (
    "emergency_flagged_at" IS NULL OR "emergency_assessed_at" IS NOT NULL
  );

-- ───────────────────────────────────────────────────────────────────────────
-- A constraint name that reads badly is a contract that reads badly
-- ───────────────────────────────────────────────────────────────────────────
--
-- `encounter_discharged_states_state_a_condition` says «states_state». The
-- name travels to the client through the PostgreSQL error mapping, so it is
-- part of the published contract and worth fixing while nothing depends on it.
ALTER TABLE "encounter"
  RENAME CONSTRAINT "encounter_discharged_states_state_a_condition"
  TO "encounter_discharge_states_a_condition";
