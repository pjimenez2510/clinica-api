-- ═══════════════════════════════════════════════════════════════════════════
-- AG-129, AG-175 (E8). The notice of an arrival called an emergency.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Ley 77 art. 8 obliges receiving a patient in an emergency IMMEDIATELY, and
-- art. 12 forbids denying them care. AG-129 makes the call have an effect: a
-- notice to whoever will receive the patient, and a record of it with its
-- recipient and instant. «Se avisó» without a recipient and an hour proves
-- nothing; with them, the row answers who was told and when — and
-- `acknowledged_at` whether it reached them.
--
-- ONE ROW PER RECIPIENT, written in the same transaction as the call (the
-- arrival or its correction to «sí»): without the row there is no notice, and
-- without the notice there is no row. Who receives it is D-170.1; until the
-- clinic decides, the practitioner of the appointment.
--
-- A new table, nothing rewritten: no backfill.
CREATE TABLE "agenda_emergency_alert" (
  "id" UUID NOT NULL DEFAULT uuidv7(),

  "agenda_entry_id" UUID NOT NULL,
  "site_id"         UUID NOT NULL,
  "recipient_id"    UUID NOT NULL,
  "raised_by_id"    UUID NOT NULL,

  -- The application's clock, never `now()`: the screen compares it.
  "alerted_at"      TIMESTAMPTZ(6) NOT NULL,
  "acknowledged_at" TIMESTAMPTZ(6),

  CONSTRAINT "agenda_emergency_alert_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agenda_emergency_alert_entry_fk"
    FOREIGN KEY ("agenda_entry_id") REFERENCES "agenda_entry"("id") ON DELETE RESTRICT,
  CONSTRAINT "agenda_emergency_alert_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT,
  CONSTRAINT "agenda_emergency_alert_recipient_fk"
    FOREIGN KEY ("recipient_id") REFERENCES "app_user"("id") ON DELETE RESTRICT,
  CONSTRAINT "agenda_emergency_alert_raised_by_fk"
    FOREIGN KEY ("raised_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT,
  -- Nobody acknowledges a notice before it was given.
  CONSTRAINT "agenda_emergency_alert_acknowledged_after_alerted" CHECK (
    "acknowledged_at" IS NULL OR "acknowledged_at" >= "alerted_at"
  )
);

-- What every screen of the recipient asks every few seconds: «¿tengo alguno
-- pendiente?». Partial, so it stays the size of what is pending.
CREATE INDEX "agenda_emergency_alert_pending_by_recipient"
  ON "agenda_emergency_alert" ("recipient_id", "alerted_at")
  WHERE "acknowledged_at" IS NULL;

-- What the appointment's detail reads: whom it notified.
CREATE INDEX "agenda_emergency_alert_by_entry"
  ON "agenda_emergency_alert" ("agenda_entry_id", "alerted_at");

-- APPEND-ONLY BUT FOR THE ACKNOWLEDGEMENT, written once. A notice whose
-- recipient or hour could be rewritten after an incident would answer
-- nothing; one that could be deleted would never have existed.
CREATE OR REPLACE FUNCTION trg_agenda_emergency_alert_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agenda_emergency_alert_is_append_only'
      USING HINT = 'El aviso de emergencia no se borra.';
  END IF;

  IF NEW."agenda_entry_id" IS DISTINCT FROM OLD."agenda_entry_id"
    OR NEW."site_id"       IS DISTINCT FROM OLD."site_id"
    OR NEW."recipient_id"  IS DISTINCT FROM OLD."recipient_id"
    OR NEW."raised_by_id"  IS DISTINCT FROM OLD."raised_by_id"
    OR NEW."alerted_at"    IS DISTINCT FROM OLD."alerted_at"
    OR (OLD."acknowledged_at" IS NOT NULL
        AND NEW."acknowledged_at" IS DISTINCT FROM OLD."acknowledged_at")
  THEN
    RAISE EXCEPTION 'agenda_emergency_alert_is_append_only'
      USING HINT = 'Del aviso de emergencia sólo se registra, una vez, que se vio.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agenda_emergency_alert_immutable ON "agenda_emergency_alert";
CREATE TRIGGER trg_agenda_emergency_alert_immutable
  BEFORE UPDATE OR DELETE ON "agenda_emergency_alert"
  FOR EACH ROW EXECUTE FUNCTION trg_agenda_emergency_alert_is_append_only();
