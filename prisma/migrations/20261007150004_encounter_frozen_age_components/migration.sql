-- encounter_frozen_age_components
--
-- Written by hand. `prisma migrate dev` is forbidden in this repository: it
-- proposes dropping the generated columns, the GIN and BRIN indexes, the
-- partial unique indexes and the triggers, because schema.prisma cannot
-- describe them. See scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-008. The age frozen on the attention does not change — all of it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `trg_encounter_age_frozen` (20261006084236_encounter_frozen_whole_age)
-- protected `age_in_days` and `age_estimated` only. `age_years`, `age_months`
-- and `age_days` are what the RDACAA classifies by and what decides the dental
-- index (EN-052, `trg_encounter_dental_index_applies`): an UPDATE could move a
-- child of 11 into the CEO-D band after the fact.
--
-- Nothing in the code writes them after the INSERT: `trg_encounter_freeze_age`
-- computes them BEFORE INSERT and no adapter, seed or migration updates them
-- (searched on 07-10-2026). An UPDATE that lists them with the same values is
-- not a change and goes through.
--
-- NO DATA TO TOUCH: the trigger judges updates only.
-- Afterwards: pnpm migrations:check && pnpm db:deploy

CREATE OR REPLACE FUNCTION encounter_age_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."age_in_days" IS DISTINCT FROM OLD."age_in_days"
     OR NEW."age_estimated" IS DISTINCT FROM OLD."age_estimated"
     OR NEW."age_years" IS DISTINCT FROM OLD."age_years"
     OR NEW."age_months" IS DISTINCT FROM OLD."age_months"
     OR NEW."age_days" IS DISTINCT FROM OLD."age_days" THEN
    RAISE EXCEPTION 'La edad congelada de una atención no cambia (EN-008, EN-221)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER trg_encounter_age_frozen ON "encounter";

CREATE TRIGGER trg_encounter_age_frozen
  BEFORE UPDATE OF "age_in_days", "age_estimated", "age_years", "age_months", "age_days"
  ON "encounter"
  FOR EACH ROW EXECUTE FUNCTION encounter_age_frozen();
