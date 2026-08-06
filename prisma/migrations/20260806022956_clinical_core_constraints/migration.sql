-- Integrity guarantees Prisma cannot express.
--
-- Prisma has no syntax for exclusion constraints (#17514), GiST indexes
-- (#15173) or generated columns (#6336). Everything here therefore lives in a
-- hand-written migration.
--
-- CONSEQUENCE: `prisma db push` is FORBIDDEN in this project. It rebuilds the
-- schema from schema.prisma and would silently drop every constraint below —
-- including the appointment non-overlap rule and the immutability of signed
-- clinical notes.

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- equality operators inside GiST
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- typo-tolerant patient search
CREATE EXTENSION IF NOT EXISTS unaccent;    -- accent-insensitive search

-- ===========================================================================
-- 1. AGENDA — the central guarantee of the system
-- ===========================================================================

-- Two patients can never hold the same practitioner at the same time.
-- The predicate uses two columns instead of `status NOT IN (...)` so that
-- adding a value to the enum never forces a rebuild of the GiST index.
ALTER TABLE agenda_entry
  ADD CONSTRAINT agenda_entry_no_practitioner_overlap
  EXCLUDE USING gist (
    practitioner_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
  WHERE (released_at IS NULL AND blocks_calendar);

-- Same room cannot host two appointments at once.
ALTER TABLE agenda_entry
  ADD CONSTRAINT agenda_entry_no_room_overlap
  EXCLUDE USING gist (
    room_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
  WHERE (released_at IS NULL AND blocks_calendar AND room_id IS NOT NULL);

ALTER TABLE agenda_entry
  ADD CONSTRAINT agenda_entry_time_order CHECK (ends_at > starts_at);

-- A block has no patient; an appointment must have one.
ALTER TABLE agenda_entry
  ADD CONSTRAINT agenda_entry_patient_coherence CHECK (
    (kind = 'APPOINTMENT' AND patient_id IS NOT NULL)
    OR (kind = 'BLOCK' AND patient_id IS NULL)
  );

-- Daily agenda worklist. Partial: cancelled rows only grow and are never
-- listed here. INCLUDE enables an index-only scan.
CREATE INDEX agenda_entry_daily_agenda
  ON agenda_entry (site_id, practitioner_id, starts_at)
  INCLUDE (ends_at, status, kind, patient_id, room_id)
  WHERE released_at IS NULL;

-- ===========================================================================
-- 2. PATIENT — identity
-- ===========================================================================

-- Ecuadorian cedula check digit, enforced by the database.
-- A cedula with a bad check digit makes the ministry reject the whole RDACAA
-- row, and a bulk import bypasses the application layer entirely.
CREATE OR REPLACE FUNCTION is_valid_cedula(p_value text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  coefficients int[] := ARRAY[2,1,2,1,2,1,2,1,2];
  province int;
  total int := 0;
  product int;
  i int;
BEGIN
  IF p_value !~ '^\d{10}$' THEN RETURN false; END IF;

  province := substring(p_value, 1, 2)::int;
  IF NOT ((province BETWEEN 1 AND 24) OR province = 30) THEN RETURN false; END IF;

  -- Third digit >= 6 belongs to a RUC, never to a natural person's cedula.
  IF substring(p_value, 3, 1)::int >= 6 THEN RETURN false; END IF;

  FOR i IN 1..9 LOOP
    product := substring(p_value, i, 1)::int * coefficients[i];
    IF product > 9 THEN product := product - 9; END IF;
    total := total + product;
  END LOOP;

  RETURN ((10 - (total % 10)) % 10) = substring(p_value, 10, 1)::int;
END;
$$;

ALTER TABLE patient_identifier
  ADD CONSTRAINT patient_identifier_cedula_valid CHECK (
    type <> 'CEDULA' OR issuing_country <> 'ECU' OR is_valid_cedula(value)
  );

-- Uniqueness is PARTIAL on purpose. A total UNIQUE would make it impossible to
-- replace a document, and would block merging duplicates: the losing record
-- must release its cedula so the surviving one can keep it.
CREATE UNIQUE INDEX patient_identifier_active_unique
  ON patient_identifier (type, issuing_country, value)
  WHERE use = 'OFFICIAL'
    AND NOT patient_merged
    AND type <> 'PROVISIONAL';

-- Keeps the denormalised flag in sync so the partial index above stays correct
-- (index predicates cannot contain subqueries).
CREATE OR REPLACE FUNCTION sync_patient_identifier_merged()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id THEN
    UPDATE patient_identifier
       SET patient_merged = (NEW.merged_into_id IS NOT NULL)
     WHERE patient_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_patient_sync_merged
  AFTER UPDATE OF merged_into_id ON patient
  FOR EACH ROW EXECUTE FUNCTION sync_patient_identifier_merged();

-- Accent-insensitive, typo-tolerant patient search.
-- The one-argument unaccent() is STABLE and cannot be used in an index
-- expression, hence this IMMUTABLE wrapper.
CREATE OR REPLACE FUNCTION immutable_unaccent(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

COMMENT ON FUNCTION immutable_unaccent(text) IS
  'IMMUTABLE wrapper over unaccent. If the unaccent rules file ever changes, '
  'every index built on this function is silently corrupted: REINDEX after any '
  'major PostgreSQL upgrade.';

ALTER TABLE patient
  ADD COLUMN search_name text
  GENERATED ALWAYS AS (
    immutable_unaccent(lower(
      coalesce(given_name, '')        || ' ' ||
      coalesce(second_given_name, '') || ' ' ||
      coalesce(family_name, '')       || ' ' ||
      coalesce(second_family_name, '')
    ))
  ) STORED;

-- GIN and not GiST: GIN is faster at filtering, which is 95% of the usage.
-- GiST would only be needed for KNN ordering (ORDER BY <->), which GIN cannot do.
CREATE INDEX patient_search_name_trgm ON patient USING gin (search_name gin_trgm_ops);

-- Documents get a plain B-tree: nobody searches for a "similar" cedula.
CREATE INDEX patient_identifier_value_btree
  ON patient_identifier (value varchar_pattern_ops);

-- ===========================================================================
-- 3. CATALOGS — temporal uniqueness
-- ===========================================================================

ALTER TABLE catalog_concept
  DROP COLUMN IF EXISTS valid_period;

ALTER TABLE catalog_concept
  ADD COLUMN valid_period daterange
  GENERATED ALWAYS AS (daterange(valid_from, valid_to, '[)')) STORED;

-- Empty ranges are rejected by WITHOUT OVERLAPS; without this CHECK the next
-- statement fails with a far less obvious message.
ALTER TABLE catalog_concept
  ADD CONSTRAINT catalog_concept_period_not_empty CHECK (
    valid_to IS NULL OR valid_to > valid_from
  );

-- THE guarantee of this module: two simultaneously valid definitions of the
-- same code cannot exist. PostgreSQL 18 temporal UNIQUE, backed by GiST.
ALTER TABLE catalog_concept
  ADD CONSTRAINT catalog_concept_code_temporal_unique
  UNIQUE (system_id, code, valid_period WITHOUT OVERLAPS);

ALTER TABLE catalog_concept
  ADD COLUMN search_display text
  GENERATED ALWAYS AS (immutable_unaccent(lower(display))) STORED;

CREATE INDEX catalog_concept_search_trgm
  ON catalog_concept USING gin (search_display gin_trgm_ops);

CREATE INDEX catalog_concept_current
  ON catalog_concept (system_id, code) WHERE valid_to IS NULL;

-- ===========================================================================
-- 4. ENCOUNTER — frozen age, BMI, coherence
-- ===========================================================================

ALTER TABLE encounter
  ADD CONSTRAINT encounter_time_order CHECK (ended_at IS NULL OR ended_at >= started_at);

-- Age is frozen at insert time. Derive it on the fly and reprocessing an old
-- report yields different numbers; fixing a mistyped birth date would silently
-- rewrite reports already filed with the ministry.
-- A trigger and not a generated column: it reads another table, which a
-- generated column cannot do.
CREATE OR REPLACE FUNCTION encounter_freeze_age()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_birth date;
  v_age   interval;
BEGIN
  SELECT birth_date INTO v_birth FROM patient WHERE id = NEW.patient_id;

  IF v_birth > NEW.started_at::date THEN
    RAISE EXCEPTION 'encounter starts before the patient was born'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_age := age(NEW.started_at::date, v_birth);
  NEW.age_years  := extract(year  from v_age)::int;
  NEW.age_months := extract(month from v_age)::int;
  NEW.age_days   := extract(day   from v_age)::int;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_encounter_freeze_age
  BEFORE INSERT ON encounter
  FOR EACH ROW EXECUTE FUNCTION encounter_freeze_age();

-- The appointment and the encounter must belong to the same patient. Prisma
-- cannot express a cross-table composite foreign key.
CREATE OR REPLACE FUNCTION encounter_matches_appointment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_patient uuid;
BEGIN
  IF NEW.agenda_entry_id IS NULL THEN RETURN NEW; END IF;

  SELECT patient_id INTO v_patient FROM agenda_entry WHERE id = NEW.agenda_entry_id;
  IF v_patient IS DISTINCT FROM NEW.patient_id THEN
    RAISE EXCEPTION 'encounter patient does not match the appointment patient'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_encounter_matches_appointment
  BEFORE INSERT OR UPDATE OF agenda_entry_id, patient_id ON encounter
  FOR EACH ROW EXECUTE FUNCTION encounter_matches_appointment();

-- BMI computed by the database, never by the application.
CREATE OR REPLACE FUNCTION encounter_vitals_compute_bmi()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.weight_kg IS NOT NULL AND NEW.height_cm IS NOT NULL AND NEW.height_cm > 0 THEN
    NEW.bmi := round(NEW.weight_kg / ((NEW.height_cm / 100) ^ 2), 2);
  ELSE
    NEW.bmi := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_encounter_vitals_bmi
  BEFORE INSERT OR UPDATE OF weight_kg, height_cm ON encounter_vitals
  FOR EACH ROW EXECUTE FUNCTION encounter_vitals_compute_bmi();

-- Ranges deliberately wide: the goal is to catch the finger that typed 750
-- instead of 75, not to argue physiology with the clinic. A CHECK that is too
-- strict ends up disabled.
ALTER TABLE encounter_vitals
  ADD CONSTRAINT encounter_vitals_ranges CHECK (
    (weight_kg IS NULL OR weight_kg BETWEEN 0.3 AND 400)
    AND (height_cm IS NULL OR height_cm BETWEEN 20 AND 260)
    AND (systolic_bp IS NULL OR systolic_bp BETWEEN 40 AND 300)
    AND (diastolic_bp IS NULL OR diastolic_bp BETWEEN 20 AND 200)
    AND (systolic_bp IS NULL OR diastolic_bp IS NULL OR systolic_bp > diastolic_bp)
    AND (oxygen_saturation IS NULL OR oxygen_saturation BETWEEN 30 AND 100)
  );

CREATE INDEX encounter_pending_report
  ON encounter (site_id, started_at) WHERE reported_at IS NULL;

-- ===========================================================================
-- 5. CLINICAL NOTES — a signed note is never edited
-- ===========================================================================

ALTER TABLE clinical_note
  ADD CONSTRAINT clinical_note_signature_coherence CHECK (
    (status = 'DRAFT') = (signed_at IS NULL)
    AND (signed_at IS NULL) = (signed_by_id IS NULL)
    AND (signed_at IS NULL) = (content_hash IS NULL)
  );

ALTER TABLE clinical_note
  ADD CONSTRAINT clinical_note_amendment_reason CHECK (
    supersedes_id IS NULL OR amendment_reason IS NOT NULL
  );

ALTER TABLE clinical_note
  ADD CONSTRAINT clinical_note_version_positive CHECK (version >= 1);

-- One current version per chain. If this fails, two clinicians see two
-- different "current notes" for the same clinical act.
--
-- Keyed on `status` and not on a `superseded_by_id` column: Prisma's
-- self-relation only creates `supersedes_id` on the newer row, so "nobody
-- supersedes me" is not a column and cannot appear in an index predicate.
-- `status` already carries exactly that information.
CREATE UNIQUE INDEX clinical_note_one_current_per_chain
  ON clinical_note (chain_id)
  WHERE status IN ('DRAFT', 'SIGNED');

CREATE UNIQUE INDEX clinical_note_chain_version_unique
  ON clinical_note (chain_id, version);

-- A signed note is never edited. The ONLY permitted mutation is the one that
-- marks it superseded. Same mechanism that already protects access_audit.
CREATE OR REPLACE FUNCTION clinical_note_immutable_when_signed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'clinical notes are never deleted (note %)', OLD.id
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Retract with status = ENTERED_IN_ERROR, or amend with a new version.';
  END IF;

  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;                                  -- a draft is mutable
  END IF;

  -- Only permitted transition on an already-signed note: SIGNED -> SUPERSEDED
  -- with the content untouched.
  IF OLD.status = 'SIGNED'
     AND NEW.content      IS NOT DISTINCT FROM OLD.content
     AND NEW.content_hash IS NOT DISTINCT FROM OLD.content_hash
     AND NEW.signed_at    IS NOT DISTINCT FROM OLD.signed_at
     AND NEW.signed_by_id IS NOT DISTINCT FROM OLD.signed_by_id
     AND NEW.status = 'SUPERSEDED'
  THEN
    RETURN NEW;
  END IF;

  -- Retraction with no replacement.
  IF NEW.status = 'ENTERED_IN_ERROR'
     AND OLD.status = 'SIGNED'
     AND NEW.content IS NOT DISTINCT FROM OLD.content
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'clinical note % is signed and cannot be modified', OLD.id
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Create a new version with supersedes_id and amendment_reason.';
END;
$$;

CREATE TRIGGER trg_clinical_note_immutable
  BEFORE UPDATE OR DELETE ON clinical_note
  FOR EACH ROW EXECUTE FUNCTION clinical_note_immutable_when_signed();

CREATE TRIGGER trg_clinical_note_no_truncate
  BEFORE TRUNCATE ON clinical_note
  FOR EACH STATEMENT EXECUTE FUNCTION clinical_note_immutable_when_signed();

CREATE INDEX clinical_note_patient_timeline
  ON clinical_note (encounter_id, signed_at DESC)
  WHERE status = 'SIGNED';

-- ===========================================================================
-- 6. DIAGNOSES, PRESCRIPTIONS, RESULTS
-- ===========================================================================

CREATE UNIQUE INDEX encounter_diagnosis_one_primary
  ON encounter_diagnosis (encounter_id) WHERE rank = 1;

-- The frozen code must match the referenced concept. Without this, the
-- denormalisation that protects the record for 20 years becomes the way a lie
-- gets in.
CREATE OR REPLACE FUNCTION diagnosis_snapshot_matches_concept()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_code text; v_display text;
BEGIN
  SELECT code, display INTO v_code, v_display
    FROM catalog_concept WHERE id = NEW.concept_id;

  IF NEW.cie10_code IS DISTINCT FROM v_code THEN
    RAISE EXCEPTION 'frozen cie10_code % does not match concept % (%)',
      NEW.cie10_code, NEW.concept_id, v_code
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  NEW.cie10_display := coalesce(NEW.cie10_display, v_display);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_diagnosis_snapshot
  BEFORE INSERT ON encounter_diagnosis
  FOR EACH ROW EXECUTE FUNCTION diagnosis_snapshot_matches_concept();

-- The concept must have been in force on the day of care. Practical
-- alternative to FOREIGN KEY ... PERIOD: same semantics, without a GiST lookup
-- on every write and without the NO ACTION limitation of temporal FKs.
CREATE OR REPLACE FUNCTION diagnosis_concept_in_force()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_ok boolean;
BEGIN
  SELECT cc.valid_period @> e.started_at::date INTO v_ok
    FROM encounter e, catalog_concept cc
   WHERE e.id = NEW.encounter_id AND cc.id = NEW.concept_id;

  IF NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION 'CIE-10 concept % was not in force on the encounter date',
      NEW.concept_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_diagnosis_concept_in_force
  BEFORE INSERT ON encounter_diagnosis
  FOR EACH ROW EXECUTE FUNCTION diagnosis_concept_in_force();

-- Prescribing outside the CNMB is allowed, but must be justified.
ALTER TABLE prescription_item
  ADD CONSTRAINT prescription_item_off_formulary CHECK (
    concept_id IS NOT NULL OR off_formulary_justification IS NOT NULL
  );

ALTER TABLE prescription
  ADD CONSTRAINT prescription_issued_coherence CHECK (
    (status = 'DRAFT') = (issued_at IS NULL)
  );

-- A result has exactly one value. Three nullable columns without this CHECK
-- are three ways to store the same datum twice.
ALTER TABLE observation_result
  ADD CONSTRAINT observation_result_one_value CHECK (
    (value_numeric IS NOT NULL)::int
  + (value_text    IS NOT NULL)::int
  + (value_code    IS NOT NULL)::int = 1
  );

ALTER TABLE observation_result
  ADD CONSTRAINT observation_result_unit_required CHECK (
    value_numeric IS NULL OR unit IS NOT NULL
  );

-- Pending-results worklist. The textbook case for a partial index: rows LEAVE
-- the index when they complete, so it stays tiny and permanently cached.
CREATE INDEX service_order_item_pending
  ON service_order_item (service_order_id, created_at) WHERE completed_at IS NULL;

CREATE INDEX service_order_pending_by_site
  ON service_order (site_id, requested_at) WHERE pending_items > 0;

-- Keeps `pending_items` in sync so the partial index above is possible at all
-- (index predicates cannot contain subqueries).
CREATE OR REPLACE FUNCTION sync_service_order_pending()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_order uuid;
BEGIN
  v_order := CASE TG_OP WHEN 'DELETE' THEN OLD.service_order_id ELSE NEW.service_order_id END;

  UPDATE service_order
     SET pending_items = (
       SELECT count(*) FROM service_order_item
        WHERE service_order_id = v_order AND completed_at IS NULL
     )
   WHERE id = v_order;

  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_service_order_item_pending
  AFTER INSERT OR UPDATE OF completed_at OR DELETE ON service_order_item
  FOR EACH ROW EXECUTE FUNCTION sync_service_order_pending();

-- ===========================================================================
-- 7. CERTIFICATES AND REFERRALS
-- ===========================================================================

ALTER TABLE medical_certificate
  ADD CONSTRAINT medical_certificate_rest_range CHECK (
    (type <> 'MEDICAL_REST' AND rest_from IS NULL AND rest_to IS NULL)
    OR (type = 'MEDICAL_REST' AND rest_from IS NOT NULL AND rest_to IS NOT NULL
        AND rest_to >= rest_from)
  );

-- A counter-referral answers something; a referral does not.
ALTER TABLE referral
  ADD CONSTRAINT referral_thread_coherence CHECK (
    (direction = 'COUNTER_REFERRAL') = (responds_to_id IS NOT NULL)
  );

-- ===========================================================================
-- 8. AUDIT — BRIN on an append-only table
-- ===========================================================================

-- Perfect physical correlation between insertion order and occurred_at, so a
-- BRIN gives nearly B-tree performance for a fraction of the size.
CREATE INDEX access_audit_occurred_brin
  ON access_audit USING brin (occurred_at) WITH (pages_per_range = 64);
