-- encounter_annulment_and_interruption
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Garantiza tres cosas de la atención que hasta hoy eran «Falta esquema»
-- (D-076, D-077, D-080, D-081, D-082):
--
--   EN-166  una atención ANULADA (`ENTERED_IN_ERROR`) dice por qué, quién y
--           cuándo. Sin esto la nota abierta al paciente equivocado se
--           arreglaba borrando, o no se arreglaba.
--   EN-167  una atención INTERRUMPIDA (`DISCONTINUED`) dice por qué, quién,
--           cuándo y si la interrupción vino del paciente o del
--           establecimiento: «¿cuántas consultas perdimos por cortes de luz?»
--           no se puede contestar sin el origen.
--   EN-168  una cita tiene como mucho UNA atención viva. Hasta hoy tenía una
--           para siempre (`encounter_agenda_entry_id_key`), así que anulada la
--           atención de Carlos no se le podía abrir la buena sobre su cita.
--
-- Después: pnpm migrations:check && pnpm db:deploy

-- ===========================================================================
-- 1. El origen de una interrupción
-- ===========================================================================

-- Dos valores y no un texto libre: es la diferencia entre un hecho clínico
-- (el paciente se fue) y un fallo operativo (el médico salió a una urgencia,
-- se fue la luz), y se cuenta por separado (EN-129).
CREATE TYPE "encounter_discontinued_origin" AS ENUM ('PATIENT', 'ESTABLISHMENT');

-- ===========================================================================
-- 2. Las columnas
-- ===========================================================================

-- El autor es `app_user` y no `practitioner`, a diferencia de `closed_by_id`:
-- la salida de un paciente con la atención abierta y sin nota la registra
-- recepción (AG-148), que no es profesional. Quien anula o interrumpe desde
-- la atención sí lo es, y su usuario lo identifica igual.
ALTER TABLE "encounter"
  ADD COLUMN "entered_in_error_reason" VARCHAR(500),
  ADD COLUMN "entered_in_error_by_id"  UUID,
  ADD COLUMN "entered_in_error_at"     TIMESTAMPTZ(6),
  ADD COLUMN "discontinued_reason"     VARCHAR(500),
  ADD COLUMN "discontinued_origin"     "encounter_discontinued_origin",
  ADD COLUMN "discontinued_by_id"      UUID,
  ADD COLUMN "discontinued_at"         TIMESTAMPTZ(6);

ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_entered_in_error_by_fk"
    FOREIGN KEY ("entered_in_error_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "encounter_discontinued_by_fk"
    FOREIGN KEY ("discontinued_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT;

-- ===========================================================================
-- 3. Cada estado con su constancia, en las dos direcciones
-- ===========================================================================

-- ¿Puede haber filas que lo incumplan? Ninguna ruta llevaba hasta hoy a
-- `ENTERED_IN_ERROR` ni a `DISCONTINUED`, así que una base con historia no
-- debería tenerlas. Se diagnostica igualmente, con identificadores, antes de
-- que el `ADD CONSTRAINT` falle sin decir cuáles.
DO $$
DECLARE
  v_rows text;
BEGIN
  SELECT string_agg(format('%s (%s)', id, status), E'\n' ORDER BY id)
    INTO v_rows
    FROM encounter
   WHERE status IN ('ENTERED_IN_ERROR', 'DISCONTINUED');

  IF v_rows IS NOT NULL THEN
    RAISE EXCEPTION
      'encounter holds annulled or discontinued rows with no reason or author (encounter ids):%', E'\n' || v_rows
      USING HINT = 'Those rows were written outside the application. Record who annulled or interrupted each one and why, then run this migration again.';
  END IF;
END;
$$;

-- EN-166. Los tres datos o ninguno, y exactamente en `ENTERED_IN_ERROR`. En las
-- dos direcciones: una atención viva con motivo de anulación sería una
-- anulación a medias que nadie sabría leer.
ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_entered_in_error_states_who_why_when" CHECK (
    ("status" = 'ENTERED_IN_ERROR'
      AND "entered_in_error_reason" IS NOT NULL
      AND btrim("entered_in_error_reason") <> ''
      AND "entered_in_error_by_id" IS NOT NULL
      AND "entered_in_error_at" IS NOT NULL)
    OR
    ("status" <> 'ENTERED_IN_ERROR'
      AND "entered_in_error_reason" IS NULL
      AND "entered_in_error_by_id" IS NULL
      AND "entered_in_error_at" IS NULL)
  );

-- EN-167. Lo mismo para la interrupción, con el origen.
ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_discontinued_states_who_why_when" CHECK (
    ("status" = 'DISCONTINUED'
      AND "discontinued_reason" IS NOT NULL
      AND btrim("discontinued_reason") <> ''
      AND "discontinued_origin" IS NOT NULL
      AND "discontinued_by_id" IS NOT NULL
      AND "discontinued_at" IS NOT NULL)
    OR
    ("status" <> 'DISCONTINUED'
      AND "discontinued_reason" IS NULL
      AND "discontinued_origin" IS NULL
      AND "discontinued_by_id" IS NULL
      AND "discontinued_at" IS NULL)
  );

-- ===========================================================================
-- 4. EN-168 — una atención VIVA por cita
-- ===========================================================================

-- El índice único total pasa a parcial. La atención anulada sigue apuntando a
-- su cita —es el rastro de que alguien abrió esa cita por error— y deja de
-- ocupar el hueco. Un `NULL` (atención sin cita, EN-003) no choca con nada en
-- un índice único, como antes.
--
-- `<> 'ENTERED_IN_ERROR'` y no una lista de estados vivos: un estado nuevo en
-- `encounter_status` cuenta como vivo hasta que alguien decida lo contrario,
-- que es el lado seguro —dos atenciones vivas sobre una cita es el defecto,
-- no una cita que temporalmente no admite la segunda—.
DROP INDEX "encounter_agenda_entry_id_key";

CREATE UNIQUE INDEX "encounter_one_live_per_agenda_entry"
  ON "encounter" ("agenda_entry_id")
  WHERE "status" <> 'ENTERED_IN_ERROR';

COMMENT ON INDEX "encounter_one_live_per_agenda_entry" IS
  'EN-168: como mucho una atención viva por cita. La anulada queda atada a su '
  'cita como rastro y deja abrir otra (D-081).';
