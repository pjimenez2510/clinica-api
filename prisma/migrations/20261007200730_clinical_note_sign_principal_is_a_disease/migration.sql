-- clinical_note_sign_principal_is_a_disease
--
-- Written by hand. `prisma migrate dev` is forbidden in this repository: it
-- proposes dropping the generated columns, the GIN and BRIN indexes, the
-- partial unique indexes and the triggers, because schema.prisma cannot
-- describe them. See scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-236 with EN-235. The principal that the discharge demands is a disease
-- or a lesion, never an asterisk nor an external cause
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `20261007150003_clinical_note_sign_needs_principal_diagnosis` demanded a
-- row of rank 1. EN-235 keeps an asterisk or an external cause out of rank 1
-- only when the rank or the concept is WRITTEN: a principal written before
-- EN-235 was deployed, or a concept that a catalogue reimport reclassified
-- afterwards, stays as rank 1 and let the attention be discharged with the
-- circumstance as its cause of morbidity in the RDACAA.
--
-- The function now demands a rank 1 whose concept is not ASTERISK nor
-- EXTERNAL_CAUSE (`catalog_concept.attributes->>'use'`). A concept without
-- `use` is not judged, as in EN-235. The same predicate lives in
-- `prisma-clinical-note.repository.ts` (`hasPrincipalDiagnosis`), so the
-- doctor gets the sentence before the trigger.
--
-- The trigger and its WHEN do not change: only the function is replaced.
--
-- NO DATA TO TOUCH: the trigger runs on the signature only; notes already
-- signed are not revalidated.
-- Afterwards: pnpm migrations:check && pnpm db:deploy

CREATE OR REPLACE FUNCTION clinical_note_sign_needs_diagnosis()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT encounter_has_discharge(NEW.encounter_id) THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM encounter_diagnosis d
                  WHERE d.encounter_id = NEW.encounter_id) THEN
    RAISE EXCEPTION
      'clinical_note_sign_needs_diagnosis: signing the consultation note discharges the attention, which needs at least one diagnosis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-020.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM encounter_diagnosis d
                   JOIN catalog_concept c ON c.id = d.concept_id
                  WHERE d.encounter_id = NEW.encounter_id
                    AND d.rank = 1
                    AND COALESCE(c.attributes->>'use', '')
                        NOT IN ('ASTERISK', 'EXTERNAL_CAUSE')) THEN
    RAISE EXCEPTION
      'clinical_note_sign_needs_principal_diagnosis: signing the consultation note discharges the attention, which needs a principal diagnosis that is a disease or a lesion'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-236, EN-235.';
  END IF;

  RETURN NULL;
END;
$$;
