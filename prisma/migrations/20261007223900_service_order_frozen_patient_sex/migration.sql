-- service_order_frozen_patient_sex
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ORD-158 (D-163.1): LA ORDEN CONGELA EL SEXO DE LA FICHA AL EMITIRSE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La edad ya queda congelada en la atención (EN-221) y los diagnósticos en la
-- orden (ORD-121), pero el sexo se leía vivo de la ficha: corregirla después
-- de emitir cambiaba la cabecera de un papel que el laboratorio ya tiene
-- (ORD-126, ORD-150). Desde aquí la orden copia el sexo en el instante de la
-- emisión —lo escribe la BASE, no quien emite— y ya no lo cambia; la cabecera
-- lee esa copia (ORD-159). El rango de referencia NO: sigue el sexo actual de
-- la ficha (ORD-036; D-171.1).
--
-- LAS YA EMITIDAS: si la ficha corrigió su sexo DESPUÉS de emitirse la orden,
-- `patient_change_history` guarda lo que decía antes (PA-026): la orden se
-- rellena con el `value_before` de la primera corrección posterior a su
-- emisión, que es lo que imprimió. Si no hubo ninguna, con el sexo que la
-- ficha tiene hoy, que entonces es el mismo. Es lo mejor que se sabe, no una
-- garantía: ese histórico no es inmutable. Se rellenan en la misma
-- transacción que crea la garantía.
--
-- ⚠️ DENTRO DE UNA TRANSACCIÓN EXPLÍCITA: el relleno, el CHECK y los
-- disparadores entran juntos o no entra nada. Nada se apaga: el disparador que
-- congela lo emitido (`service_order_guard_status`) todavía no mira esta
-- columna cuando se rellena, y la mira desde el final de esta migración.
BEGIN;

ALTER TABLE "service_order" ADD COLUMN IF NOT EXISTS "patient_sex" "patient_sex";

UPDATE "service_order" o
   SET "patient_sex" = COALESCE(
         (SELECT h.value_before::patient_sex
            FROM patient_change_history h
           WHERE h.patient_id = e.patient_id
             AND h.field = 'sex'
             AND h.changed_at > o.requested_at
             AND h.value_before IN ('MALE', 'FEMALE', 'INTERSEX', 'UNKNOWN')
           ORDER BY h.changed_at ASC, h.id ASC
           LIMIT 1),
         p.sex)
  FROM encounter e
  JOIN patient p ON p.id = e.patient_id
 WHERE e.id = o.encounter_id
   AND o.status = 'ISSUED'
   AND o.patient_sex IS NULL;

ALTER TABLE "service_order"
  DROP CONSTRAINT IF EXISTS "service_order_patient_sex_frozen_when_issued";
ALTER TABLE "service_order"
  ADD CONSTRAINT "service_order_patient_sex_frozen_when_issued"
  CHECK (("status" = 'ISSUED') = ("patient_sex" IS NOT NULL));

-- Lo copia la BASE en el instante de la emisión, sea quien sea quien emite y
-- mande lo que mande: la copia no puede venir del llamador.
CREATE OR REPLACE FUNCTION service_order_freeze_patient_sex()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'ISSUED'
     AND (TG_OP = 'INSERT' OR OLD.status <> 'ISSUED') THEN
    NEW.patient_sex := (SELECT p.sex
                          FROM encounter e
                          JOIN patient p ON p.id = e.patient_id
                         WHERE e.id = NEW.encounter_id);
  END IF;
  RETURN NEW;
END;
$$;

-- «a_» para correr antes que `service_order_guard_status` (orden alfabético).
DROP TRIGGER IF EXISTS "a_service_order_freeze_patient_sex" ON "service_order";
CREATE TRIGGER "a_service_order_freeze_patient_sex"
  BEFORE INSERT OR UPDATE ON "service_order"
  FOR EACH ROW
  EXECUTE FUNCTION service_order_freeze_patient_sex();

-- Lo emitido no se reescribe, y desde ahora tampoco su sexo. El resto es la
-- función de `20261005070200_service_order_frozen_diagnoses`.
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
    -- ORD-121. What the paper printed as diagnoses.
    OR NEW.diagnoses IS DISTINCT FROM OLD.diagnoses
    -- ORD-158. The sex the paper printed (ranges follow the chart, D-171.1).
    OR NEW.patient_sex IS DISTINCT FROM OLD.patient_sex
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

COMMIT;
