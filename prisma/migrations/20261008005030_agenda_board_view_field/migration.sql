-- ═══════════════════════════════════════════════════════════════════════════
-- AG-138 (E9). Which columns of the day board each role sees.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Nursing and doctors differ, measurably, in what they find useful on a
-- board: there is no single good view, and serving the union of both is how
-- neither gets read. Which fields EXIST is code (`board-fields.ts`); which
-- role sees which is configuration, edited from Administración → Roles.
--
-- CLOSED BY DEFAULT: a role without rows sees only the fixed columns (time,
-- patient, state, emergency). A caller holding two roles at a site sees the
-- union.
--
-- A new table, nothing rewritten.
CREATE TABLE "board_view_field" (
  "role_id"       UUID        NOT NULL,
  -- The closed union, also enforced here so a field the code does not know
  -- cannot be configured by hand and silently ignored.
  "field"         VARCHAR(32) NOT NULL,
  -- The application's clock, written by the application.
  "created_at"    TIMESTAMPTZ(6) NOT NULL,
  -- NULL only for the starting views this migration and the seed write.
  "created_by_id" UUID,

  CONSTRAINT "board_view_field_pkey" PRIMARY KEY ("role_id", "field"),
  -- Configuration that belongs to the role and to nothing else: it goes with
  -- it. A role that has ever been granted is never deleted (it is
  -- deactivated), so in practice this cascades only for an unused role.
  CONSTRAINT "board_view_field_role_fk"
    FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "board_view_field_created_by_fk"
    FOREIGN KEY ("created_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "board_view_field_known_field" CHECK (
    "field" IN ('PRACTITIONER', 'ROOM', 'TIME_IN_STATE', 'LATENESS', 'BOARD_NOTE')
  )
);

-- The starting views, on the system roles that already exist (an installed
-- clinic). A fresh database has no roles yet when this runs: the
-- authorisation sync writes the same views when it creates the role.
-- `clock_timestamp()` only because there is no application here; nothing
-- compares this instant with one the application writes.
INSERT INTO "board_view_field" ("role_id", "field", "created_at")
SELECT r."id", v."field", clock_timestamp()
FROM "role" r
JOIN (VALUES
  ('RECEPCION',  'PRACTITIONER'),
  ('RECEPCION',  'ROOM'),
  ('RECEPCION',  'TIME_IN_STATE'),
  ('RECEPCION',  'LATENESS'),
  ('RECEPCION',  'BOARD_NOTE'),
  ('ENFERMERIA', 'ROOM'),
  ('ENFERMERIA', 'TIME_IN_STATE'),
  ('ENFERMERIA', 'BOARD_NOTE'),
  ('MEDICO',     'ROOM'),
  ('MEDICO',     'TIME_IN_STATE'),
  ('MEDICO',     'LATENESS'),
  ('MEDICO',     'BOARD_NOTE')
) AS v("role_code", "field") ON v."role_code" = r."code"
WHERE r."is_system"
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- AG-176. Who wrote the board note, and when.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `board_note` is outside the `WHEN` of `trg_agenda_entry_record_version` on
-- purpose: writing a sticky note is not editing the appointment, and stamping
-- `edited_by_id` for it would make every annotated appointment read «editada».
-- So the note carries its own stamp — the last writer, also when the write
-- cleared it. No history of earlier notes: it is free text at sight of the
-- whole staff, and keeping every version of it is keeping more than the board
-- needs (LOPDP, minimisation).
ALTER TABLE "agenda_entry"
  ADD COLUMN "board_note_by_id" UUID,
  ADD COLUMN "board_note_at" TIMESTAMPTZ(6);

ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_board_note_by_fk"
  FOREIGN KEY ("board_note_by_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- The writer and the instant go together; a note with no writer is one that
-- existed before this stamp (none, today) or was never written.
ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_board_note_stamped" CHECK (
    ("board_note_by_id" IS NULL) = ("board_note_at" IS NULL)
  );
