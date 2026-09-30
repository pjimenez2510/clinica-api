-- ⚠️ ESCRITA PARA PODER REINTENTARSE.
--
-- El primer intento falló a mitad —el `CHECK` de coherencia chocó con filas
-- que ya llevaban `LEFT_WITHOUT_BEING_SEEN` sin instante, porque la interfaz
-- se probó antes que esto— y las columnas quedaron creadas. PostgreSQL no
-- deshace un `ALTER TABLE` ya confirmado por que falle el siguiente, así que
-- una migración que sólo funciona sobre una base virgen deja el árbol atascado.
--
-- De ahí los `IF NOT EXISTS` y los `DROP CONSTRAINT IF EXISTS`: no son
-- descuido, son lo que permite corregir el SQL y volver a aplicarlo sin
-- destruir la base — que es el bucle que esta fase del proyecto usa.

-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT E8 AND E9 STILL LACKED, EACH FOR A STATED REASON
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The two new outcomes get their own instant and their own reason
-- ───────────────────────────────────────────────────────────────────────────
--
-- `agenda_entry` already carries `checked_in_at`, `no_show_at` and
-- `cancelled_at`. The two outcomes added by D-A-009 had neither, so the
-- no-show metric would have had to join against `agenda_status_history` for
-- them and read three columns for their neighbours — one query shaped
-- differently from the other three, for an asymmetry that answers nothing.
ALTER TABLE "agenda_entry"
  ADD COLUMN IF NOT EXISTS "left_without_being_seen_at"     TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "left_without_being_seen_reason" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "entered_in_error_at"            TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "entered_in_error_reason"        VARCHAR(500);

-- BACKFILL BEFORE THE CHECK, because rows already carry these statuses.
--
-- The instant is not invented: `agenda_status_history` is append-only and
-- holds the transition that put the row where it is, so the real moment is
-- recoverable. `updated_at` is the fallback for a row whose history predates
-- the trail — wrong by seconds, never by days, and better than refusing to
-- migrate.
UPDATE "agenda_entry" e
   SET "left_without_being_seen_at" = COALESCE(
         (SELECT MAX(h."changed_at") FROM "agenda_status_history" h
           WHERE h."agenda_entry_id" = e."id"
             AND h."to_status" = 'LEFT_WITHOUT_BEING_SEEN'),
         e."updated_at")
 WHERE e."status" = 'LEFT_WITHOUT_BEING_SEEN'
   AND e."left_without_being_seen_at" IS NULL;

UPDATE "agenda_entry" e
   SET "entered_in_error_at" = COALESCE(
         (SELECT MAX(h."changed_at") FROM "agenda_status_history" h
           WHERE h."agenda_entry_id" = e."id"
             AND h."to_status" = 'ENTERED_IN_ERROR'),
         e."updated_at"),
       "entered_in_error_reason" = COALESCE(
         e."entered_in_error_reason",
         'Registrado antes de que existiera la columna de motivo.')
 WHERE e."status" = 'ENTERED_IN_ERROR'
   AND e."entered_in_error_at" IS NULL;

-- The instant belongs to the state, in both directions.
ALTER TABLE "agenda_entry" DROP CONSTRAINT IF EXISTS "agenda_entry_left_without_being_seen_coherence";
ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_left_without_being_seen_coherence" CHECK (
    ("status" = 'LEFT_WITHOUT_BEING_SEEN') = ("left_without_being_seen_at" IS NOT NULL)
  );

ALTER TABLE "agenda_entry" DROP CONSTRAINT IF EXISTS "agenda_entry_entered_in_error_coherence";
ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_entered_in_error_coherence" CHECK (
    ("status" = 'ENTERED_IN_ERROR') = ("entered_in_error_at" IS NOT NULL)
  );

-- AG-117 demands a reason for a retraction; AG-116 leaves it optional for
-- somebody who walked out — asking a receptionist WHY a patient got tired of
-- waiting produces a blank field or a guess, and neither is worth the friction.
ALTER TABLE "agenda_entry" DROP CONSTRAINT IF EXISTS "agenda_entry_entered_in_error_states_a_reason";
ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_entered_in_error_states_a_reason" CHECK (
    "entered_in_error_at" IS NULL OR "entered_in_error_reason" IS NOT NULL
  );

