-- paper_chart_of_record
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- QUÉ FICHA NOMBRA UN PAPEL, Y CON QUÉ SEXO (CER-057, CER-058, ORD-161)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La fusión no mueve nada (D-031): la atención de una ficha duplicada que se
-- unificó con la real sigue colgando de la duplicada, cuyo documento pasó a la
-- vigente (PA-043). El 117 y la orden emitidos desde ella salían con el nombre
-- de la duplicada y sin cédula (D-169.2 i).
--
-- Cada papel guarda, al emitirse, LA FICHA QUE NOMBRA (`chart_of_record_id`:
-- la vigente de su atención en ese instante) y EL SEXO DE ESA MISMA FICHA
-- (`patient_sex`). Lo escribe la BASE, no quien emite, y ninguno de los dos
-- cambia después: ni al unificar más tarde ni al deshacer la unificación. Así
-- un papel nunca junta el nombre de una ficha con el sexo de otra —la
-- revisión clínica lo vio en la primera versión de esta rama, que leía la
-- identidad en vivo y el sexo congelado—. El nombre y el documento se leen al
-- componer DE ESA FICHA, como hasta ahora se leían de la de la atención.
--
-- 1. CER-058 (D-171.2). El certificado no congelaba el sexo: corregir la ficha
--    cambiaba, al volver a generar el PDF, un papel que el empleador o el IESS
--    ya tienen. `NOT NULL DEFAULT 'UNKNOWN'` como `number`: el valor por
--    defecto sólo deja a Prisma omitirla; el disparador siempre lo pisa.
--    `medical_certificate_frozen` (CER-011) compara la fila entera, así que las
--    dos columnas quedan congeladas sin tocarlo.
--
--    Además el disparador comprueba lo que la base no comprobaba: que el
--    paciente del certificado es el de su atención (CER-001). Sin eso, un
--    INSERT crudo podía nombrar a una persona en una atención de otra.
--
-- 2. ORD-161 (D-171.3). La orden ya congelaba el sexo (ORD-158), de la ficha de
--    la atención aunque estuviera absorbida; ahora el de la vigente, y la ficha
--    que nombra. `service_order_guard_status` no deja reescribir ninguno.
--
-- LOS YA EMITIDOS nombraban la ficha de su atención (`patient_id`), que es lo
-- que el código leía: se rellenan con ella, también los emitidos tras una
-- fusión, porque eso es lo que imprimieron. El sexo del certificado, con el que
-- esa ficha tenía al emitirse según `patient_change_history` (PA-026): el
-- `value_before` de la primera corrección de sexo posterior a la emisión o, si
-- no la hubo, el de hoy —lo mismo que la orden en
-- `20261007223900_service_order_frozen_patient_sex`—. Es lo mejor que se sabe,
-- no una garantía: ese histórico no es inmutable.
--
-- ⚠️ EL RELLENO APAGA `medical_certificate_frozen` Y SÓLO ÉL, dentro de la
-- misma transacción explícita que lo vuelve a encender: es la única escritura
-- que toca un certificado emitido, y sólo sobre columnas que nacen aquí. Si
-- algo falla, no entra nada. La orden no lo necesita: su guarda todavía no
-- mira la columna nueva cuando se rellena.
BEGIN;

-- ── medical_certificate ────────────────────────────────────────────────────

ALTER TABLE "medical_certificate"
  ADD COLUMN IF NOT EXISTS "patient_sex" "patient_sex" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "chart_of_record_id" UUID;

ALTER TABLE "medical_certificate" DISABLE TRIGGER "medical_certificate_frozen";

UPDATE "medical_certificate" c
   SET "chart_of_record_id" = c.patient_id,
       "patient_sex" = COALESCE(
         (SELECT h.value_before::patient_sex
            FROM patient_change_history h
           WHERE h.patient_id = c.patient_id
             AND h.field = 'sex'
             AND h.changed_at > c.issued_at
             AND h.value_before IN ('MALE', 'FEMALE', 'INTERSEX', 'UNKNOWN')
           ORDER BY h.changed_at ASC, h.id ASC
           LIMIT 1),
         p.sex)
  FROM patient p
 WHERE p.id = c.patient_id;

