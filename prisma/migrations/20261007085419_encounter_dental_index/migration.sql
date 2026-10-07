-- encounter_dental_index
--
-- Written by hand. `prisma migrate dev` is forbidden in this repository: it
-- proposes dropping the generated columns, the GIN and BRIN indexes, the
-- partial unique indexes and the triggers, because schema.prisma cannot
-- describe them. See scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-052. The CEO-D and CPO-D indices of an odontology attention
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Columns 101 (decayed), 102 (extracted), 103 (filled) and 104 (missing) of
-- the RDACAA form (instructivo v 2.0, p. 46). The CEO-D counts decayed,
-- extracted and filled primary teeth «en el usuario que tiene la edad de
-- >6 meses y < 11 años»; the CPO-D counts decayed, missing and filled
-- permanent teeth «con edad mayor o igual a 12 años».
--
-- D-160 — BUILT LITERALLY WHILE IT IS DECIDED: at 11 years, at 6 months or
-- less and with no frozen age neither index applies. Which specialty counts as
-- odontology is the service's (the database knows nothing about specialties).
--
-- THE AGE IS THE ONE FROZEN ON THE ATTENTION (EN-008), never today's: a child
-- of 10 seen in March keeps 10 in the row of March for ever. `age_years`,
-- `age_months` and `age_days` are the components of the age on the clinical
-- date (months 0..11, days 0..30), so «more than 6 months» is
-- years > 0, or months > 6, or exactly 6 months and some days.
--
-- One row per attention, corrected in place and VERSIONED like the taking of
-- vital signs (EN-210): `record_version_archive` demands a new stamp in
-- `edited_by_id` / `edited_at` and archives the whole previous row. The row
-- holds nothing secret, so archiving it whole is safe.
--
-- What each refusal is called, and what the API answers (encounter.constraints.ts):
--  · `encounter_dental_index_<count>_range` — a count outside 0..32, the
--    permanent teeth there are → VALIDATION_FAILED on that count.
--  · `encounter_dental_index_primary_teeth` — a CEO-D count above 20, the
--    primary teeth there are → VALIDATION_FAILED.
--  · `encounter_dental_index_counts_required` — one of the three counts of
--    the index that applies is missing → VALIDATION_FAILED.
--  · `encounter_dental_index_applies` — the frozen age is in neither band, or
--    the row carries the count of the other index (extracted in a CPO-D,
--    missing in a CEO-D) → DENTAL_INDEX_NOT_APPLICABLE (422).
-- Afterwards: pnpm migrations:check && pnpm db:deploy

CREATE TABLE "encounter_dental_index" (
  "encounter_id" UUID PRIMARY KEY,

  "decayed"   SMALLINT,
  "extracted" SMALLINT,
  "filled"    SMALLINT,
  "missing"   SMALLINT,

  -- Who recorded the index, and when: never changes once written.
  "recorded_by_id" UUID NOT NULL,
  "recorded_at"    TIMESTAMPTZ(6) NOT NULL,

  -- The stamp of the last correction (EN-210); both or neither.
  "edited_by_id" UUID,
  "edited_at"    TIMESTAMPTZ(6),

  CONSTRAINT "encounter_dental_index_encounter_id_fkey"
    FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "encounter_dental_index_recorded_by_id_fkey"
    FOREIGN KEY ("recorded_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "encounter_dental_index_edited_by_id_fkey"
    FOREIGN KEY ("edited_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "encounter_dental_index_decayed_range"
    CHECK ("decayed" BETWEEN 0 AND 32),
  CONSTRAINT "encounter_dental_index_extracted_range"
    CHECK ("extracted" BETWEEN 0 AND 32),
  CONSTRAINT "encounter_dental_index_filled_range"
    CHECK ("filled" BETWEEN 0 AND 32),
  CONSTRAINT "encounter_dental_index_missing_range"
    CHECK ("missing" BETWEEN 0 AND 32),
  CONSTRAINT "encounter_dental_index_edit_stamp_whole"
    CHECK (("edited_by_id" IS NULL) = ("edited_at" IS NULL))
);

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
      RAISE EXCEPTION 'encounter_dental_index_applies: the CEO-D counts extracted primary teeth, not missing permanent ones'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'encounter_dental_index_applies';
    END IF;
    IF NEW."decayed" IS NULL OR NEW."extracted" IS NULL OR NEW."filled" IS NULL THEN
      RAISE EXCEPTION 'encounter_dental_index_counts_required: the CEO-D is decayed, extracted and filled'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'encounter_dental_index_counts_required';
    END IF;
    IF NEW."decayed" > 20 OR NEW."extracted" > 20 OR NEW."filled" > 20 THEN
      RAISE EXCEPTION 'encounter_dental_index_primary_teeth: the CEO-D counts primary teeth, at most 20'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'encounter_dental_index_primary_teeth';
    END IF;
  ELSIF permanent_band THEN
    IF NEW."extracted" IS NOT NULL THEN
      RAISE EXCEPTION 'encounter_dental_index_applies: the CPO-D counts missing permanent teeth, not extracted primary ones'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'encounter_dental_index_applies';
    END IF;
    IF NEW."decayed" IS NULL OR NEW."missing" IS NULL OR NEW."filled" IS NULL THEN
      RAISE EXCEPTION 'encounter_dental_index_counts_required: the CPO-D is decayed, missing and filled'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'encounter_dental_index_counts_required';
    END IF;
  ELSE
    -- D-160: 11 years, 6 months or less, or no frozen age.
    RAISE EXCEPTION 'encounter_dental_index_applies: the frozen age of the attention is in neither band of the instructivo'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'encounter_dental_index_applies';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_dental_index_applies"
  BEFORE INSERT OR UPDATE ON "encounter_dental_index"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_dental_index_applies();

-- Whoever recorded the index stays its author: a correction is an edit.
CREATE OR REPLACE FUNCTION encounter_dental_index_keeps_its_author()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."recorded_by_id" IS DISTINCT FROM OLD."recorded_by_id"
     OR NEW."recorded_at" IS DISTINCT FROM OLD."recorded_at" THEN
    RAISE EXCEPTION 'encounter_dental_index_keeps_its_author: who recorded the index, and when, does not change'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'encounter_dental_index_keeps_its_author';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_dental_index_keeps_its_author"
  BEFORE UPDATE ON "encounter_dental_index"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_dental_index_keeps_its_author();

-- EN-210. The previous index, whole, in `record_version`.
CREATE TRIGGER "trg_encounter_dental_index_record_version"
  BEFORE UPDATE ON "encounter_dental_index"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_archive('edited_by_id', 'edited_at', 'encounter_id');
