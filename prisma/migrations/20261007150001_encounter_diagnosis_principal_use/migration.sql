-- encounter_diagnosis_principal_use
--
-- Written by hand. `prisma migrate dev` is forbidden in this repository: it
-- proposes dropping the generated columns, the GIN and BRIN indexes, the
-- partial unique indexes and the triggers, because schema.prisma cannot
-- describe them. See scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-235 (D-147.3, decided by the author on 07-10-2026)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- No principal diagnosis (rank = 1) with a CIE-10 code the WHO list marks as
-- an ASTERISK (it accompanies its dagger and is never the principal: the DEIS
-- list says «permitidos solo para diagnóstico complementario o adicional») or
-- as an EXTERNAL CAUSE (V01–Y98: the circumstance, not the morbidity — the
-- RDACAA would count the consultation in the wrong cause).
--
-- The use is `catalog_concept.attributes->>'use'`, written by the WHO import
-- (EN-234): 'PRINCIPAL', 'ASTERISK' or 'EXTERNAL_CAUSE'.
--
-- WHAT IS NOT JUDGED:
--  · A concept with no `use` (the development edition before the WHO's): the
--    asterisk cannot be deduced from the code, so it is not refused.
--  · A row that was already the principal before this rule, while neither its
--    rank nor its concept changes: an UPDATE that lists those columns with
--    the same values is not «touching» them.
--
-- RAISED WITH THE NAME AS THE PREFIX of the message and as CONSTRAINT, so the
-- error mapping (`database-problem.ts`) reads `encounter_diagnosis_principal_use`
-- and `encounter.constraints.ts` turns it into DIAGNOSIS_PRINCIPAL_USE_INVALID
-- (422): one source for the API, an import and a `psql`.
--
-- NO DATA TO TOUCH: the trigger only runs on INSERT and on UPDATE OF rank,
-- concept_id, so no stored row is revalidated.
-- Afterwards: pnpm migrations:check && pnpm db:deploy

CREATE OR REPLACE FUNCTION encounter_diagnosis_principal_use()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  concept_use text;
BEGIN
  IF NEW."rank" <> 1 THEN
    RETURN NEW;
  END IF;
  -- Not touched: the same rank and the same concept as before.
  IF TG_OP = 'UPDATE'
     AND OLD."rank" = NEW."rank"
     AND OLD."concept_id" = NEW."concept_id" THEN
    RETURN NEW;
  END IF;

  SELECT c."attributes"->>'use' INTO concept_use
    FROM "catalog_concept" c
   WHERE c."id" = NEW."concept_id";
  -- No concept: the foreign key refuses it. No use: not judged.
  IF concept_use IN ('ASTERISK', 'EXTERNAL_CAUSE') THEN
    RAISE EXCEPTION 'encounter_diagnosis_principal_use: an asterisk or external-cause code is never the principal diagnosis'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'encounter_diagnosis_principal_use';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_diagnosis_principal_use"
  BEFORE INSERT OR UPDATE OF "rank", "concept_id" ON "encounter_diagnosis"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_diagnosis_principal_use();
