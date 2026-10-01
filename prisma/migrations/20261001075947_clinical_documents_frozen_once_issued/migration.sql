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
       "employer_name" = CASE WHEN c.type = 'MEDICAL_REST' THEN p.employer_name END,
       "job_title" = CASE WHEN c.type = 'MEDICAL_REST' THEN p.job_title END,
       "residence_address_line" = CASE WHEN c.type = 'MEDICAL_REST' THEN p.residence_address_line END,
       "patient_phone" = CASE WHEN c.type = 'MEDICAL_REST' THEN p.phone END
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
-- 3. PR-010, PR-020, PR-038. Una receta emitida sólo avanza de estado, sus
--    líneas no cambian, y no se borra.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- El estado avanza: ACTIVE → COMPLETED o CANCELLED, y COMPLETED → CANCELLED.
-- Nunca hacia atrás: una anulada que volviera a ACTIVE se leería válida en
-- `/verificar` y en el papel. Un borrador (sin `issued_at`) se edita
-- libremente. Las columnas del descarte pasan: los CHECK de 20260820130655 ya
-- rechazan descartar una receta emitida, con su propio código, que la API
-- traduce.

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

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'ACTIVE' AND NEW.status IN ('COMPLETED', 'CANCELLED', 'DISCARDED'))
    OR (OLD.status = 'COMPLETED' AND NEW.status = 'CANCELLED')) THEN
    -- DISCARDED pasa aquí para que lo rechace su CHECK, con su código.
    RAISE EXCEPTION
      'prescription_frozen: an issued receta never goes back to a previous status'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'PR-010. A cancelled receta stays cancelled; issue a new one.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "prescription_frozen" ON "prescription";
CREATE TRIGGER "prescription_frozen"
  BEFORE UPDATE OR DELETE ON "prescription"
  FOR EACH ROW
  EXECUTE FUNCTION prescription_is_frozen_once_issued();

-- Las líneas de una receta emitida: ni se añaden, ni se editan, ni se borran,
-- ni se llevan a otra receta. Se mira la receta de ANTES y la de DESPUÉS:
-- mover una línea a un borrador era quitarla de un papel emitido. Una receta
-- emitida nace borrador con sus líneas y se emite después; así lo hace el
-- código, y así las crean las pruebas.

CREATE OR REPLACE FUNCTION prescription_item_is_frozen_once_issued()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM prescription p
     WHERE p.issued_at IS NOT NULL
       AND p.id IN (
         CASE WHEN TG_OP <> 'INSERT' THEN OLD.prescription_id END,
         CASE WHEN TG_OP <> 'DELETE' THEN NEW.prescription_id END)
  ) THEN
    RAISE EXCEPTION
      'prescription_frozen: the lines of an issued receta never change'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'PR-020, PR-038. Cancel the receta and issue another one.';
  END IF;
  RETURN COALESCE(NEW, OLD);
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
-- 4b. Y nada de lo anterior se salta con TRUNCATE, que no dispara los de fila.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Como `access_audit` o `clinical_note`. La limpieza de las pruebas trabaja en
-- `session_replication_role = replica`, que no los dispara.

CREATE OR REPLACE FUNCTION clinical_document_is_never_truncated()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    '%_frozen: issued clinical documents are never truncated', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS "medical_certificate_never_truncated" ON "medical_certificate";
CREATE TRIGGER "medical_certificate_never_truncated"
  BEFORE TRUNCATE ON "medical_certificate"
  FOR EACH STATEMENT EXECUTE FUNCTION clinical_document_is_never_truncated();

DROP TRIGGER IF EXISTS "prescription_never_truncated" ON "prescription";
CREATE TRIGGER "prescription_never_truncated"
  BEFORE TRUNCATE ON "prescription"
  FOR EACH STATEMENT EXECUTE FUNCTION clinical_document_is_never_truncated();

DROP TRIGGER IF EXISTS "prescription_item_never_truncated" ON "prescription_item";
CREATE TRIGGER "prescription_item_never_truncated"
  BEFORE TRUNCATE ON "prescription_item"
  FOR EACH STATEMENT EXECUTE FUNCTION clinical_document_is_never_truncated();

DROP TRIGGER IF EXISTS "service_order_never_truncated" ON "service_order";
CREATE TRIGGER "service_order_never_truncated"
  BEFORE TRUNCATE ON "service_order"
  FOR EACH STATEMENT EXECUTE FUNCTION clinical_document_is_never_truncated();

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
