-- service_order_frozen_diagnoses
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ORD-121 (D-117.5): LA ORDEN CONGELA SUS DIAGNÓSTICOS AL EMITIRSE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hasta aquí la orden de exámenes leía los diagnósticos VIVOS de la atención al
-- mostrarse, y por eso EN-182 prohibía corregir la atención mientras hubiera
-- una orden emitida con algún examen sin anular: la única salida era anular
-- exámenes que el laboratorio ya tenía. Ahora la orden hace lo que ya hacen la
-- receta (PR-026, `a_prescription_freeze_diagnoses`) y el certificado
-- (CER-027): copia sus diagnósticos en el instante de la emisión, la BASE y no
-- quien emite, y ya no los cambia.
--
-- Con eso ningún papel lee los diagnósticos vivos, y EN-182 deja de frenar:
-- `encounter_has_document_citing_diagnoses` y el disparador del rango
-- (`trg_encounter_diagnosis_rank_frozen_when_cited`) se retiran. La orden pasa
-- a ser uno más de los papeles en manos de un tercero —el laboratorio—: quitar
-- o cambiar el código que imprimió pide el motivo de lista
-- (`encounter_diagnosis_code_on_paper`, EN-212, EN-214), como la receta y el
-- certificado.
--
-- LAS YA EMITIDAS: lo que hay ahora en la atención es lo único que se sabe de
-- entonces, y mientras existía EN-182 nada pudo cambiarlo con exámenes vivos.
-- Se rellenan en la misma transacción que crea la garantía.
--
-- ⚠️ DENTRO DE UNA TRANSACCIÓN EXPLÍCITA: el relleno, el CHECK y el disparador
-- que congela entran juntos o no entra nada. Nada se apaga: el disparador que
-- congela lo emitido (`service_order_guard_status`) todavía no mira esta
-- columna cuando se rellena, y la mira desde el final de esta migración.
BEGIN;

ALTER TABLE "service_order" ADD COLUMN IF NOT EXISTS "diagnoses" JSONB;

UPDATE "service_order" o
   SET "diagnoses" = COALESCE((
         SELECT jsonb_agg(jsonb_build_object('code', d.cie10_code, 'display', d.cie10_display)
                          ORDER BY d.rank, d.recorded_at)
           FROM encounter_diagnosis d
          WHERE d.encounter_id = o.encounter_id), '[]'::jsonb)
 WHERE o.status = 'ISSUED'
   AND o.diagnoses IS NULL;

ALTER TABLE "service_order"
  DROP CONSTRAINT IF EXISTS "service_order_diagnoses_frozen_when_issued";
ALTER TABLE "service_order"
  ADD CONSTRAINT "service_order_diagnoses_frozen_when_issued"
  CHECK (("status" = 'ISSUED') = ("diagnoses" IS NOT NULL)
         AND ("diagnoses" IS NULL OR jsonb_typeof("diagnoses") = 'array'));

-- Lo copia la BASE en el instante de la emisión, sea quien sea quien emite: la
-- copia no puede venir del llamador. La misma forma que la receta.
CREATE OR REPLACE FUNCTION service_order_freeze_diagnoses()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'ISSUED'
     AND (TG_OP = 'INSERT' OR OLD.status <> 'ISSUED') THEN
    NEW.diagnoses := COALESCE((
      SELECT jsonb_agg(jsonb_build_object('code', d.cie10_code, 'display', d.cie10_display)
                       ORDER BY d.rank, d.recorded_at)
        FROM encounter_diagnosis d
       WHERE d.encounter_id = NEW.encounter_id), '[]'::jsonb);
  END IF;
  RETURN NEW;
END;
$$;

-- «a_» para correr antes que `service_order_guard_status` (orden alfabético).
DROP TRIGGER IF EXISTS "a_service_order_freeze_diagnoses" ON "service_order";
CREATE TRIGGER "a_service_order_freeze_diagnoses"
  BEFORE INSERT OR UPDATE ON "service_order"
  FOR EACH ROW
  EXECUTE FUNCTION service_order_freeze_diagnoses();

