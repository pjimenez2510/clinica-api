-- agenda_edit_in_place
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- D-126 Y D-127 EN LA AGENDA (filas AG-1 a AG-13 del inventario)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La cita se corrige donde está y la versión anterior la guarda la base
-- (AG-050, AG-051, AG-162). Hasta hoy reprogramar anulaba la cita y creaba
-- otra, porque una fila cuyo intervalo se sobrescribe no contesta «¿estuvo
-- alguna vez a las 08:00?». Eso lo contesta ahora `record_version` (EN-210).
--
-- LO QUE GARANTIZA:
--   1. Cambiar la hora, el profesional, el tipo, el consultorio, el motivo de
--      consulta, el canal, el paciente o el sobrecupo de una cita, o el motivo
--      de un bloqueo, exige el sello nuevo `edited_by_id`/`edited_at` y
--      archiva la fila anterior en la misma sentencia (AG-051, AG-164).
--   2. Las TRANSICIONES DE ESTADO NO LO NECESITAN. El disparador lleva un
--      `WHEN` sobre las columnas que se editan: llegar, atender o anular
--      escriben ya su fila de `agenda_status_history` (AG-004) y no son una
--      edición. Sin el `WHEN`, cada transición pediría un sello que no tiene.
--   3. La calificación de emergencia ya hecha se corrige con versión, nunca
--      se borra (AG-132, D-128.4). Hacerla por primera vez sigue sin sello:
--      el `WHEN` solo mira las calificaciones que ya existían.
--   4. El último intento de contacto de la lista de espera se edita con
--      versión (AG-064); los anteriores y el origen de cada uno no cambian.
--      Una entrada caducada puede volver a `CONTACTED` (AG-165) y a nada más.
--   5. Retirar una cita registrada por error ya no exige motivo (AG-117), y el
--      sobrecupo exige el autorizador pero no el motivo (AG-035).
--
-- NO SE TOCA NINGUNA FILA GUARDADA. `ADD COLUMN` sin defecto no ejecuta un
-- UPDATE ni dispara disparadores de fila: las citas que existen quedan con el
-- sello vacío, que es la verdad («nadie la ha editado»). Los CHECK que se
-- aflojan admiten todo lo que admitían. Las reprogramaciones antiguas, con
-- `rescheduled_from_id`, se quedan como están.

