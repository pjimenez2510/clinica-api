-- The clinical date is the date in Ecuador, not the date on the server.
--
-- THE DEFECT, reproduced against PostgreSQL 18 before writing this:
-- `started_at::date` casts a timestamptz using the SESSION time zone. A
-- consultation at 21:00 in Guayaquil is 02:00Z the next day, so the same
-- instant yields two different dates:
--
--   SET TimeZone = 'UTC';               2026-09-14   age = 1 day
--   SET TimeZone = 'America/Guayaquil'; 2026-09-13   age = 00:00:00
--
-- On a newborn that is a whole day of difference in `age_days`, which is the
-- field the RDACAA uses to classify neonates. And the "born after the
-- encounter" guard flips outright: a baby born on the 14th is rejected under
-- one time zone and accepted under the other.
--
-- This is not an edge case. Every Ecuadorian consultation after 19:00 local
-- falls on the following day in UTC, so it covers a real block of the working
-- day — evening clinic hours.
--
-- THE FIX: convert explicitly. `AT TIME ZONE` makes the result independent of
-- whatever the session, the container image or the cloud provider happens to
-- have configured, which is the only way this can be relied upon.
--
-- SCOPE: 'America/Guayaquil' is mainland Ecuador (UTC-5). Galápagos is
-- Pacific/Galapagos (UTC-6). This system serves one clinic, and if it ever
-- opens a site in Galápagos the zone has to become a property of the site
-- rather than a constant. Written here so that decision is visible instead of
-- buried in a cast.

CREATE OR REPLACE FUNCTION encounter_freeze_age()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_birth date;
  v_age   interval;
  v_date  date;
BEGIN
  v_date := (NEW.started_at AT TIME ZONE 'America/Guayaquil')::date;

  SELECT birth_date INTO v_birth FROM patient WHERE id = NEW.patient_id;

  IF v_birth > v_date THEN
    RAISE EXCEPTION 'encounter starts before the patient was born'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_age := age(v_date, v_birth);
  NEW.age_years  := extract(year  from v_age)::int;
  NEW.age_months := extract(month from v_age)::int;
  NEW.age_days   := extract(day   from v_age)::int;
  RETURN NEW;
END;
$$;

-- Same cast, same reason: a diagnosis recorded at 20:00 on the last day a
-- CIE-10 code was in force was being checked against the following day and
-- rejected.
CREATE OR REPLACE FUNCTION diagnosis_concept_in_force()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_ok boolean;
BEGIN
  SELECT cc.valid_period @> (e.started_at AT TIME ZONE 'America/Guayaquil')::date
    INTO v_ok
    FROM encounter e, catalog_concept cc
   WHERE e.id = NEW.encounter_id AND cc.id = NEW.concept_id;

  IF NOT coalesce(v_ok, false) THEN
    -- The concept id is NOT interpolated into the message. Trigger messages
    -- surface through the error mapping, and a value under client control
    -- there let a caller steer which error the API reported back.
    RAISE EXCEPTION 'CIE-10 concept was not in force on the encounter date'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
