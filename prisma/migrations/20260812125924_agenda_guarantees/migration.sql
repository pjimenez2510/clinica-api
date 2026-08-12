-- agenda_guarantees
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- Three agenda guarantees that were being trusted to application code, and
-- therefore were not guarantees at all (D-006, batch 1).
--
-- NOTE ON `agenda_entry_daily_agenda`: nothing here drops or recreates it.
-- Altering `booking_channel` rewrites the table, which rebuilds every index on
-- it automatically and in place — the index is not named in this file and its
-- definition is untouched.

-- ===========================================================================
-- 1. AG-030 — a patient cannot be in two places at once
-- ===========================================================================

-- The third exclusion rule. AG-023 keeps a practitioner from being double
-- booked and AG-024 does the same for a room; neither says anything about the
-- patient, who is one person and cannot be in dermatology and traumatology at
-- eleven o'clock. Checked in the service it is a read followed by a write:
-- two receptionists both read "the patient is free" and both write.
--
-- The predicate mirrors the other two on purpose:
--   * `blocks_calendar` — overbooking (`false`) is EXEMPT deliberately. It is
--     the documented way to break the rule and it leaves a record per entry,
--     which is the whole point: a patient squeezed in for an urgent second
--     opinion must be possible, visibly, instead of by working around the
--     system.
--   * `released_at IS NULL` — a cancelled or no-show appointment stops
--     occupying the calendar, so it must stop blocking the same patient's
--     rebooking at that hour.
--   * `patient_id IS NOT NULL` — a BLOCK has no patient (AG-021), and NULL is
--     not "the same patient": without this, the constraint would be pointless
--     for blocks and needlessly indexed.
-- Until this migration, two overlapping appointments for one patient were
-- LEGAL, so real data may hold them. `ADD CONSTRAINT ... EXCLUDE` validates
-- existing rows, and its raw failure names the constraint but not the rows.
-- Same policy as the booking_channel block below: diagnose first, with ids
-- and never with names, and say what to do — instead of aborting a deploy
-- with an error that gives no remedy.
DO $$
DECLARE
  v_conflicts text;
BEGIN
  SELECT string_agg(format('%s <-> %s', a.id, b.id), E'\n' ORDER BY a.id)
    INTO v_conflicts
    FROM agenda_entry a
    JOIN agenda_entry b
      ON a.patient_id = b.patient_id
     AND a.id < b.id
     AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')
   WHERE a.released_at IS NULL AND a.blocks_calendar AND a.patient_id IS NOT NULL
     AND b.released_at IS NULL AND b.blocks_calendar AND b.patient_id IS NOT NULL;

  IF v_conflicts IS NOT NULL THEN
    RAISE EXCEPTION
      'agenda_entry holds overlapping appointments for the same patient (entry id pairs):%', E'\n' || v_conflicts
      USING HINT = 'Release or cancel one entry of each pair (set released_at, or cancel it) and run this migration again. Do not delete rows: the status history is the audit trail.';
  END IF;
END;
$$;

