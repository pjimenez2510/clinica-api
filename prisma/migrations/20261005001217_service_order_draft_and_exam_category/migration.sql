-- service_order_draft_and_exam_category
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy


-- QUÉ GARANTIZA (orders/SPEC.md §9, ORD-095 a ORD-099, ORD-097; revisión de
-- usabilidad del autor del 04-10-2026).
--
--  · La orden nace en BORRADOR (`service_order_status`): se corrige hasta
--    emitirla. Las que ya existían se emitieron así y pasan a `ISSUED`.
--  · El número del A.M. 00002393 art. 43 (ORD-006) se toma AL EMITIR, no al
--    guardar el borrador: un borrador descartado que se hubiera llevado el 42
--    dejaría la 41 y la 43 y una pregunta por la 42. Un borrador no tiene
--    número (`service_order_number_iff_issued`), y nadie se lo pone ni se lo
--    cambia (`service_order_number_immutable`, ampliado).
--  · Las transiciones son DRAFT → ISSUED y DRAFT → DISCARDED, y ninguna más
--    (`service_order_status_transition`). Descartar deja quién y cuándo
--    (`service_order_discard_states_who_and_when`), sin borrar nada.
--  · Fuera de borrador, la orden y sus líneas quedan CONGELADAS: tipo,
--    prioridad, indicación, atención y profesional
--    (`service_order_frozen_once_issued`), y las líneas no se añaden, quitan
--    ni reescriben (`service_order_item_frozen_once_issued`). Lo único que
--    cambia en una línea emitida es su estado —anulación (ORD-007) y
--    resultado—, y sólo en una orden emitida.
--  · El examen tiene TIPO (`exam_definition.category`): sin él, «Tipo de
--    orden» no podía filtrar la lista y se pedía un hemograma como imagen.
--    Lo que ya había es de laboratorio.
--  · La cola de pendientes es de lo EMITIDO: su índice parcial se rehace con
--    `status = 'ISSUED'`, que es lo que la consulta pregunta (ORD-100).

-- ── El tipo del examen ───────────────────────────────────────────────────

ALTER TABLE "exam_definition"
  ADD COLUMN "category" "service_order_category" NOT NULL DEFAULT 'LABORATORY';

COMMENT ON COLUMN "exam_definition"."category" IS
  'ORD-097, ORD-101. Laboratory, imaging or procedure: an order only carries exams of its own category.';

-- ── El estado de la orden ────────────────────────────────────────────────

CREATE TYPE "service_order_status" AS ENUM ('DRAFT', 'ISSUED', 'DISCARDED');

ALTER TABLE "service_order"
  ADD COLUMN "status" "service_order_status" NOT NULL DEFAULT 'ISSUED',
  ADD COLUMN "discarded_at" TIMESTAMPTZ(6),
  ADD COLUMN "discarded_by_id" UUID;

-- Lo que ya existía queda ISSUED por el valor por defecto de arriba; desde
-- aquí, lo que se inserta sin decir nada nace en borrador.
ALTER TABLE "service_order" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

