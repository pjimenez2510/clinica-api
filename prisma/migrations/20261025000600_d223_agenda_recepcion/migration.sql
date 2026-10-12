-- d223_agenda_recepcion
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Dos garantías de D-223 (feat/d223-agenda-recepcion):
--   1. AG-173 (D-170 §5): la cita de otro día que llega en emergencia se mueve
--      a hoy SIN ocupar calendario y SIN ser un sobrecupo.
--   2. AG-185 (D-176 §3b): la nota del tablero no se archiva en las versiones
--      de la cita, tampoco en las ya archivadas.
--
-- TODO EN UNA TRANSACCIÓN EXPLÍCITA: Prisma no envuelve la migración, y entre
-- el `DISABLE` y el `ENABLE` del disparador de sólo inserción de
-- `record_version` no puede quedar nada a medias (fix/receta-migracion-relleno).

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. AG-173. La cita movida por una llegada en emergencia
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hasta hoy, una cita sin calendario (`blocks_calendar = false`) era SIEMPRE un
-- sobrecupo, y `agenda_entry_overbooking_coherence` le exigía autorizador. La
-- emergencia que llega el día que no es el de su cita se mueve al minuto de la
-- llegada aunque el profesional tenga a otro paciente a esa hora (Ley 77, art.
-- 8): ocupando calendario la rechazaría el `EXCLUDE` justo entonces, y como
-- sobrecupo necesitaría una autorización que recepción no puede dar.
--
-- `emergency_moved_at` es la segunda y única otra razón de no ocupar
-- calendario: el instante en que se movió. Quién la movió es el sello de
-- edición de esa misma escritura (`edited_by_id`), y lo anterior queda en
-- `record_version`. Una corrección posterior de la calificación a «no»
-- (AG-132) no la toca: la cita se movió porque así se calificó.
ALTER TABLE "agenda_entry"
  ADD COLUMN IF NOT EXISTS "emergency_moved_at" TIMESTAMPTZ(6);

COMMENT ON COLUMN "agenda_entry"."emergency_moved_at" IS
  'AG-173 (D-170 §5): instante en que una llegada calificada como emergencia movio a hoy la cita de otro dia; sin calendario y sin sobrecupo.';

ALTER TABLE "agenda_entry"
  DROP CONSTRAINT IF EXISTS "agenda_entry_overbooking_coherence";
ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_overbooking_coherence" CHECK (
    CASE
      WHEN blocks_calendar
        THEN overbooking_authorised_by_id IS NULL
         AND overbooking_reason IS NULL
         AND emergency_moved_at IS NULL
      WHEN emergency_moved_at IS NOT NULL
        THEN overbooking_authorised_by_id IS NULL
         AND overbooking_reason IS NULL
      ELSE overbooking_authorised_by_id IS NOT NULL
       AND (overbooking_reason IS NULL OR btrim(overbooking_reason) <> '')
    END
  );

-- Mover la cita a hoy archiva su versión como cualquier otra edición (AG-051):
-- `starts_at`, `ends_at` y `blocks_calendar` ya están en el `WHEN` del
-- disparador, así que no hace falta añadir la columna nueva.

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. AG-185. La nota del tablero, fuera de las versiones
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `record_version_archive` guarda `to_jsonb(OLD)` entero, y la nota del tablero
-- es texto libre que nadie pidió conservar: cada edición de la cita la dejaba
-- en `record_version` para siempre. La función admite ahora, después de sus
-- tres argumentos de siempre, columnas que NO se archivan. Las tablas que la
-- llaman con tres siguen igual.
CREATE OR REPLACE FUNCTION record_version_archive()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_row   JSONB := to_jsonb(OLD);
  new_row   JSONB := to_jsonb(NEW);
  by_col    TEXT  := TG_ARGV[0];
  at_col    TEXT  := TG_ARGV[1];
  id_col    TEXT  := TG_ARGV[2];
  archived  JSONB;
  next_version INTEGER;
BEGIN
  IF new_row ->> by_col IS NULL
     OR new_row ->> at_col IS NULL
     OR (new_row -> at_col) IS NOT DISTINCT FROM (old_row -> at_col) THEN
    -- The name goes FIRST in the message: it is how `database-problem.ts`
    -- reads which rule a trigger raised (the adapter drops `CONSTRAINT`).
    RAISE EXCEPTION 'record_version_change_is_stamped: % must be edited with a new stamp in % and %',
      TG_TABLE_NAME, by_col, at_col
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'record_version_change_is_stamped',
            HINT = 'Toda edición dice quién y cuándo; la versión anterior se guarda sola.';
  END IF;

  -- AG-185: TG_ARGV[3..] are columns the version must not keep.
  archived := old_row;
  IF TG_NARGS > 3 THEN
    FOR i IN 3 .. TG_NARGS - 1 LOOP
      archived := archived - TG_ARGV[i];
    END LOOP;
  END IF;

  SELECT coalesce(max("version"), 0) + 1
    INTO next_version
    FROM "record_version"
   WHERE "resource_type" = TG_TABLE_NAME
     AND "resource_id" = (old_row ->> id_col)::uuid;

  INSERT INTO "record_version"
    ("resource_type", "resource_id", "version", "data", "changed_by", "changed_at")
  VALUES (
    TG_TABLE_NAME,
    (old_row ->> id_col)::uuid,
    next_version,
    archived,
    (new_row ->> by_col)::uuid,
    (new_row ->> at_col)::timestamptz
  );

  RETURN NEW;
