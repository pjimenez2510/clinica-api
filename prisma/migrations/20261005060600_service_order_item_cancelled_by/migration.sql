-- service_order_item_cancelled_by
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ORD-007 y ORD-118 (revisión de fix/menos-preguntas-receta-ordenes).
--
-- QUÉ GARANTIZA. Anular un examen de una orden emitida —uno a uno, o todos
-- los vivos al «Corregir» la orden— deja dicho QUIÉN lo anuló. Cuándo ya lo
-- decía `completed_at`. La receta (PR-108) y el certificado ya guardaban
-- quién los anuló; la línea de la orden no, y es lo que se pregunta cuando un
-- examen desaparece de la cola del laboratorio con el papel ya entregado.
--
--   · `service_order_item_cancel_states_who`: una línea que pasa a
--     `CANCELLED` DESDE AHORA lleva `cancelled_by_id`.
--   · `service_order_item_cancelled_by_only_when_cancelled`: ningún otro
--     estado lo lleva. Una línea viva que dijera quién la anuló diría dos
--     cosas.
--   · `service_order_item_guard_frozen`: una línea nace sin él, sólo se
--     escribe al anular en una orden emitida, y lo que dice no se reescribe.
--
-- LAS LÍNEAS ANULADAS ANTES NO SE TOCAN, Y EL PRIMER CHECK NO SE VALIDARÁ
-- NUNCA. Se anularon cuando no había dónde guardar quién, y no se inventa
-- nadie: entra `NOT VALID`, así que PostgreSQL no revisa las filas que ya
-- existen y sí toda fila que se escriba a partir de ahora. Una línea anulada
-- es terminal (ORD-008: no se vuelve a anular ni a completar), así que el
-- CHECK sin validar no le estorba en nada que hoy se pueda hacer con ella.
-- `VALIDATE CONSTRAINT` fallaría mientras exista una sola de esas filas, y
-- siempre existirán: no se corre. El segundo CHECK sí se valida: hoy ninguna
-- fila tiene la columna.
--
-- `ADD COLUMN` sin defecto no reescribe la tabla ni dispara los disparadores
-- de fila. No toca datos.

BEGIN;

ALTER TABLE "service_order_item"
  ADD COLUMN IF NOT EXISTS "cancelled_by_id" UUID;

ALTER TABLE "service_order_item"
  DROP CONSTRAINT IF EXISTS "service_order_item_cancelled_by_fk";
ALTER TABLE "service_order_item"
  ADD CONSTRAINT "service_order_item_cancelled_by_fk"
    FOREIGN KEY ("cancelled_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "service_order_item"
  DROP CONSTRAINT IF EXISTS "service_order_item_cancel_states_who";
ALTER TABLE "service_order_item"
  ADD CONSTRAINT "service_order_item_cancel_states_who" CHECK (
    "status" <> 'CANCELLED' OR "cancelled_by_id" IS NOT NULL
  ) NOT VALID;

ALTER TABLE "service_order_item"
  DROP CONSTRAINT IF EXISTS "service_order_item_cancelled_by_only_when_cancelled";
ALTER TABLE "service_order_item"
  ADD CONSTRAINT "service_order_item_cancelled_by_only_when_cancelled" CHECK (
    "status" = 'CANCELLED' OR "cancelled_by_id" IS NULL
  );

-- La misma función de 20261005001217, con `cancelled_by_id`: una línea nace
-- sin él; se escribe sólo junto al estado, en una orden emitida; y una vez
-- escrito no cambia.
CREATE OR REPLACE FUNCTION service_order_item_guard_frozen()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status service_order_status;
  violation BOOLEAN;
BEGIN
  -- FOR SHARE: an issue committing meanwhile is waited for, so a line cannot
  -- land in an order that stopped being a draft under its feet.
  SELECT status INTO parent_status
    FROM service_order
   WHERE id = CASE TG_OP WHEN 'DELETE' THEN OLD.service_order_id
                         ELSE NEW.service_order_id END
     FOR SHARE;

  violation := CASE TG_OP
    -- Las líneas se ponen y se quitan mientras la orden es borrador.
    -- And a line is born asked for: never already done or cancelled.
    WHEN 'INSERT' THEN parent_status IS DISTINCT FROM 'DRAFT'
                    OR NEW.status <> 'REQUESTED'
                    OR NEW.completed_at IS NOT NULL
                    OR NEW.cancelled_by_id IS NOT NULL
    WHEN 'DELETE' THEN parent_status IS DISTINCT FROM 'DRAFT'
    -- Lo que la línea pide no se reescribe nunca: en borrador se quita y se
    -- pone otra. Su estado sólo se mueve en una orden emitida.
    ELSE NEW.service_order_id IS DISTINCT FROM OLD.service_order_id
      OR NEW.concept_id IS DISTINCT FROM OLD.concept_id
      OR NEW.test_code IS DISTINCT FROM OLD.test_code
      OR NEW.test_display IS DISTINCT FROM OLD.test_display
      OR ((NEW.status IS DISTINCT FROM OLD.status
           OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
           OR NEW.cancelled_by_id IS DISTINCT FROM OLD.cancelled_by_id)
          AND parent_status IS DISTINCT FROM 'ISSUED')
      -- ORD-007. Quién anuló, una vez dicho, no se reescribe.
      OR (OLD.cancelled_by_id IS NOT NULL
          AND NEW.cancelled_by_id IS DISTINCT FROM OLD.cancelled_by_id)
  END;

  IF violation THEN
    RAISE EXCEPTION
      'service_order_item_frozen_once_issued: the lines of an order change only while it is a draft'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'ORD-096, ORD-100. An issued line is cancelled (ORD-007), never '
                   'rewritten or deleted; a draft line is not cancelled, it is removed.';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

COMMIT;
