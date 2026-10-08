-- violence_screening_after_discharge
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Después: pnpm migrations:check && pnpm db:deploy
--
-- D-188 §5 y §7 (aceptadas por el autor el 08-10-2026). Dos garantías del
-- bloque F que hasta hoy daba sólo la aplicación, o ninguna:
--
--   1. La notificación a la autoridad se completa DESPUÉS del alta (EN-242),
--      y sólo ella: el resultado con el que se firmó la 002 no cambia.
--   2. La firma de la 002 que da el alta exige el tamizaje respondido
--      (EN-240), también para quien no pasa por el servicio.
--
-- ⚠️ DATO DE ACCESO RESTRINGIDO (ver `20261008170000_violence_screening_block_f`):
-- ningún mensaje de aquí lleva un valor del tamizaje.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. QUIÉN REGISTRÓ LA NOTIFICACIÓN, Y CUÁNDO (EN-074, EN-242)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Con el alta dada la notificación se registra aparte del tamizaje: quien lo
-- aplicó y cuándo (EN-076) no cambian, y quien copió el formulario 094 —y en
-- qué instante, que es lo que dice si se cumplió el plazo de 24 horas
-- (D-052 §1)— tiene que constar. `RESTRICT` por lo mismo que `screened_by_id`.
ALTER TABLE "violence_screening"
  ADD COLUMN "notified_by_id" UUID,
  ADD COLUMN "notified_at" TIMESTAMPTZ(6);

ALTER TABLE "violence_screening"
  ADD CONSTRAINT "violence_screening_notified_by_id_fkey"
  FOREIGN KEY ("notified_by_id") REFERENCES "practitioner"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- RELLENO. Un tamizaje notificado antes de hoy se notificó al responderlo: su
-- autor y su instante son los del tamizaje. Sin el guardián, que rechazaría
-- escribir en una atención con el alta y archivaría una «corrección» que no
-- ocurrió. En la base del autor (08-10-2026) no hay ningún tamizaje
-- notificado: la entrega anterior se fusionó ese mismo día.
ALTER TABLE "violence_screening" DISABLE TRIGGER "trg_violence_screening_guard";
UPDATE "violence_screening"
   SET "notified_by_id" = "screened_by_id",
       "notified_at" = "screened_at"
 WHERE "reported_to_authority";
ALTER TABLE "violence_screening" ENABLE TRIGGER "trg_violence_screening_guard";

-- Notificado ⇔ con quién y cuándo.
ALTER TABLE "violence_screening"
  ADD CONSTRAINT "violence_screening_notified_who_and_when" CHECK (
    CASE WHEN "reported_to_authority" THEN
      "notified_by_id" IS NOT NULL AND "notified_at" IS NOT NULL
    ELSE
      "notified_by_id" IS NULL AND "notified_at" IS NULL
    END
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. TRAS EL ALTA, SÓLO LA NOTIFICACIÓN (EN-242, EN-130)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La misma función que `20261008170100_violence_screening_history`, con un
-- camino más. Con la atención viva, como antes. Con el alta dada
-- (`DISCHARGED` o `COMPLETED`, como la corrección de signos de D-134.3), sólo
-- el UPDATE que:
--   · deja igual el resultado, los tipos, la acción, el instrumento y quién y
--     cuándo lo aplicó —lo que la firma de la 002 dio por respondido—;
--   · deja el tamizaje notificado —completar no es quitar—, y
--   · sella su propio `notified_at`: cada registro de la notificación dice el
--     suyo.
-- Con la atención interrumpida o anulada, o un INSERT tras el alta (no hay
-- tamizaje con signos que notificar), lo de siempre: congelado.
--
-- La fila reemplazada se archiva ENTERA con quien la reemplazó: quien aplicó
-- el tamizaje si es una corrección del tamizaje, quien registró la
-- notificación si sólo cambió ella.
CREATE OR REPLACE FUNCTION violence_screening_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  encounter_status text;
  v_by uuid;
  v_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'violence_screening_immutable: a screening is corrected, never deleted';
  END IF;

  SELECT e.status::text INTO encounter_status
    FROM encounter e WHERE e.id = NEW.encounter_id;

  IF encounter_status IN ('OPEN', 'ON_HOLD') THEN
    NULL;
  ELSIF encounter_status IN ('DISCHARGED', 'COMPLETED') AND TG_OP = 'UPDATE' THEN
    IF NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
       OR NEW.result IS DISTINCT FROM OLD.result
       OR NEW.types IS DISTINCT FROM OLD.types
       OR NEW.action_taken IS DISTINCT FROM OLD.action_taken
       OR NEW.screening_tool IS DISTINCT FROM OLD.screening_tool
       OR NEW.screened_by_id IS DISTINCT FROM OLD.screened_by_id
       OR NEW.screened_at IS DISTINCT FROM OLD.screened_at
       OR NOT NEW.reported_to_authority
       OR NEW.notified_at IS NOT DISTINCT FROM OLD.notified_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'violence_screening_after_discharge: with the discharge given only the notification to the authority is completed',
        HINT = 'EN-242, D-188 §5.';
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'violence_screening_frozen: the attention no longer accepts new content';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.screened_at IS DISTINCT FROM OLD.screened_at
       OR NEW.notified_at IS NOT DISTINCT FROM OLD.notified_at
       OR NEW.notified_by_id IS NULL THEN
      v_by := NEW.screened_by_id;
      v_at := NEW.screened_at;
    ELSE
      v_by := NEW.notified_by_id;
      v_at := NEW.notified_at;
    END IF;
    INSERT INTO violence_screening_version
      (encounter_id, version, data, replaced_by_id, replaced_at)
    SELECT OLD.encounter_id,
           COALESCE(MAX(v.version), 0) + 1,
           to_jsonb(OLD),
           v_by,
           v_at
      FROM violence_screening_version v
     WHERE v.encounter_id = OLD.encounter_id;
  END IF;

  RETURN NEW;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. LA FIRMA QUE DA EL ALTA EXIGE EL TAMIZAJE RESPONDIDO (EN-240, D-188 §7)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Como `trg_clinical_note_sign_needs_anthropometry` (EN-217): DIFERIDO y sólo
-- cuando la firma da el alta, porque interrumpir también firma la 002 con lo
-- escrito y no da el alta (EN-167). Sin fila es «sin responder»; los cuatro
-- valores —«No se aplicó» incluido— son respuestas.
--
-- No toca datos: sólo mira el paso de borrador a firmada de aquí en adelante.
-- El mensaje no lleva nada del paciente: toda atención tiene uno que responder.
CREATE FUNCTION clinical_note_sign_needs_screening()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF encounter_has_discharge(NEW.encounter_id)
     AND NOT EXISTS (SELECT 1 FROM violence_screening s
                      WHERE s.encounter_id = NEW.encounter_id) THEN
    RAISE EXCEPTION
      'clinical_note_sign_needs_screening: signing the consultation note discharges the attention, and the violence screening is not answered'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-240, EN-070, D-188 §7.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_clinical_note_sign_needs_screening
  AFTER UPDATE OF status ON clinical_note
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.status = 'DRAFT' AND NEW.status = 'SIGNED' AND NEW.form_code = '002')
  EXECUTE FUNCTION clinical_note_sign_needs_screening();
