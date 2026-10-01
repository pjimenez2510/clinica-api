-- Lo que la revisión de feat/f05-ordenes-receta encontró que la base no
-- garantizaba: un documento clínico emitido se podía editar, borrar o volver a
-- dar por válido sin rastro, y el certificado se componía con lo que la
-- atención y la ficha decían HOY, no con lo que decían al emitirlo.
--
-- Todo se comprueba aquí y no sólo en el código porque lo que lo rompe es justo
-- lo que no pasa por el código: un `psql`, una importación, un script de
-- soporte.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. CER-027, CER-038. El certificado guarda lo que imprimió.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Los diagnósticos de la atención se pueden seguir añadiendo después de emitir
-- (la atención sigue abierta), y la ficha se corrige. Leídos en vivo, un
-- certificado de asistencia que el paciente autorizó con J06.9 salía al
-- empleador con el diagnóstico que el médico registró después: uno que nadie
-- consintió revelar (LOPDP arts. 25 y 26.b). Se copian al emitir, en la misma
-- transacción, y el 117 se compone sólo con la copia.

ALTER TABLE "medical_certificate"
  ADD COLUMN "diagnoses" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "employer_name" VARCHAR(160),
  ADD COLUMN "job_title" VARCHAR(120),
  ADD COLUMN "residence_address_line" VARCHAR(255),
  ADD COLUMN "patient_phone" VARCHAR(32);

ALTER TABLE "medical_certificate"
  ADD CONSTRAINT "medical_certificate_diagnoses_is_list"
  CHECK (jsonb_typeof("diagnoses") = 'array');

-- Los ya emitidos en una base de desarrollo: lo que hay ahora es lo único que
-- se sabe de entonces. Sin producción, no hay nada más que reconstruir.
UPDATE "medical_certificate" c
   SET "diagnoses" = COALESCE((
         SELECT jsonb_agg(jsonb_build_object('code', d.cie10_code, 'display', d.cie10_display)
                          ORDER BY d.rank, d.recorded_at)
           FROM encounter_diagnosis d
          WHERE d.encounter_id = c.encounter_id
            AND c.include_diagnosis
       ), '[]'::jsonb),
       "employer_name" = p.employer_name,
       "job_title" = p.job_title,
       "residence_address_line" = p.residence_address_line,
       "patient_phone" = p.phone
  FROM patient p
 WHERE p.id = c.patient_id;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. CER-011, REQ-074. Un certificado emitido no cambia, salvo para anularlo,
--    y la anulación no se deshace. Ninguno se borra.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Se compara la fila ENTERA menos lo que la anulación escribe: una columna que
-- se añada mañana queda congelada sin que nadie tenga que acordarse de ella.