ALTER TABLE "service_order"
  ADD CONSTRAINT "service_order_discarded_by_fk"
  FOREIGN KEY ("discarded_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT;

ALTER TABLE "service_order"
  ADD CONSTRAINT "service_order_discard_states_who_and_when" CHECK (
    ("status" = 'DISCARDED') = ("discarded_at" IS NOT NULL AND "discarded_by_id" IS NOT NULL)
    AND ("status" = 'DISCARDED' OR ("discarded_at" IS NULL AND "discarded_by_id" IS NULL))
  );

-- El número: nulo hasta emitir.
ALTER TABLE "service_order" ALTER COLUMN "number" DROP NOT NULL;
ALTER TABLE "service_order" ALTER COLUMN "number" DROP DEFAULT;

ALTER TABLE "service_order"
  ADD CONSTRAINT "service_order_number_iff_issued" CHECK (
    ("status" = 'ISSUED') = ("number" IS NOT NULL)
  );

-- ── El número, al emitir ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION service_order_assign_number()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- El disparador PISA lo que traiga la fila, como siempre: nadie elige.
    NEW.number := CASE WHEN NEW.status = 'ISSUED'
                       THEN next_document_number(NEW.site_id, 'SERVICE_ORDER')
                  END;
  ELSIF NEW.status = 'ISSUED' AND OLD.status <> 'ISSUED' THEN
    NEW.number := next_document_number(NEW.site_id, 'SERVICE_ORDER');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "service_order_number_assigned" ON "service_order";
CREATE TRIGGER "service_order_number_assigned"
  BEFORE INSERT OR UPDATE ON "service_order"
  FOR EACH ROW
  EXECUTE FUNCTION service_order_assign_number();

-- Corre DESPUÉS del de arriba (orden alfabético de los BEFORE): la única
-- vez que el número cambia es la emisión, y lo pone el disparador.
CREATE OR REPLACE FUNCTION service_order_number_is_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.number IS DISTINCT FROM OLD.number
      AND NOT (OLD.status <> 'ISSUED' AND NEW.status = 'ISSUED'))
     OR NEW.site_id IS DISTINCT FROM OLD.site_id THEN
    RAISE EXCEPTION
      'service_order_number_immutable: the number and the site of an order never change'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'ORD-006, ORD-098. The number is taken when the order is '
                   'issued and printed on the request the patient carries.';
  END IF;
  RETURN NEW;
END;
$$;

-- ── Las transiciones y lo congelado ──────────────────────────────────────

CREATE OR REPLACE FUNCTION service_order_guard_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'service_order_status_transition: an order goes from DRAFT to ISSUED or DISCARDED, and nowhere else'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'ORD-098, ORD-099.';
  END IF;

  IF OLD.status <> 'DRAFT' AND (
       NEW.category IS DISTINCT FROM OLD.category
    OR NEW.priority IS DISTINCT FROM OLD.priority
    OR NEW.clinical_note_text IS DISTINCT FROM OLD.clinical_note_text
    OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
    OR NEW.ordered_by_id IS DISTINCT FROM OLD.ordered_by_id
    OR NEW.discarded_at IS DISTINCT FROM OLD.discarded_at
    OR NEW.discarded_by_id IS DISTINCT FROM OLD.discarded_by_id
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

CREATE TRIGGER "service_order_guard_status"
  BEFORE UPDATE ON "service_order"
  FOR EACH ROW
  EXECUTE FUNCTION service_order_guard_status();

CREATE OR REPLACE FUNCTION service_order_item_guard_frozen()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status service_order_status;
  violation BOOLEAN;
BEGIN
  SELECT status INTO parent_status
    FROM service_order
   WHERE id = CASE TG_OP WHEN 'DELETE' THEN OLD.service_order_id
                         ELSE NEW.service_order_id END;

  violation := CASE TG_OP
    -- Las líneas se ponen y se quitan mientras la orden es borrador.
    WHEN 'INSERT' THEN parent_status IS DISTINCT FROM 'DRAFT'
    WHEN 'DELETE' THEN parent_status IS DISTINCT FROM 'DRAFT'
    -- Lo que la línea pide no se reescribe nunca: en borrador se quita y se
    -- pone otra. Su estado sólo se mueve en una orden emitida.
    ELSE NEW.service_order_id IS DISTINCT FROM OLD.service_order_id
      OR NEW.concept_id IS DISTINCT FROM OLD.concept_id
      OR NEW.test_code IS DISTINCT FROM OLD.test_code
      OR NEW.test_display IS DISTINCT FROM OLD.test_display
      OR ((NEW.status IS DISTINCT FROM OLD.status
           OR NEW.completed_at IS DISTINCT FROM OLD.completed_at)
          AND parent_status IS DISTINCT FROM 'ISSUED')
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

CREATE TRIGGER "service_order_item_guard_frozen"
  BEFORE INSERT OR UPDATE OR DELETE ON "service_order_item"
  FOR EACH ROW
  EXECUTE FUNCTION service_order_item_guard_frozen();

-- ── La cola de pendientes, de lo emitido ─────────────────────────────────

DROP INDEX IF EXISTS "service_order_pending_by_site";
CREATE INDEX "service_order_pending_by_site"
  ON "service_order" ("site_id", "requested_at")
  WHERE "pending_items" > 0 AND "status" = 'ISSUED';
