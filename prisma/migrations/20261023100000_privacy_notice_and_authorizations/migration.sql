-- privacy_notice_and_authorizations
--
-- D-221 (resolved by the author on 10-10-2026, to be confirmed with the legal
-- adviser). Attending a patient needs no consent (LOPDP art. 31.1), so:
--
--   1. PD-001..PD-006 · the consent text becomes the PRIVACY NOTICE: same
--      rows, same guarantees, another name (`privacy_notice_version`).
--   2. PD-010..PD-017, PD-044, PD-045 retired · `patient_consent` goes, with
--      its triggers and its two enums. There is no production: no consent of
--      a real person to keep (in an installation it would be archived).
--   3. PD-068..PD-075 · the OPTIONAL AUTHORIZATIONS for what is not attending
--      (reminders, marketing, photos, research, third parties): insert-only,
--      one standing per chart, purpose and channel, revoked by a row of its
--      own — the shape of `procedure_consent` / `procedure_consent_revocation`.
--   4. The permission `patient:consent-text` becomes `privacy:notice`, with
--      the roles that held it.
--
-- TO UNDO: drop the two new tables, their enums and functions; rename the
-- table, its constraints and triggers back; recreate `patient_consent` from
-- 20261001034254 and 20261006084539; and move the permission back.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. consent_text_version → privacy_notice_version (PD-001..PD-006)
-- ═══════════════════════════════════════════════════════════════════════════

-- `patient_consent` references it: it goes first.
DROP TABLE "patient_consent";
DROP FUNCTION patient_consent_correction_matches();
DROP TYPE "consent_medium";
DROP TYPE "data_subject_party";

ALTER TABLE "consent_text_version" RENAME TO "privacy_notice_version";
ALTER TABLE "privacy_notice_version"
  RENAME CONSTRAINT "consent_text_version_pkey" TO "privacy_notice_version_pkey";
ALTER TABLE "privacy_notice_version"
  RENAME CONSTRAINT "consent_text_version_number_unique" TO "privacy_notice_version_number_unique";
ALTER TABLE "privacy_notice_version"
  RENAME CONSTRAINT "consent_text_version_number_positive" TO "privacy_notice_version_number_positive";
ALTER TABLE "privacy_notice_version"
  RENAME CONSTRAINT "consent_text_version_body_valid" TO "privacy_notice_version_body_valid";
ALTER TABLE "privacy_notice_version"
  RENAME CONSTRAINT "consent_text_version_published_by_fkey" TO "privacy_notice_version_published_by_fkey";

DROP TRIGGER trg_consent_text_version_is_next ON "privacy_notice_version";
DROP FUNCTION consent_text_version_is_next();

-- PD-001. CORRELATIVE: the new version is exactly the next one. Two
-- simultaneous inserts compute the same number and
-- `privacy_notice_version_number_unique` lets only one through (PD-005).
CREATE FUNCTION privacy_notice_version_is_next()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  expected INTEGER;
BEGIN
  SELECT COALESCE(max("version"), 0) + 1 INTO expected FROM "privacy_notice_version";
  IF NEW."version" <> expected THEN
    RAISE EXCEPTION 'privacy_notice_version_is_next: version must be % and not %', expected, NEW."version"
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'privacy_notice_version_is_next';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_privacy_notice_version_is_next
  BEFORE INSERT ON "privacy_notice_version"
  FOR EACH ROW
  EXECUTE FUNCTION privacy_notice_version_is_next();

ALTER TRIGGER trg_consent_text_version_immutable ON "privacy_notice_version"
  RENAME TO trg_privacy_notice_version_immutable;
ALTER TRIGGER trg_consent_text_version_no_truncate ON "privacy_notice_version"
  RENAME TO trg_privacy_notice_version_no_truncate;

-- The hint named the consent; it names what is still append-only.
CREATE OR REPLACE FUNCTION privacy_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: operation % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Un aviso publicado, una autorización o su revocación son prueba: se registra uno nuevo, no se reescribe.';
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. patient_authorization (PD-068..PD-075)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE "authorization_purpose" AS ENUM (
  'REMINDERS', 'MARKETING', 'PHOTOS', 'RESEARCH', 'THIRD_PARTY_SHARING'
);
CREATE TYPE "authorization_channel" AS ENUM ('WHATSAPP', 'EMAIL');

