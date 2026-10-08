-- ═══════════════════════════════════════════════════════════════════════════
-- AG-120, AG-142 (E8). Who let a late appointment into care, and the two
-- site parameters of the late-arrival policy, now edited from the screen.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Nothing here rewrites data: two nullable columns, a CHECK every existing
-- row already satisfies (all NULL), a range CHECK over a column whose stored
-- values are the default 15, and a trigger that only runs on a change.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Who admitted the appointment past the threshold, and when
-- ───────────────────────────────────────────────────────────────────────────
--
-- AG-120: «DEBERÁ registrar quién admitió la cita fuera del umbral». Written
-- by the status route when the caller holds the site's permission, and by
-- the note opening (AG-146), which never refuses (D-170.2). NOT in the
-- history row: AG-141 and the detail read it off the entry, like every other
-- outcome of the arrival.
--
-- ON DELETE RESTRICT, like the overbooking authoriser and the emergency
-- assessor: the trail of who did it is not deleted with the account.
ALTER TABLE "agenda_entry"
  ADD COLUMN "late_admission_by_id" UUID,
  ADD COLUMN "late_admission_at"    TIMESTAMPTZ(6);

ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_late_admission_fk"
    FOREIGN KEY ("late_admission_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_late_admission_names_who_and_when" CHECK (
    ("late_admission_by_id" IS NULL) = ("late_admission_at" IS NULL)
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The late-arrival threshold has an upper bound
-- ───────────────────────────────────────────────────────────────────────────
--
-- `site_parameter_grace_is_not_negative` already refuses a negative. Four
-- hours late is not a late arrival a policy can be about; it is another
-- appointment. Mirrored by `PARAMETER_RANGES.lateArrivalGraceMinutes`.
ALTER TABLE "site_parameter"
  ADD CONSTRAINT "site_parameter_late_arrival_grace_range" CHECK (
    "late_arrival_grace_minutes" BETWEEN 0 AND 240
  );

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The permission that skips the threshold exists in this installation
-- ───────────────────────────────────────────────────────────────────────────
--
-- The same guarantee `trg_site_parameter_overbooking_permission` gives its
-- sister column: a code no route grants protects nothing, and stored here it
-- would mean «nobody may admit a late appointment» with nothing saying so.
CREATE OR REPLACE FUNCTION site_parameter_late_arrival_permission_exists()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permission WHERE code = NEW.late_arrival_override_permission
  ) THEN
    RAISE EXCEPTION
      'late_arrival_override_permission % is not a permission of this installation',
      NEW.late_arrival_override_permission
      USING ERRCODE = 'foreign_key_violation',
            HINT = 'Use a code declared by permission.catalogue.ts and run pnpm db:seed:auth.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_site_parameter_late_arrival_permission ON "site_parameter";
CREATE TRIGGER trg_site_parameter_late_arrival_permission
  BEFORE UPDATE OF late_arrival_override_permission ON site_parameter
  FOR EACH ROW
  WHEN (NEW.late_arrival_override_permission IS DISTINCT FROM OLD.late_arrival_override_permission)
  EXECUTE FUNCTION site_parameter_late_arrival_permission_exists();
