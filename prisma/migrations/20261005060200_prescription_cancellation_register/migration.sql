-- prescription_cancellation_register
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- PR-108 (enmienda PR-010) y PR-109. D-126 y D-128.3, resueltas por el autor
-- el 04-10-2026.
--
-- QUÉ GARANTIZA. Anular una receta EMITIDA deja dicho quién la anuló, cuándo y
-- por qué. Es el «registro de las recetas médicas perdidas» del art. 70 de la
-- Res. ACESS-2023-0030, que hasta hoy no tenía dónde guardarse (la nota
-- «Falta esquema» de PR-010):
--
--   · `prescription_cancel_states_who_when_and_why`: una receta que se anula
--     DESDE AHORA lleva las tres columnas, y el motivo no está en blanco.
--   · `prescription_cancel_columns_only_when_cancelled`: ningún otro estado
--     las lleva. Una receta vigente que dijera quién la anuló diría dos cosas.
--   · `prescription_frozen` deja escribirlas al anular, y en ningún otro
--     momento: una anulación no se reescribe ni se completa después.
--
-- LAS RECETAS ANULADAS ANTES NO SE TOCAN. Se anularon cuando no había dónde
-- guardar el motivo, y no se inventa ninguno: el primer CHECK entra
-- `NOT VALID`, así que PostgreSQL no revisa las filas que ya existen y sí toda
-- fila que se escriba a partir de ahora. Esas filas no se pueden modificar —
-- ya lo impedía `prescription_frozen`, que no deja cambiar nada de una
-- anulada—, así que el CHECK sin validar no las bloquea en nada que hoy se
-- pueda hacer con ellas. El segundo CHECK sí se valida: hoy ninguna fila tiene
-- esas columnas.
--
-- No toca datos.

BEGIN;

ALTER TABLE "prescription"
  ADD COLUMN IF NOT EXISTS "cancelled_at"    TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "cancelled_by_id" UUID,
  ADD COLUMN IF NOT EXISTS "cancel_reason"   VARCHAR(500);

ALTER TABLE "prescription"
  DROP CONSTRAINT IF EXISTS "prescription_cancelled_by_fk";
ALTER TABLE "prescription"
  ADD CONSTRAINT "prescription_cancelled_by_fk"
    FOREIGN KEY ("cancelled_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "prescription"
  DROP CONSTRAINT IF EXISTS "prescription_cancel_states_who_when_and_why";
ALTER TABLE "prescription"
  ADD CONSTRAINT "prescription_cancel_states_who_when_and_why" CHECK (
    ("status" <> 'CANCELLED')
    OR ("cancelled_at" IS NOT NULL
        AND "cancelled_by_id" IS NOT NULL
        AND "cancel_reason" IS NOT NULL
        AND btrim("cancel_reason") <> '')
  ) NOT VALID;

ALTER TABLE "prescription"
  DROP CONSTRAINT IF EXISTS "prescription_cancel_columns_only_when_cancelled";
ALTER TABLE "prescription"
  ADD CONSTRAINT "prescription_cancel_columns_only_when_cancelled" CHECK (
    "status" = 'CANCELLED'
    OR ("cancelled_at" IS NULL
        AND "cancelled_by_id" IS NULL
        AND "cancel_reason" IS NULL)
  );

-- La misma función de 20261001075947, con las tres columnas en la lista de lo
-- que cambia al anular, y una regla más: lo que dice una anulación no cambia.
CREATE OR REPLACE FUNCTION prescription_is_frozen_once_issued()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  mutable CONSTANT text[] := ARRAY['status', 'updated_at', 'discarded_at', 'discarded_by_id', 'discard_reason',
                                   'cancelled_at', 'cancelled_by_id', 'cancel_reason'];
BEGIN
  IF OLD.issued_at IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'prescription_frozen: an issued receta is never deleted'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'PR-020. Cancel it: a deleted receta is a gap in the '
                   'numbering the ACESS reads.';
  END IF;

  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION
      'prescription_frozen: an issued receta only changes its status'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'PR-020, PR-038. Cancel it and issue another one.';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'ACTIVE' AND NEW.status IN ('COMPLETED', 'CANCELLED', 'DISCARDED'))
    OR (OLD.status = 'COMPLETED' AND NEW.status = 'CANCELLED')) THEN
    -- DISCARDED pasa aquí para que lo rechace su CHECK, con su código.
    RAISE EXCEPTION
      'prescription_frozen: an issued receta never goes back to a previous status'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'PR-010. A cancelled receta stays cancelled; issue a new one.';
  END IF;

  -- PR-108. El registro del art. 70 se escribe una vez, al anular. Tampoco se
  -- completa después en una anulada antes de esta migración: sería inventarlo.
  IF OLD.status = 'CANCELLED' AND (
       NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
    OR NEW.cancelled_by_id IS DISTINCT FROM OLD.cancelled_by_id
    OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason) THEN
    RAISE EXCEPTION
      'prescription_frozen: an annulment is never rewritten'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'PR-108. Who annulled the receta, when and why stay as written.';
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