CREATE TABLE "patient_authorization" (
  "id"          UUID NOT NULL DEFAULT uuidv7(),
  "patient_id"  UUID NOT NULL,
  "purpose"     "authorization_purpose" NOT NULL,
  "channel"     "authorization_channel",
  -- The application's clock (PD-069), never `now()`: the walks move it.
  "recorded_at" TIMESTAMPTZ(6) NOT NULL,
  "recorded_by" UUID NOT NULL,

  CONSTRAINT "patient_authorization_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "patient_authorization_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "patient"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "patient_authorization_recorded_by_fkey"
    FOREIGN KEY ("recorded_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- PD-070. Reminders and marketing go by a channel; the rest have none.
  CONSTRAINT "patient_authorization_channel_matches_purpose" CHECK (
    ("purpose" IN ('REMINDERS', 'MARKETING')) = ("channel" IS NOT NULL)
  )
);

CREATE INDEX "patient_authorization_by_patient"
  ON "patient_authorization" ("patient_id", "recorded_at" DESC);

CREATE TABLE "patient_authorization_revocation" (
  -- One per authorization: the key IS the authorization (PD-072).
  "authorization_id" UUID NOT NULL,
  "revoked_at"       TIMESTAMPTZ(6) NOT NULL,
  "revoked_by"       UUID NOT NULL,

  CONSTRAINT "patient_authorization_revocation_pkey" PRIMARY KEY ("authorization_id"),
  CONSTRAINT "patient_authorization_revocation_authorization_id_fkey"
    FOREIGN KEY ("authorization_id") REFERENCES "patient_authorization"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "patient_authorization_revocation_revoked_by_fkey"
    FOREIGN KEY ("revoked_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

-- PD-071. ONE STANDING per chart, purpose and channel. Not a partial unique
-- index: «standing» is «no row in the other table». The inserts of one chart
-- are ordered by a transaction-scoped advisory lock, and each statement of a
-- VOLATILE function takes a fresh snapshot, so the second of two simultaneous
-- grants sees the first once it holds the lock.
CREATE FUNCTION patient_authorization_one_standing()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('patient_authorization:' || NEW."patient_id"::text, 0));
  IF EXISTS (
    SELECT 1
      FROM "patient_authorization" a
     WHERE a."patient_id" = NEW."patient_id"
       AND a."purpose" = NEW."purpose"
       AND a."channel" IS NOT DISTINCT FROM NEW."channel"
       AND NOT EXISTS (
         SELECT 1 FROM "patient_authorization_revocation" r
          WHERE r."authorization_id" = a."id"
       )
  ) THEN
    RAISE EXCEPTION 'patient_authorization_one_standing: the chart already has this authorization standing'
      USING ERRCODE = 'unique_violation',
            CONSTRAINT = 'patient_authorization_one_standing',
            HINT = 'PD-071. Se revoca la vigente antes de volver a autorizar.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_patient_authorization_one_standing
  BEFORE INSERT ON "patient_authorization"
  FOR EACH ROW
  EXECUTE FUNCTION patient_authorization_one_standing();

-- PD-072. Neither the authorization nor its revocation is ever rewritten.
CREATE TRIGGER trg_patient_authorization_immutable
  BEFORE UPDATE OR DELETE ON "patient_authorization"
  FOR EACH ROW EXECUTE FUNCTION privacy_insert_only();
CREATE TRIGGER trg_patient_authorization_no_truncate
  BEFORE TRUNCATE ON "patient_authorization"
  FOR EACH STATEMENT EXECUTE FUNCTION privacy_insert_only();
CREATE TRIGGER trg_patient_authorization_revocation_immutable
  BEFORE UPDATE OR DELETE ON "patient_authorization_revocation"
  FOR EACH ROW EXECUTE FUNCTION privacy_insert_only();
CREATE TRIGGER trg_patient_authorization_revocation_no_truncate
  BEFORE TRUNCATE ON "patient_authorization_revocation"
  FOR EACH STATEMENT EXECUTE FUNCTION privacy_insert_only();


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. patient:consent-text → privacy:notice
-- ═══════════════════════════════════════════════════════════════════════════

-- The catalogue in code is the source (`permission.catalogue.ts`); the seed
-- would add the new code and leave the old one granted. Moved here so a base
-- keeps who could publish.
INSERT INTO "permission" ("code", "resource", "description")
SELECT 'privacy:notice', 'patient', 'Publicar versiones nuevas del aviso de privacidad'
 WHERE EXISTS (SELECT 1 FROM "permission" WHERE "code" = 'patient:consent-text');

UPDATE "role_permission"
   SET "permission_code" = 'privacy:notice'
 WHERE "permission_code" = 'patient:consent-text';

DELETE FROM "permission" WHERE "code" = 'patient:consent-text';
