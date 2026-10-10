-- privacy_copy_snapshot
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio. Ver scripts/new-migration.mts.
--
-- Revisión clínica y de acceso de `feat/privacy-copia-ajustes` (10-10-2026):
--
-- 1. LO AUTORIZADO, CONGELADO (D-203 §3, DOC-122). Cada respuesta que autoriza
--    una copia guarda, en la misma transacción, lo que la copia lleva en ese
--    instante (`clinical_record_copy_snapshot`): cada descarga sirve eso, y lo
--    que se registre, enmiende o retire después no cambia lo entregado. No es
--    el PDF (DOC-118 no lo archiva): son los datos que el PDF pinta.
-- 2. EL VISTO BUENO SE RENUEVA (PD-061): si aparece algo sensible después de
--    él, hace falta otro. Deja de ser uno por solicitud: el vigente es el
--    último.
-- 3. EL PARENTESCO OBLIGATORIO, SÓLO AL REGISTRAR: el CHECK NOT VALID de
--    `20261011120000` se volvía a comprobar en cada UPDATE de la fila, y una
--    solicitud de familiar anterior no se podía ni responder. Pasa a un
--    disparador BEFORE INSERT.
--
-- PARA DESHACERLA: borrar `clinical_record_copy_snapshot` y su disparador,
-- volver la clave del visto bueno a `request_id` (fallará con dos por
-- solicitud), y restaurar el CHECK del parentesco.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Lo autorizado, congelado
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "clinical_record_copy_snapshot" (
  "id"            UUID           NOT NULL DEFAULT uuidv7(),
  "request_id"    UUID           NOT NULL,
  -- La rectificación que autoriza; NULL, la respuesta original.
  "correction_id" UUID,
  "data"          JSONB          NOT NULL,
  "frozen_at"     TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "clinical_record_copy_snapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "clinical_record_copy_snapshot_request_fkey"
    FOREIGN KEY ("request_id") REFERENCES "data_subject_request" ("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "clinical_record_copy_snapshot_correction_fkey"
    FOREIGN KEY ("correction_id") REFERENCES "data_subject_answer_correction" ("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- Una por respuesta: la original o cada rectificación.
CREATE UNIQUE INDEX "clinical_record_copy_snapshot_one_per_answer"
  ON "clinical_record_copy_snapshot" ("request_id", "correction_id")
  NULLS NOT DISTINCT;

CREATE TRIGGER "trg_clinical_record_copy_snapshot_immutable"
  BEFORE UPDATE OR DELETE ON "clinical_record_copy_snapshot"
  FOR EACH ROW EXECUTE FUNCTION privacy_insert_only();
CREATE TRIGGER "trg_clinical_record_copy_snapshot_no_truncate"
  BEFORE TRUNCATE ON "clinical_record_copy_snapshot"
  FOR EACH STATEMENT EXECUTE FUNCTION privacy_insert_only();

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. El visto bueno se renueva
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "clinical_record_copy_review"
  DROP CONSTRAINT "clinical_record_copy_review_pkey",
  ADD COLUMN "id" UUID NOT NULL DEFAULT uuidv7(),
  ADD CONSTRAINT "clinical_record_copy_review_pkey" PRIMARY KEY ("id");

CREATE INDEX "clinical_record_copy_review_by_request"
  ON "clinical_record_copy_review" ("request_id", "reviewed_at" DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. El parentesco, obligatorio al registrar
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "data_subject_request"
  DROP CONSTRAINT "data_subject_request_relationship_required";

CREATE OR REPLACE FUNCTION data_subject_request_relationship_required()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."requested_by" = 'DECEASED_RELATIVE'
     AND NEW."requester_relationship" IS NULL THEN
    RAISE EXCEPTION 'data_subject_request_relationship_required: the relative of a deceased patient says their relationship'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'data_subject_request_relationship_required',
            HINT = 'PD-063.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_data_subject_request_relationship_required"
  BEFORE INSERT ON "data_subject_request"
  FOR EACH ROW
  EXECUTE FUNCTION data_subject_request_relationship_required();