CREATE OR REPLACE FUNCTION medical_certificate_is_frozen()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  revocation CONSTANT text[] := ARRAY['revoked_at', 'revoked_by_id', 'revocation_reason', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'medical_certificate_frozen: an issued certificate is never deleted'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'CER-011 (REQ-074). Annul it with its reason: a deleted '
                   'certificate is a gap in the series of the site.';
  END IF;

  IF (to_jsonb(NEW) - revocation) IS DISTINCT FROM (to_jsonb(OLD) - revocation) THEN
    RAISE EXCEPTION
      'medical_certificate_frozen: an issued certificate never changes'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'CER-011. Annul it and issue another one.';
  END IF;

  IF OLD.revoked_at IS NOT NULL AND (
       NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    OR NEW.revoked_by_id IS DISTINCT FROM OLD.revoked_by_id
    OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason) THEN
    RAISE EXCEPTION
      'medical_certificate_frozen: an annulment is never undone nor rewritten'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'CER-011. A certificate annulled by mistake stays annulled; '
                   'issue a new one.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "medical_certificate_frozen" ON "medical_certificate";
CREATE TRIGGER "medical_certificate_frozen"
  BEFORE UPDATE OR DELETE ON "medical_certificate"
  FOR EACH ROW
  EXECUTE FUNCTION medical_certificate_is_frozen();

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. PR-020, PR-038. Una receta emitida no cambia salvo de estado, sus líneas
--    tampoco, y no se borra.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- El estado sí: ACTIVE pasa a COMPLETED o CANCELLED, y eso es lo que la
-- farmacia consulta. Un borrador (sin `issued_at`) se edita libremente. Las
-- columnas del descarte pasan: los CHECK de 20260820130655 ya rechazan
-- descartar una receta emitida, con su propio código, que la API traduce.

CREATE OR REPLACE FUNCTION prescription_is_frozen_once_issued()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  mutable CONSTANT text[] := ARRAY['status', 'updated_at', 'discarded_at', 'discarded_by_id', 'discard_reason'];
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

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "prescription_frozen" ON "prescription";
CREATE TRIGGER "prescription_frozen"
  BEFORE UPDATE OR DELETE ON "prescription"
  FOR EACH ROW
  EXECUTE FUNCTION prescription_is_frozen_once_issued();

-- Las líneas de una receta emitida. La INSERCIÓN se admite sólo en la misma
-- transacción que escribió la receta: es como se crea una receta ya emitida de
-- una vez (una importación, una prueba), y fuera de ella sería añadir un
-- medicamento a un papel que la farmacia ya tiene.

CREATE OR REPLACE FUNCTION prescription_item_is_frozen_once_issued()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_id uuid := COALESCE(NEW.prescription_id, OLD.prescription_id);
  issued boolean;
  written_now boolean;
BEGIN
  SELECT p.issued_at IS NOT NULL,
         p.xmin::text::bigint = pg_current_xact_id()::text::bigint % 4294967296
    INTO issued, written_now
    FROM prescription p
   WHERE p.id = parent_id;

  IF NOT COALESCE(issued, false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'INSERT' AND written_now THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'prescription_frozen: the lines of an issued receta never change'
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'PR-020, PR-038. Cancel the receta and issue another one.';
END;
$$;

DROP TRIGGER IF EXISTS "prescription_item_frozen" ON "prescription_item";
CREATE TRIGGER "prescription_item_frozen"
  BEFORE INSERT OR UPDATE OR DELETE ON "prescription_item"
  FOR EACH ROW
  EXECUTE FUNCTION prescription_item_is_frozen_once_issued();

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. ORD-006. Una orden numerada no se borra: se cancelan sus exámenes.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION service_order_is_never_deleted()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'service_order_frozen: an order is never deleted'
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'ORD-006. Cancel its exams: a deleted order is a gap in the '
                 'consecutive numbering of the site.';
END;
$$;

DROP TRIGGER IF EXISTS "service_order_never_deleted" ON "service_order";
CREATE TRIGGER "service_order_never_deleted"
  BEFORE DELETE ON "service_order"
  FOR EACH ROW
  EXECUTE FUNCTION service_order_is_never_deleted();

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. DOC-008. Un sujeto tiene UN documento original; los demás lo corrigen.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Pulsar «Emitir» dos veces, o desde dos pestañas, archivaba dos originales de
-- la misma receta: la bifurcación que `supersedes_id` existe para evitar. La
-- factura queda fuera: su ciclo lo lleva la rama del SRI.

CREATE UNIQUE INDEX "document_render_prescription_original_unique"
  ON "document_render" ("prescription_id")
  WHERE "supersedes_id" IS NULL AND "prescription_id" IS NOT NULL;

CREATE UNIQUE INDEX "document_render_service_order_original_unique"
  ON "document_render" ("service_order_id")
  WHERE "supersedes_id" IS NULL AND "service_order_id" IS NOT NULL;

CREATE UNIQUE INDEX "document_render_certificate_original_unique"
  ON "document_render" ("certificate_id")
  WHERE "supersedes_id" IS NULL AND "certificate_id" IS NOT NULL;