ALTER TABLE "medical_certificate" ENABLE TRIGGER "medical_certificate_frozen";

ALTER TABLE "medical_certificate" ALTER COLUMN "chart_of_record_id" SET NOT NULL;
ALTER TABLE "medical_certificate"
  DROP CONSTRAINT IF EXISTS "medical_certificate_chart_of_record_fk";
ALTER TABLE "medical_certificate"
  ADD CONSTRAINT "medical_certificate_chart_of_record_fk"
  FOREIGN KEY ("chart_of_record_id") REFERENCES "patient"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- La ficha y el sexo los escribe la BASE en la inserción, mande lo que mande
-- quien emite: la vigente de la ficha de la atención, un nivel y nunca una
-- cadena (`trg_patient_merge_not_chained`, PA-046).
CREATE OR REPLACE FUNCTION medical_certificate_freeze_chart_of_record()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  attention_patient UUID;
BEGIN
  SELECT e.patient_id INTO attention_patient
    FROM encounter e
   WHERE e.id = NEW.encounter_id;

  IF NEW.patient_id IS DISTINCT FROM attention_patient THEN
    RAISE EXCEPTION
      'medical_certificate_patient_of_attention: a certificate is about the patient of its attention'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'CER-001.';
  END IF;

  SELECT COALESCE(chart.merged_into_id, chart.id),
         COALESCE(survivor.sex, chart.sex)
    INTO NEW.chart_of_record_id, NEW.patient_sex
    FROM patient chart
    LEFT JOIN patient survivor ON survivor.id = chart.merged_into_id
   WHERE chart.id = attention_patient;
  RETURN NEW;
END;
$$;

-- «a_» para correr antes que `medical_certificate_issue_rules` y
-- `medical_certificate_number_assigned` (orden alfabético).
DROP TRIGGER IF EXISTS "a_medical_certificate_freeze_chart_of_record" ON "medical_certificate";
CREATE TRIGGER "a_medical_certificate_freeze_chart_of_record"
  BEFORE INSERT ON "medical_certificate"
  FOR EACH ROW
  EXECUTE FUNCTION medical_certificate_freeze_chart_of_record();

-- ── service_order ──────────────────────────────────────────────────────────

ALTER TABLE "service_order" ADD COLUMN IF NOT EXISTS "chart_of_record_id" UUID;

UPDATE "service_order" o
   SET "chart_of_record_id" = e.patient_id
  FROM encounter e
 WHERE e.id = o.encounter_id
   AND o.status = 'ISSUED'
   AND o.chart_of_record_id IS NULL;

ALTER TABLE "service_order"
  DROP CONSTRAINT IF EXISTS "service_order_chart_of_record_fk";
ALTER TABLE "service_order"
  ADD CONSTRAINT "service_order_chart_of_record_fk"
  FOREIGN KEY ("chart_of_record_id") REFERENCES "patient"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "service_order"
  DROP CONSTRAINT IF EXISTS "service_order_chart_of_record_when_issued";
ALTER TABLE "service_order"
  ADD CONSTRAINT "service_order_chart_of_record_when_issued"
  CHECK (("status" = 'ISSUED') = ("chart_of_record_id" IS NOT NULL));

-- ORD-158 y ORD-161. Lo demás es la función de
-- `20261007223900_service_order_frozen_patient_sex`.
CREATE OR REPLACE FUNCTION service_order_freeze_patient_sex()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'ISSUED'
     AND (TG_OP = 'INSERT' OR OLD.status <> 'ISSUED') THEN
    SELECT COALESCE(chart.merged_into_id, chart.id),
           COALESCE(survivor.sex, chart.sex)
      INTO NEW.chart_of_record_id, NEW.patient_sex
      FROM encounter e
      JOIN patient chart ON chart.id = e.patient_id
      LEFT JOIN patient survivor ON survivor.id = chart.merged_into_id
     WHERE e.id = NEW.encounter_id;
  END IF;
  RETURN NEW;
END;
$$;

-- Lo emitido no se reescribe, y desde ahora tampoco la ficha que nombra.
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
    -- ORD-161. The chart whose identity the paper prints.
    OR NEW.chart_of_record_id IS DISTINCT FROM OLD.chart_of_record_id
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