-- ── 1. El sello de la edición ─────────────────────────────────────────────
ALTER TABLE "agenda_entry"
  ADD COLUMN "edited_by_id" UUID,
  ADD COLUMN "edited_at" TIMESTAMPTZ(6);

ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_edited_by_id_fkey"
  FOREIGN KEY ("edited_by_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_edit_stamped" CHECK (
    ("edited_by_id" IS NULL) = ("edited_at" IS NULL)
  );

-- ── 2. La versión anterior, solo cuando se edita ───────────────────────────
-- «record_version» va después de «emergency_immutable» por orden alfabético
-- de los BEFORE: lo que la regla de la calificación rechaza no archiva nada.
CREATE TRIGGER "trg_agenda_entry_record_version"
  BEFORE UPDATE ON "agenda_entry"
  FOR EACH ROW
  WHEN (
    (OLD."starts_at", OLD."ends_at", OLD."practitioner_id", OLD."room_id",
     OLD."service_type_id", OLD."reason", OLD."booking_channel",
     OLD."patient_id", OLD."blocks_calendar",
     OLD."overbooking_authorised_by_id", OLD."overbooking_reason")
    IS DISTINCT FROM
    (NEW."starts_at", NEW."ends_at", NEW."practitioner_id", NEW."room_id",
     NEW."service_type_id", NEW."reason", NEW."booking_channel",
     NEW."patient_id", NEW."blocks_calendar",
     NEW."overbooking_authorised_by_id", NEW."overbooking_reason")
    OR (
      OLD."emergency_assessed_at" IS NOT NULL
      AND (OLD."emergency_assessed_at", OLD."emergency_assessed_by_id",
           OLD."emergency_flagged_at", OLD."emergency_flagged_by_id",
           OLD."emergency_note")
          IS DISTINCT FROM
          (NEW."emergency_assessed_at", NEW."emergency_assessed_by_id",
           NEW."emergency_flagged_at", NEW."emergency_flagged_by_id",
           NEW."emergency_note")
    )
  )
  EXECUTE FUNCTION record_version_archive('edited_by_id', 'edited_at', 'id');

-- ── 3. AG-132: la calificación se corrige, no se borra ─────────────────────
-- Antes rechazaba todo cambio. Ahora rechaza que se vacíe; que el cambio lleve
-- sello y deje la anterior lo garantiza `trg_agenda_entry_record_version`.
-- El nombre de la función y del disparador se quedan: los lee
-- `agenda.constraints.ts` para traducir el rechazo.
CREATE OR REPLACE FUNCTION trg_agenda_entry_emergency_call_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."emergency_assessed_at" IS NOT NULL AND (
       NEW."emergency_assessed_at"    IS NULL
    OR NEW."emergency_assessed_by_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'agenda_entry_emergency_call_is_immutable'
      USING HINT = 'La calificacion de emergencia del arribo se corrige, no se borra.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 4. AG-117 y AG-035: los motivos que dejan de ser obligatorios ──────────
ALTER TABLE "agenda_entry"
  DROP CONSTRAINT "agenda_entry_entered_in_error_states_a_reason";

ALTER TABLE "agenda_entry"
  DROP CONSTRAINT "agenda_entry_overbooking_coherence";
ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_overbooking_coherence" CHECK (
    CASE WHEN blocks_calendar
      THEN overbooking_authorised_by_id IS NULL
       AND overbooking_reason IS NULL
      ELSE overbooking_authorised_by_id IS NOT NULL
       AND (overbooking_reason IS NULL OR btrim(overbooking_reason) <> '')
    END
  );

-- ── 5. AG-064: el último intento de contacto se edita con versión ──────────
ALTER TABLE "waitlist_contact_attempt"
  ADD COLUMN "edited_by_id" UUID,
  ADD COLUMN "edited_at" TIMESTAMPTZ(6);

ALTER TABLE "waitlist_contact_attempt"
  ADD CONSTRAINT "waitlist_contact_attempt_edited_by_id_fkey"
  FOREIGN KEY ("edited_by_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "waitlist_contact_attempt"
  ADD CONSTRAINT "waitlist_contact_attempt_edit_stamped" CHECK (
    ("edited_by_id" IS NULL) = ("edited_at" IS NULL)
  );

-- Ni DELETE, ni cambiar el origen, ni editar uno que ya superó otro intento.
-- Los mensajes llevan «append-only» y «cannot be modified» a propósito:
-- `database-problem.ts` traduce a 409 los 42501 de nuestros disparadores
-- reconociéndolos por el texto.
CREATE OR REPLACE FUNCTION waitlist_contact_attempt_keeps_its_origin()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'waitlist_contact_attempt is append-only: operation % is forbidden', TG_OP
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Un intento de contacto no se borra: se edita el último, y '
                   'la versión anterior se guarda.';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."waitlist_entry_id" IS DISTINCT FROM OLD."waitlist_entry_id"
     OR NEW."attempted_at" IS DISTINCT FROM OLD."attempted_at"
     OR NEW."recorded_by" IS DISTINCT FROM OLD."recorded_by" THEN
    RAISE EXCEPTION
      'waitlist_contact_attempt cannot be modified in its origin: the entry, who called and when are fixed'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Quien edita queda en edited_by_id.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "waitlist_contact_attempt" later
     WHERE later."waitlist_entry_id" = OLD."waitlist_entry_id"
       AND (later."attempted_at", later."id") > (OLD."attempted_at", OLD."id")
  ) THEN
    RAISE EXCEPTION
      'waitlist_contact_attempt cannot be modified: only the last attempt of an entry is edited'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'AG-064. Un intento que ya superó otro no decide nada.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER "trg_waitlist_contact_attempt_immutable" ON "waitlist_contact_attempt";

-- «keeps_its_origin» va antes que «record_version» (orden alfabético): lo que
-- se rechaza no archiva nada. `trg_waitlist_contact_attempt_no_truncate` y la
-- función `waitlist_contact_attempt_insert_only` se quedan.
CREATE TRIGGER "trg_waitlist_contact_attempt_keeps_its_origin"
  BEFORE UPDATE OR DELETE ON "waitlist_contact_attempt"
  FOR EACH ROW
  EXECUTE FUNCTION waitlist_contact_attempt_keeps_its_origin();

CREATE TRIGGER "trg_waitlist_contact_attempt_record_version"
  BEFORE UPDATE ON "waitlist_contact_attempt"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_archive('edited_by_id', 'edited_at', 'id');

-- ── 6. AG-165: la entrada caducada por error vuelve a `CONTACTED` ──────────
-- Solo esa salida: lo agendado y lo anulado siguen siendo finales (AG-067).
DROP TRIGGER "trg_waitlist_entry_closure_final" ON "waitlist_entry";
CREATE TRIGGER "trg_waitlist_entry_closure_final"
  BEFORE UPDATE ON waitlist_entry
  FOR EACH ROW
  WHEN (
    OLD."status" IN ('SCHEDULED', 'EXPIRED', 'CANCELLED')
    AND (
      NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."converted_entry_id" IS DISTINCT FROM OLD."converted_entry_id"
    )
    AND NOT (
      OLD."status" = 'EXPIRED'
      AND NEW."status" = 'CONTACTED'
      AND NEW."converted_entry_id" IS NOT DISTINCT FROM OLD."converted_entry_id"
    )
  )
  EXECUTE FUNCTION waitlist_entry_closure_is_final();
