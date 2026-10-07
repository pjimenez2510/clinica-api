-- encounter_dental_index_teeth_total
--
-- Written by hand. `prisma migrate dev` is forbidden in this repository: it
-- proposes dropping the generated columns, the GIN and BRIN indexes, the
-- partial unique indexes and the triggers, because schema.prisma cannot
-- describe them. See scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-052. Each tooth is in ONE category: the sum is bounded too
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `20261007085419_encounter_dental_index` bounded every count on its own, so
-- 20 decayed + 20 extracted + 20 filled passed as a CEO-D: sixty primary teeth
-- in a mouth that has twenty. Decayed, extracted and filled add up to at most
-- 20 in the CEO-D; decayed, missing and filled to at most 32 in the CPO-D.
--
-- AND EACH REFUSAL NAMES ITS COUNT. The single `encounter_dental_index_primary_teeth`
-- and `encounter_dental_index_counts_required` could only point at one box;
-- they become one name per count, so the error mapping names the field to fix
-- (`encounter.constraints.ts`). The total names the index as a whole.
--
-- Refusals (all `check_violation`, the name first in the message):
--  · `encounter_dental_index_<count>_required` — a count of the index missing.
--  · `encounter_dental_index_<count>_primary`  — a CEO-D count above 20.
--  · `encounter_dental_index_primary_total`    — CEO-D sum above 20.
--  · `encounter_dental_index_permanent_total`  — CPO-D sum above 32.
--  · `encounter_dental_index_applies`          — unchanged.
--
-- NO DATA TO TOUCH: the branch that created the table is not merged; no row
-- of a real clinic exists.
-- Afterwards: pnpm migrations:check && pnpm db:deploy

CREATE OR REPLACE FUNCTION encounter_dental_index_refuse(name text, reason text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '%: %', name, reason
    USING ERRCODE = 'check_violation',
          CONSTRAINT = name;
END;
$$;

CREATE OR REPLACE FUNCTION encounter_dental_index_applies()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  years  integer;
  months integer;
  days   integer;
  primary_band   boolean;
  permanent_band boolean;
BEGIN
  SELECT e."age_years", e."age_months", e."age_days"
    INTO years, months, days
    FROM "encounter" e
   WHERE e."id" = NEW."encounter_id";
  -- No attention: the foreign key refuses it.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- CEO-D: more than 6 months and less than 11 years. CPO-D: 12 years or
  -- more. A NULL age is in neither band (COALESCE keeps it false, not NULL).
  primary_band := COALESCE(
    (years > 0 OR months > 6 OR (months = 6 AND days > 0)) AND years < 11,
    false);
  permanent_band := COALESCE(years >= 12, false);

  IF primary_band THEN
    IF NEW."missing" IS NOT NULL THEN
      PERFORM encounter_dental_index_refuse('encounter_dental_index_applies',
        'the CEO-D counts extracted primary teeth, not missing permanent ones');
    END IF;
    IF NEW."decayed" IS NULL THEN
      PERFORM encounter_dental_index_refuse('encounter_dental_index_decayed_required', 'the CEO-D counts decayed teeth');
    END IF;
    IF NEW."extracted" IS NULL THEN
      PERFORM encounter_dental_index_refuse('encounter_dental_index_extracted_required', 'the CEO-D counts extracted teeth');
    END IF;
    IF NEW."filled" IS NULL THEN
      PERFORM encounter_dental_index_refuse('encounter_dental_index_filled_required', 'the CEO-D counts filled teeth');
    END IF;
    IF NEW."decayed" > 20 THEN
      PERFORM encounter_dental_index_refuse('encounter_dental_index_decayed_primary', 'at most 20 primary teeth');
    END IF;
    IF NEW."extracted" > 20 THEN
      PERFORM encounter_dental_index_refuse('encounter_dental_index_extracted_primary', 'at most 20 primary teeth');
    END IF;
    IF NEW."filled" > 20 THEN
      PERFORM encounter_dental_index_refuse('encounter_dental_index_filled_primary', 'at most 20 primary teeth');
    END IF;
    IF NEW."decayed" + NEW."extracted" + NEW."filled" > 20 THEN
      PERFORM encounter_dental_index_refuse('encounter_dental_index_primary_total',
        'decayed, extracted and filled are at most the 20 primary teeth');
    END IF;
  ELSIF permanent_band THEN
    IF NEW."extracted" IS NOT NULL THEN
      PERFORM encounter_dental_index_refuse('encounter_dental_index_applies',
        'the CPO-D counts missing permanent teeth, not extracted primary ones');
    END IF;
    IF NEW."decayed" IS NULL THEN
      PERFORM encounter_dental_index_refuse('encounter_dental_index_decayed_required', 'the CPO-D counts decayed teeth');
    END IF;
    IF NEW."missing" IS NULL THEN
      PERFORM encounter_dental_index_refuse('encounter_dental_index_missing_required', 'the CPO-D counts missing teeth');
    END IF;
    IF NEW."filled" IS NULL THEN
      PERFORM encounter_dental_index_refuse('encounter_dental_index_filled_required', 'the CPO-D counts filled teeth');
    END IF;
    IF NEW."decayed" + NEW."missing" + NEW."filled" > 32 THEN
      PERFORM encounter_dental_index_refuse('encounter_dental_index_permanent_total',
        'decayed, missing and filled are at most the 32 permanent teeth');
    END IF;
  ELSE
    -- D-160: 11 years, 6 months or less, or no frozen age.
    PERFORM encounter_dental_index_refuse('encounter_dental_index_applies',
      'the frozen age of the attention is in neither band of the instructivo');
  END IF;

  RETURN NEW;
END;
$$;