ALTER TABLE agenda_entry
  ADD CONSTRAINT agenda_entry_no_patient_overlap
  EXCLUDE USING gist (
    patient_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
  WHERE (released_at IS NULL AND blocks_calendar AND patient_id IS NOT NULL);

-- ===========================================================================
-- 2. AG-046 — BLOCKED is a status only a block can hold
-- ===========================================================================

-- `agenda_entry_patient_coherence` ties `kind` to `patient_id` and nothing tied
-- it to `status`, so the database accepted an APPOINTMENT sitting in BLOCKED —
-- a row no screen and no metric knows how to read.
--
-- WHICH STATUSES A BLOCK MAY HOLD. The spec (§5) says BLOCKED is terminal and
-- only for BLOCK; it does not say a block must be in it. It cannot: `status`
-- defaults to BOOKED, so every block is created there, and removing a block
-- means CANCELLED. The other five statuses all assert something about a
-- PATIENT — confirmed with them, they arrived, they are being seen, they were
-- attended, they did not come — and AG-021 guarantees a block has none. Hence
-- the two directions written literally: BLOCKED implies BLOCK, and a BLOCK
-- lives in BOOKED, BLOCKED or CANCELLED.
--
-- Enumerating the admitted statuses rather than excluding the forbidden ones
-- is deliberate: adding a value to `agenda_status` should force a decision
-- here instead of silently inheriting permission.
ALTER TABLE agenda_entry
  ADD CONSTRAINT agenda_entry_kind_status_coherence CHECK (
    (kind = 'APPOINTMENT' AND status <> 'BLOCKED')
    OR (kind = 'BLOCK' AND status IN ('BOOKED', 'BLOCKED', 'CANCELLED'))
  );

-- ===========================================================================
-- 3. AG-029 / AG-034 — the booking channel is a closed list, and it is required
-- ===========================================================================

-- `booking_channel` was VARCHAR(32), nullable and free: 'telefono', 'Phone' and
-- NULL could all coexist. AG-080 groups the no-show rate BY THIS COLUMN, so the
-- metric came out split into spelling variants — and the tempting fix, a
-- `lower()` somewhere in the report, hides the problem instead of removing it.
CREATE TYPE booking_channel AS ENUM ('PHONE', 'WALK_IN', 'WEB', 'REFERRAL');

-- Existing rows, converted EXPLICITLY. A migration that reaches ALTER COLUMN
-- with unmapped data aborts halfway through a deploy with `invalid input value
-- for enum`, naming a value and no row and no remedy.
--
-- Only unambiguous spellings are translated. Anything else is not guessed: the
-- RAISE below stops the deploy and says exactly which values need a decision,
-- because inventing a channel falsifies the very metric this change exists to
-- make trustworthy.
UPDATE agenda_entry
   SET booking_channel = CASE upper(btrim(booking_channel))
     WHEN 'PHONE'      THEN 'PHONE'
     WHEN 'TELEFONO'   THEN 'PHONE'
     WHEN 'TELÉFONO'   THEN 'PHONE'
     WHEN 'WALK_IN'    THEN 'WALK_IN'
     WHEN 'WALK-IN'    THEN 'WALK_IN'
     WHEN 'WALKIN'     THEN 'WALK_IN'
     WHEN 'VENTANILLA' THEN 'WALK_IN'
     WHEN 'PRESENCIAL' THEN 'WALK_IN'
     WHEN 'WEB'        THEN 'WEB'
     WHEN 'PORTAL'     THEN 'WEB'
     WHEN 'REFERRAL'   THEN 'REFERRAL'
     WHEN 'REFERENCIA' THEN 'REFERRAL'
     WHEN 'REFERIDO'   THEN 'REFERRAL'
     ELSE upper(btrim(booking_channel))
   END
 WHERE booking_channel IS NOT NULL;

-- A block is never booked by anyone, so a channel on one is noise that AG-080
-- would then group by. Discarding it is the only reading of "NULL for
-- kind = BLOCK" that does not abort the deploy over data that means nothing.
UPDATE agenda_entry SET booking_channel = NULL WHERE kind = 'BLOCK';

DO $$
DECLARE
  v_unknown text;
  v_missing bigint;
BEGIN
  SELECT string_agg(DISTINCT quote_literal(booking_channel), ', ')
    INTO v_unknown
    FROM agenda_entry
   WHERE booking_channel IS NOT NULL
     AND booking_channel NOT IN ('PHONE', 'WALK_IN', 'WEB', 'REFERRAL');

  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION
      'agenda_entry.booking_channel holds values that are not one of PHONE, WALK_IN, WEB, REFERRAL: %',
      v_unknown
      USING HINT = 'Map each value to one of the four channels with an UPDATE, then run this migration again. Do not guess: AG-080 reports on this column.';
  END IF;

  -- The coherence CHECK below would fail on these with `check constraint
  -- violated`, which names the constraint and not the problem. An appointment
  -- with no channel cannot be repaired by this migration either: nobody knows
  -- today how it was booked, and picking one would be inventing the data.
  SELECT count(*) INTO v_missing
    FROM agenda_entry
   WHERE kind = 'APPOINTMENT' AND booking_channel IS NULL;

  IF v_missing > 0 THEN
    RAISE EXCEPTION
      '% appointment(s) have no booking channel and AG-029 now requires one', v_missing
      USING HINT = 'Set booking_channel on those rows (PHONE, WALK_IN, WEB or REFERRAL) before migrating. No default is applied on purpose: a guessed channel corrupts the no-show metric of AG-080.';
  END IF;
END;
$$;

ALTER TABLE agenda_entry
  ALTER COLUMN booking_channel TYPE booking_channel
  USING booking_channel::booking_channel;

-- Required for an appointment, forbidden on a block — a CHECK and not NOT NULL,
-- because the column is legitimately empty on every block. Same shape as
-- `agenda_entry_patient_coherence`, and for the same reason: the two halves are
-- one rule about what `kind` means.
ALTER TABLE agenda_entry
  ADD CONSTRAINT agenda_entry_booking_channel_coherence CHECK (
    (kind = 'APPOINTMENT' AND booking_channel IS NOT NULL)
    OR (kind = 'BLOCK' AND booking_channel IS NULL)
  );
