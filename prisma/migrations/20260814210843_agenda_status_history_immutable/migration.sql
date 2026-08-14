-- agenda_status_history_immutable
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- D-022 · THE TRANSITION LOG STOPS BEING A CONVENTION
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS MISSING. The agenda SPEC lists «la inmutabilidad del historial de
-- estados» among the things that are NOT configurable — «es la respuesta a
-- ¿por qué salió anulada esta cita?» — and SC-005 promises that 100 % of the
-- cancelled, rescheduled and no-show appointments keep their whole trail, with
-- author and instant. The schema held neither half of that promise:
--
--   * no immutability trigger, so AG-005 stood only because the module happens
--     to issue nothing but INSERT. One `UPDATE` in `psql` rewrites why an
--     appointment was cancelled, and nothing in the database objects;
--   * `ON DELETE CASCADE` on the foreign key, so deleting ONE appointment
--     erased its ENTIRE history in silence — contradicting at once §5 («una
--     cita no se borra»), that table, and SC-005.
--
-- The second one is the graver: the first needs somebody to lie deliberately,
-- the second destroys the evidence as a SIDE EFFECT of a delete that whoever
-- typed it believed to be about one row.
--
-- ---------------------------------------------------------------------------
-- WHAT THE TRIGGER PROTECTS, AND WHAT IT DELIBERATELY DOES NOT
-- ---------------------------------------------------------------------------
--
-- REFUSED: `UPDATE`, `DELETE` and `TRUNCATE`. The first two are row-level; the
-- third needs its own trigger because TRUNCATE fires no FOR EACH ROW trigger
-- at all — without it the whole trail of every appointment in the clinic goes
-- in one statement, which is the very failure the other two exist to prevent.
--
-- NOT REFUSED, and this is the point of the table: `INSERT`. The log grows,
-- always, and it grows in the same transaction as the transition it describes
-- (AG-004). «Append-only» is not «frozen».
--
-- NOT REFUSED EITHER: a superuser who explicitly disables the trigger, or a
-- session in `session_replication_role = 'replica'`. That is not a hole, it is
-- the same escape hatch `access_audit` has carried since
-- `20260806011045_access_audit_append_only`: it cannot be reached by accident,
-- it requires privileges the application does not have, and it is recorded in
-- the server log. The integration suite uses exactly that door to truncate
-- between tests, and its `SET LOCAL` inside a transaction is what keeps the
-- door from staying open — see `test/integration/setup/database.ts`.
--
-- WHY A TRIGGER AND NOT `REVOKE UPDATE, DELETE`. Same reason as `access_audit`:
-- the table owner keeps its privileges after a REVOKE, and the application
-- connects as the owner. A REVOKE here would be decoration on top of nothing.
--
-- WHY ITS OWN FUNCTION AND NOT `access_audit_insert_only()`. The message names
-- the table, and a shared function would have to say «this table» to stay
-- honest. Whoever hits this error at 11 p.m. reads the message, not the
-- catalog; a name that says `agenda_status_history` sends them to the right
-- SPEC. The two functions are five lines each — sharing them would trade a
-- precise error for no saving worth having.

CREATE OR REPLACE FUNCTION agenda_status_history_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'agenda_status_history is append-only: operation % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'The transition log answers why an appointment was cancelled '
                 'and cannot be altered (AG-005, SC-005). To debug in '
                 'development, disable the trigger explicitly.';
END;
$$;

CREATE TRIGGER trg_agenda_status_history_immutable
  BEFORE UPDATE OR DELETE ON agenda_status_history
  FOR EACH ROW
  EXECUTE FUNCTION agenda_status_history_insert_only();

-- TRUNCATE does not fire FOR EACH ROW triggers: it needs its own.
CREATE TRIGGER trg_agenda_status_history_no_truncate
  BEFORE TRUNCATE ON agenda_status_history
  FOR EACH STATEMENT
  EXECUTE FUNCTION agenda_status_history_insert_only();

-- ---------------------------------------------------------------------------
-- AND THE FOREIGN KEY, WHICH IS THE OTHER HALF OF THE SAME GUARANTEE
-- ---------------------------------------------------------------------------
--
-- `RESTRICT` is the house rule (`.claude/rules/migraciones.md`: in a clinical
-- system nothing is deleted in cascade — it is cancelled, released or marked),
-- and it is what §5 of the SPEC already says out loud. The CASCADE came in with
-- the Prisma-generated `20260806022931_clinical_core`, where it was a default
-- and not a decision.
--
-- WHY BOTH, WHEN THE TRIGGER ALONE ALREADY STOPS THE CASCADE. It does — a
-- cascaded delete runs an ordinary `DELETE` on the child and fires its row
-- triggers, and that was verified against PostgreSQL 18 before writing this
-- line, not assumed. The two are still not redundant, for two reasons:
--
--   * THE ERROR WOULD NAME THE WRONG THING. Whoever deletes an appointment
--     would be told «agenda_status_history is append-only», about a table they
--     never mentioned. `RESTRICT` says what actually happened: this entry has a
--     history hanging off it, and that is why it stays.
--   * THE SCHEMA WOULD KEEP STATING THE OPPOSITE OF THE POLICY. `CASCADE` is an
--     instruction to destroy, left standing and merely overruled by a trigger
--     somewhere else. The day the trigger is disabled on purpose — replica mode
--     is exactly what the integration suite uses — the instruction is still
--     there and is obeyed. A guarantee that reads as its own contradiction in
--     `schema.prisma` is one refactor away from being lost.
--
-- WHY HERE AND NOT REWRITTEN INTO `clinical_core`. The phase allows editing a
-- versioned migration (`scripts/database-phase.mjs`), so this is a choice and
-- not a constraint: the fix and its reasoning are ONE decision, D-022, and half
-- of it hidden inside a 900-line generated file — under a header that explains
-- nothing, next to sixty other foreign keys — is a correction nobody can find
-- when they ask why this key is different from its neighbours. It also keeps
-- the change deployable with `prisma migrate deploy` instead of requiring a
-- full reset of every developer's database.

ALTER TABLE agenda_status_history
  DROP CONSTRAINT agenda_status_history_agenda_entry_id_fkey;

ALTER TABLE agenda_status_history
  ADD CONSTRAINT agenda_status_history_agenda_entry_id_fkey
  FOREIGN KEY (agenda_entry_id) REFERENCES agenda_entry (id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMENT ON TABLE agenda_status_history IS
  'AG-004, AG-005, SC-005. Append-only trail of every status transition of an '
  'appointment. Protected by trigger against UPDATE, DELETE and TRUNCATE, and '
  'by RESTRICT against being carried off by the deletion of its entry.';