-- Lo emitido no se reescribe, y desde ahora tampoco sus diagnósticos. El resto
-- es la función de `20261005060100_service_order_restore_discarded_draft`.
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

-- ── El papel del laboratorio, como el de la farmacia y el del empleador ────
CREATE OR REPLACE FUNCTION encounter_diagnosis_code_on_paper(
  p_encounter_id uuid,
  p_cie10_code   text
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (SELECT 1
                   FROM medical_certificate c,
                        jsonb_array_elements(c.diagnoses) AS printed
                  WHERE c.encounter_id = p_encounter_id
                    AND printed ->> 'code' = p_cie10_code)
      OR EXISTS (SELECT 1
                   FROM prescription p,
                        jsonb_array_elements(p.diagnoses) AS printed
                  WHERE p.encounter_id = p_encounter_id
                    AND p.issued_at IS NOT NULL
                    AND printed ->> 'code' = p_cie10_code)
      OR EXISTS (SELECT 1
                   FROM service_order o,
                        jsonb_array_elements(o.diagnoses) AS printed
                  WHERE o.encounter_id = p_encounter_id
                    AND o.status = 'ISSUED'
                    AND printed ->> 'code' = p_cie10_code);
$$;

-- ── EN-182 deja de frenar: ningún papel lee los diagnósticos vivos ─────────
CREATE OR REPLACE FUNCTION encounter_diagnosis_retraction_admits()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  live encounter_diagnosis%ROWTYPE;
BEGIN
  SELECT * INTO live FROM encounter_diagnosis WHERE id = NEW.id;
  IF NOT FOUND
     OR live.encounter_id IS DISTINCT FROM NEW.encounter_id
     OR live.concept_id IS DISTINCT FROM NEW.concept_id
     OR live.cie10_code IS DISTINCT FROM NEW.cie10_code
     OR live.cie10_display IS DISTINCT FROM NEW.cie10_display
     OR live.certainty IS DISTINCT FROM NEW.certainty
     OR live.occurrence IS DISTINCT FROM NEW.occurrence
     OR live.rank IS DISTINCT FROM NEW.rank
     OR live.notifiable IS DISTINCT FROM NEW.notifiable
     OR live.note IS DISTINCT FROM NEW.note
     OR live.recorded_at IS DISTINCT FROM NEW.recorded_at THEN
    RAISE EXCEPTION
      'encounter_diagnosis_retraction_matches: the archive must be the diagnosis being removed, as it is'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-180.';
  END IF;

  IF NEW.restored_at IS NOT NULL OR NEW.restored_by_id IS NOT NULL
     OR NEW.restored_as_id IS NOT NULL THEN
    RAISE EXCEPTION
      'encounter_diagnosis_retraction_frozen: an archive is born not restored'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-213.';
  END IF;

  IF encounter_is_reported(NEW.encounter_id) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_reported: the attention was already reported to the RDACAA, and a correction would not reach it'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-213, D-117.16.';
  END IF;

  IF cie10_is_obstetric(NEW.cie10_code)
     AND encounter_diagnosis_supports_maternity_rest(NEW.encounter_id, NEW.id) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_supports_maternity_rest: a maternity rest in force stands on this obstetric diagnosis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-213, D-117.15. Annul the rest first.';
  END IF;

  IF NEW.reason IS NULL
     AND encounter_diagnosis_retraction_needs_reason(NEW.encounter_id, NEW.cie10_code) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_retraction_reason: an issued certificate, receta or order printed this code, so removing it states why'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-214, EN-189, D-117.14, ORD-121.';
  END IF;

  IF encounter_has_discharge(NEW.encounter_id)
     AND (SELECT count(*) FROM encounter_diagnosis d
           WHERE d.encounter_id = NEW.encounter_id) <= 1 THEN
    RAISE EXCEPTION
      'encounter_diagnosis_last_after_discharge: a discharged attention keeps at least one diagnosis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-188.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER "trg_encounter_diagnosis_rank_frozen_when_cited" ON "encounter_diagnosis";
DROP FUNCTION encounter_diagnosis_rank_frozen_when_cited();
DROP FUNCTION encounter_has_document_citing_diagnoses(uuid);

COMMIT;