END;
$$;

-- El mismo `WHEN` que dejó `20261022000000_service_catalogue`; cambia sólo la
-- lista de columnas que no se archivan. El sello de la nota (`board_note_by_id`,
-- `board_note_at`) sí se archiva: dice que hubo nota, no qué decía.
DROP TRIGGER IF EXISTS "trg_agenda_entry_record_version" ON "agenda_entry";
CREATE TRIGGER "trg_agenda_entry_record_version"
  BEFORE UPDATE ON "agenda_entry"
  FOR EACH ROW
  WHEN (
       OLD."starts_at" IS DISTINCT FROM NEW."starts_at"
    OR OLD."ends_at" IS DISTINCT FROM NEW."ends_at"
    OR OLD."practitioner_id" IS DISTINCT FROM NEW."practitioner_id"
    OR OLD."room_id" IS DISTINCT FROM NEW."room_id"
    OR OLD."service_id" IS DISTINCT FROM NEW."service_id"
    OR OLD."reason" IS DISTINCT FROM NEW."reason"
    OR OLD."booking_channel" IS DISTINCT FROM NEW."booking_channel"
    OR OLD."patient_id" IS DISTINCT FROM NEW."patient_id"
    OR OLD."blocks_calendar" IS DISTINCT FROM NEW."blocks_calendar"
    OR OLD."overbooking_authorised_by_id" IS DISTINCT FROM NEW."overbooking_authorised_by_id"
    OR OLD."overbooking_reason" IS DISTINCT FROM NEW."overbooking_reason"
    OR (OLD."emergency_assessed_at" IS NOT NULL AND (
          OLD."emergency_assessed_at" IS DISTINCT FROM NEW."emergency_assessed_at"
       OR OLD."emergency_assessed_by_id" IS DISTINCT FROM NEW."emergency_assessed_by_id"
       OR OLD."emergency_flagged_at" IS DISTINCT FROM NEW."emergency_flagged_at"
       OR OLD."emergency_flagged_by_id" IS DISTINCT FROM NEW."emergency_flagged_by_id"
       OR OLD."emergency_note" IS DISTINCT FROM NEW."emergency_note"))
  )
  EXECUTE FUNCTION record_version_archive('edited_by_id', 'edited_at', 'id', 'board_note');

-- Las versiones ya archivadas pierden la nota. `record_version` es de sólo
-- inserción y su disparador se apaga sólo para esta sentencia, dentro de la
-- transacción de la migración: lo que se quita es exactamente la clave
-- `board_note` de las versiones de `agenda_entry`, nada más.
ALTER TABLE "record_version" DISABLE TRIGGER "trg_record_version_insert_only";
UPDATE "record_version"
   SET "data" = "data" - 'board_note'
 WHERE "resource_type" = 'agenda_entry'
   AND "data" ? 'board_note';
ALTER TABLE "record_version" ENABLE TRIGGER "trg_record_version_insert_only";

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. AG-183 (revisión clínica, G1). Por qué se avisó a cada destinatario
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Desde D-170 §1 se avisa al profesional de la cita y a quien tiene horario en
-- la sede en ese instante. El profesional de la cita puede no estar en la sede
-- (otra sede, vacaciones): su «Enterado» no es el traspaso en persona que pide
-- el art. 8, y no debe apagar la marca del tablero (AG-183). `on_duty` dice, al
-- escribir el aviso, si el destinatario tenía horario en la sede en ese
-- instante; como el resto del aviso, no se reescribe.
ALTER TABLE "agenda_emergency_alert"
  ADD COLUMN IF NOT EXISTS "on_duty" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "agenda_emergency_alert"."on_duty" IS
  'AG-129, AG-183: el destinatario tenia horario en la sede al escribirse el aviso; solo su Enterado quita la marca de avisar en persona.';

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
    OR NEW."on_duty"       IS DISTINCT FROM OLD."on_duty"
    OR (OLD."acknowledged_at" IS NOT NULL
        AND NEW."acknowledged_at" IS DISTINCT FROM OLD."acknowledged_at")
  THEN
    RAISE EXCEPTION 'agenda_emergency_alert_is_append_only'
      USING HINT = 'Del aviso de emergencia sólo se registra, una vez, que se vio.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