-- ⚠️ A SEPARATE COLUMN FROM `cancellation_note`, ON PURPOSE. The reason for a
-- retraction is not the reason for a cancellation, and sharing one column
-- would make it impossible to tell from the row WHICH OF THE TWO ACTS
-- happened — which is exactly what these two statuses exist to separate.

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The patient axis needs a history, not a cache of the last value
-- ───────────────────────────────────────────────────────────────────────────
--
-- `subject_status_at` holds ONLY the latest instant: by the third change
-- nobody can answer when the first two happened or what caused them. It is
-- literally the defect `last_contacted_at` had, and which was closed by
-- building `waitlist_contact_attempt`.
--
-- «How long did this person wait» is the question the whole day board exists
-- to answer, and a single column can only answer it for the current leg.
CREATE TABLE IF NOT EXISTS "agenda_subject_status_history" (
  "id" UUID NOT NULL DEFAULT uuidv7(),

  "agenda_entry_id" UUID NOT NULL,

  "from_status" "patient_subject_status",
  "to_status"   "patient_subject_status" NOT NULL,

  /**
   * WHAT CAUSED IT, not who typed it. Only `ARRIVED` is typed; the other five
   * are consequences of documenting something, so the useful column is the
   * fact — «vital signs saved», «note opened» — and the actor is whoever
   * performed that act.
   */
  "caused_by"    VARCHAR(64) NOT NULL,
  "changed_by_id" UUID,

  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agenda_subject_status_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agenda_subject_status_history_entry_fk"
    FOREIGN KEY ("agenda_entry_id") REFERENCES "agenda_entry"("id") ON DELETE RESTRICT,
  CONSTRAINT "agenda_subject_status_history_actor_fk"
    FOREIGN KEY ("changed_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT,
  CONSTRAINT "agenda_subject_status_history_moves" CHECK (
    "from_status" IS NULL OR "from_status" <> "to_status"
  )
);

CREATE INDEX IF NOT EXISTS "agenda_subject_status_history_by_entry"
  ON "agenda_subject_status_history" ("agenda_entry_id", "occurred_at");

-- APPEND-ONLY, in the same shape as `agenda_status_history`. A trail that can
-- be rewritten is not a trail.
CREATE OR REPLACE FUNCTION trg_agenda_subject_status_history_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'agenda_subject_status_history_is_append_only'
    USING HINT = 'El rastro del estado del paciente no se modifica ni se borra.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agenda_subject_status_history_immutable ON "agenda_subject_status_history";
CREATE TRIGGER trg_agenda_subject_status_history_immutable
  BEFORE UPDATE OR DELETE ON "agenda_subject_status_history"
  FOR EACH ROW EXECUTE FUNCTION trg_agenda_subject_status_history_is_append_only();

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The article 10 assessment, once written, does not change
-- ───────────────────────────────────────────────────────────────────────────
--
-- AG-132. A record that can be edited afterwards proves nothing about what
-- happened at the door, and proving what happened at the door is the entire
-- point — art. 13 turns it into 12–18 months of prison.
--
-- ⚠️ NOT A WHOLE-TABLE TRIGGER: the row legitimately changes for everything
-- else (status, subject status, the board note). Only these five columns
-- freeze, and only once written.
CREATE OR REPLACE FUNCTION trg_agenda_entry_emergency_call_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."emergency_assessed_at" IS NOT NULL AND (
       NEW."emergency_assessed_at"    IS DISTINCT FROM OLD."emergency_assessed_at"
    OR NEW."emergency_assessed_by_id" IS DISTINCT FROM OLD."emergency_assessed_by_id"
    OR NEW."emergency_flagged_at"     IS DISTINCT FROM OLD."emergency_flagged_at"
    OR NEW."emergency_flagged_by_id"  IS DISTINCT FROM OLD."emergency_flagged_by_id"
    OR NEW."emergency_note"           IS DISTINCT FROM OLD."emergency_note"
  ) THEN
    RAISE EXCEPTION 'agenda_entry_emergency_call_is_immutable'
      USING HINT = 'La calificacion de emergencia del arribo no se modifica una vez hecha.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agenda_entry_emergency_immutable ON "agenda_entry";
CREATE TRIGGER trg_agenda_entry_emergency_immutable
  BEFORE UPDATE ON "agenda_entry"
  FOR EACH ROW EXECUTE FUNCTION trg_agenda_entry_emergency_call_is_immutable();

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The board's short note
-- ───────────────────────────────────────────────────────────────────────────
--
-- AG-134. What the electronic whiteboard lost when it replaced the marker
-- board: the improvised symbols staff left each other. This is that, back.
--
-- ⚠️ NOT `reason`, and this is the important part. `reason` is where reception
-- writes the MOTIVO DE CONSULTA, and it was deliberately kept out of every
-- read (AG-036, AG-072, AG-074) because it is health data. A board note
-- sharing that column would put a diagnosis back on a screen that faces the
-- waiting room.
ALTER TABLE "agenda_entry"
  ADD COLUMN IF NOT EXISTS "board_note" VARCHAR(120);

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Which permission overrides the late-arrival threshold
-- ───────────────────────────────────────────────────────────────────────────
--
-- AG-120, sister of the column the site already uses to authorise an
-- overbooking. Without it the rule would carry a hardcoded permission, which
-- is what REQ-145 forbids.
--
-- Defaults to the overbooking permission on purpose: letting somebody in past
-- the threshold IS breaking the grid, and a clinic that has already decided
-- who may do one has answered for the other. Any site can point it elsewhere.
ALTER TABLE "site_parameter"
  ADD COLUMN IF NOT EXISTS "late_arrival_override_permission" VARCHAR(64) NOT NULL
    DEFAULT 'agenda:overbook';
