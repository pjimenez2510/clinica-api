-- clinical_note_sign_needs_principal_diagnosis
--
-- Written by hand. `prisma migrate dev` is forbidden in this repository: it
-- proposes dropping the generated columns, the GIN and BRIN indexes, the
-- partial unique indexes and the triggers, because schema.prisma cannot
-- describe them. See scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-236. Signing the 002 that discharges needs the PRINCIPAL diagnosis
-- ═══════════════════════════════════════════════════════════════════════════
--
-- EN-020 asked for «at least one diagnosis». With EN-235 an external cause or
-- an asterisk is never rank 1, so the natural order on a lesion — the cause
-- first — left an attention discharged with diagnoses and no principal: the
-- RDACAA would not know in which cause to count it.
--
-- The deferred `trg_clinical_note_sign_needs_diagnosis` keeps its trigger and
-- its WHEN; only the function grows a second refusal, raised with its own name
-- as the prefix so the error mapping reads it (`encounter.constraints.ts` →
-- NOTE_CONTENT_INCOMPLETE on `principalDiagnosis`). Like EN-020, only when the
-- signature leaves the attention discharged: signing the drafts of an
-- interruption (EN-167) does not demand it.
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
                  WHERE d.encounter_id = NEW.encounter_id
                    AND d.rank = 1) THEN
    RAISE EXCEPTION
      'clinical_note_sign_needs_principal_diagnosis: signing the consultation note discharges the attention, which needs a principal diagnosis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-236.';
  END IF;

  RETURN NULL;
END;
$$;
