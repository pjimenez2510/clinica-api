-- service_order_restore_discarded_draft
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ORD-116 (enmienda ORD-099), D-126 resuelta por el autor el 04-10-2026.
--
-- QUÉ GARANTIZA. Un borrador de orden se descarta de un clic y el error se
-- arregla con «Deshacer». La base admitía DRAFT → ISSUED y DRAFT → DISCARDED
-- y nada más; ahora admite también DISCARDED → DRAFT, y SÓLO eso:
--
--   · ISSUED sigue sin volver a ningún sitio: lo emitido tiene número y está
--     en la mano del paciente.
--   · DISCARDED → ISSUED sigue prohibido: lo descartado se recupera primero.
--   · Al volver, sólo cambian el estado y quién/cuándo se descartó, que
--     `service_order_discard_states_who_and_when` obliga a limpiar. El tipo,
--     la prioridad, la indicación, la atención, el profesional, el instante y
--     el código siguen congelados: deshacer devuelve el borrador TAL CUAL, no
--     es una puerta para reescribirlo sin ser borrador.
--
-- No toca datos: sólo sustituye la función del disparador, que ya existe.

CREATE OR REPLACE FUNCTION service_order_guard_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  restoring CONSTANT BOOLEAN := OLD.status = 'DISCARDED' AND NEW.status = 'DRAFT';
BEGIN
  IF OLD.status <> 'DRAFT' AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT restoring THEN
    RAISE EXCEPTION
      'service_order_status_transition: an order goes from DRAFT to ISSUED or DISCARDED, and from DISCARDED back to DRAFT, and nowhere else'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'ORD-098, ORD-099, ORD-116.';
  END IF;

  IF OLD.status <> 'DRAFT' AND (
       NEW.category IS DISTINCT FROM OLD.category
    OR NEW.priority IS DISTINCT FROM OLD.priority
    OR NEW.clinical_note_text IS DISTINCT FROM OLD.clinical_note_text
    OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
    OR NEW.ordered_by_id IS DISTINCT FROM OLD.ordered_by_id
    -- ORD-116. Restoring clears who and when; nothing else moves them.
    OR (NOT restoring AND (
          NEW.discarded_at IS DISTINCT FROM OLD.discarded_at
       OR NEW.discarded_by_id IS DISTINCT FROM OLD.discarded_by_id))
    -- The issue instant is printed, ages the worklist (ORD-021) and dates the
    -- charge; the code is printed for the laboratory to check (D-095).
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR NEW.verification_code IS DISTINCT FROM OLD.verification_code
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'service_order_frozen_once_issued: an issued or discarded order is not rewritten'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'ORD-096. Corrections to an issued order are made by '
                   'cancelling its lines (ORD-007) and ordering again.';
  END IF;
  RETURN NEW;
END;
$$;
