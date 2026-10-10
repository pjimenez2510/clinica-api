-- privacy_copy_adjustments
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio. Ver scripts/new-migration.mts.
--
-- D-203 §2, §5 a §7 (aceptadas por el autor el 10-10-2026). La copia de la
-- historia clínica como la entrega el HCAM:
--
-- 1. EL ALCANCE de la autorización (PD-059): «Atendida en parte» de una copia
--    lleva el periodo, desde–hasta, en la respuesta y en su rectificación;
--    «Atendida» es la completa y no lo lleva.
-- 2. EL PARENTESCO del familiar del fallecido (PD-063), de un catálogo
--    cerrado; sólo el suyo, y no cambia al editar.
-- 3. EL VISTO BUENO de un profesional con `record:protected` (PD-061), en su
--    tabla: uno por solicitud de copia, de sólo inserción, y si incluye el
--    tamizaje de violencia en la copia.
--
-- Sin relleno. `data_subject_request_copy_period_required` nace NOT VALID: una
-- copia respondida «Atendida en parte» antes de hoy no tiene periodo, y hasta
-- hoy esa respuesta no entregaba nada (DOC-118); la regla vale para toda fila
-- nueva o modificada.
--
-- PARA DESHACERLA: borrar la tabla `clinical_record_copy_review`, las
-- columnas y restricciones nuevas, el tipo `data_request_relationship`, el
-- disparador de la rectificación y restaurar la función
-- `data_subject_request_only_answered_once` de
-- `20261010130000_privacy_clinical_record_copy`.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. El periodo de la autorización (PD-059)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "data_subject_request"
  ADD COLUMN "copy_from" DATE,
  ADD COLUMN "copy_to"   DATE;

ALTER TABLE "data_subject_request"
  -- Las dos o ninguna, ordenadas, y sólo en una copia «Atendida en parte».
  ADD CONSTRAINT "data_subject_request_copy_period_shape" CHECK (
    ("copy_from" IS NULL) = ("copy_to" IS NULL)
    AND ("copy_from" IS NULL OR (
      "clinical_record_copy"
      AND "outcome" = 'PARTIALLY_GRANTED'
      AND "copy_from" <= "copy_to"
    ))
  ),
  -- Una copia «Atendida en parte» dice qué parte.
  ADD CONSTRAINT "data_subject_request_copy_period_required" CHECK (
    NOT ("clinical_record_copy" AND "outcome" = 'PARTIALLY_GRANTED')
    OR "copy_from" IS NOT NULL
  ) NOT VALID;

ALTER TABLE "data_subject_answer_correction"
  ADD COLUMN "copy_from" DATE,
  ADD COLUMN "copy_to"   DATE;

ALTER TABLE "data_subject_answer_correction"
  ADD CONSTRAINT "data_subject_answer_correction_copy_period_shape" CHECK (
    ("copy_from" IS NULL) = ("copy_to" IS NULL)
    AND ("copy_from" IS NULL OR (
      "outcome" = 'PARTIALLY_GRANTED' AND "copy_from" <= "copy_to"
    ))
  );

-- La rectificación no ve en su fila si la solicitud es de copia: lo mira aquí.
CREATE OR REPLACE FUNCTION data_subject_answer_correction_copy_period()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  is_copy BOOLEAN;
BEGIN
  SELECT "clinical_record_copy" INTO is_copy
    FROM "data_subject_request" WHERE "id" = NEW."request_id";
  IF (NEW."copy_from" IS NOT NULL AND NOT coalesce(is_copy, false))
     OR (coalesce(is_copy, false)
         AND NEW."outcome" = 'PARTIALLY_GRANTED'
         AND NEW."copy_from" IS NULL) THEN
    RAISE EXCEPTION 'data_subject_answer_correction_copy_period: a copy answered in part names its period, and only a copy has one'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'data_subject_answer_correction_copy_period',
            HINT = 'PD-059.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_data_subject_answer_correction_copy_period"
  BEFORE INSERT ON "data_subject_answer_correction"
  FOR EACH ROW
  EXECUTE FUNCTION data_subject_answer_correction_copy_period();

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. El parentesco del familiar (PD-063)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE "data_request_relationship" AS ENUM (
  'SPOUSE',
  'PARTNER',
  'PARENT',
  'CHILD',
  'SIBLING',
  'GRANDPARENT',
  'GRANDCHILD',
  'PARENT_IN_LAW',
  'CHILD_IN_LAW',
  'STEPCHILD',
  'STEPPARENT'
);

ALTER TABLE "data_subject_request"
  ADD COLUMN "requester_relationship" "data_request_relationship";

-- Sólo el familiar, y en una solicitud nueva siempre (las de antes de hoy no
-- lo tienen: NOT VALID la deja para las filas nuevas o modificadas).
ALTER TABLE "data_subject_request"
  ADD CONSTRAINT "data_subject_request_relationship_only_relative" CHECK (
    "requester_relationship" IS NULL OR "requested_by" = 'DECEASED_RELATIVE'
  ),
  ADD CONSTRAINT "data_subject_request_relationship_required" CHECK (
    "requested_by" <> 'DECEASED_RELATIVE' OR "requester_relationship" IS NOT NULL
  ) NOT VALID;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Lo que no cambia al editar ni al responder (PD-038, PD-046, PD-053,
--    PD-063): ahora también el parentesco; y el periodo sólo con la respuesta
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION data_subject_request_only_answered_once()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."outcome" IS NOT NULL THEN
    RAISE EXCEPTION 'data_subject_request % is already answered', OLD."id"
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Una solicitud respondida no se modifica; su respuesta se rectifica (PD-047).';
  END IF;
  IF NEW."id"                        IS DISTINCT FROM OLD."id"
     OR NEW."patient_id"             IS DISTINCT FROM OLD."patient_id"
     OR NEW."requested_by"           IS DISTINCT FROM OLD."requested_by"
     OR NEW."requester_name"         IS DISTINCT FROM OLD."requester_name"
     OR NEW."requester_document"     IS DISTINCT FROM OLD."requester_document"
     OR NEW."requester_relationship" IS DISTINCT FROM OLD."requester_relationship"
     OR NEW."clinical_record_copy"   IS DISTINCT FROM OLD."clinical_record_copy"
     OR NEW."documents_checked"      IS DISTINCT FROM OLD."documents_checked"
     OR NEW."registered_at"          IS DISTINCT FROM OLD."registered_at"
     OR NEW."registered_by"          IS DISTINCT FROM OLD."registered_by" THEN
    RAISE EXCEPTION 'data_subject_request_only_answered_once: a request never changes its patient, who presents it, whether it asks for the copy of the record or who registered it'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'PD-038, PD-046, PD-053, PD-063.';
  END IF;
  -- Responder: nada de lo registrado se mueve con la respuesta.
  IF NEW."outcome" IS NOT NULL
     AND (NEW."right"          IS DISTINCT FROM OLD."right"
          OR NEW."description" IS DISTINCT FROM OLD."description"
          OR NEW."received_at" IS DISTINCT FROM OLD."received_at"
          OR NEW."due_at"      IS DISTINCT FROM OLD."due_at") THEN
    RAISE EXCEPTION 'data_subject_request admits only its answer'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Lo registrado y su vencimiento no cambian al responder (PD-032, PD-038).';
  END IF;
  RETURN NEW;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. El visto bueno del profesional (PD-061)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "clinical_record_copy_review" (
  "request_id"         UUID        NOT NULL,
  -- D-203 §6. «Incluir el tamizaje en la copia».
  "includes_screening" BOOLEAN     NOT NULL DEFAULT false,
  "reviewed_at"        TIMESTAMPTZ(6) NOT NULL,
  "reviewed_by"        UUID        NOT NULL,

  CONSTRAINT "clinical_record_copy_review_pkey" PRIMARY KEY ("request_id"),
  CONSTRAINT "clinical_record_copy_review_request_fkey"
    FOREIGN KEY ("request_id") REFERENCES "data_subject_request" ("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "clinical_record_copy_review_reviewer_fkey"
    FOREIGN KEY ("reviewed_by") REFERENCES "app_user" ("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- Sólo de una solicitud de copia.
CREATE OR REPLACE FUNCTION clinical_record_copy_review_of_copy()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM "data_subject_request"
        WHERE "id" = NEW."request_id" AND "clinical_record_copy") THEN
    RAISE EXCEPTION 'clinical_record_copy_review_of_copy: only a request for the copy of the clinical record is reviewed'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'clinical_record_copy_review_of_copy',
            HINT = 'PD-061.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_clinical_record_copy_review_of_copy"
  BEFORE INSERT ON "clinical_record_copy_review"
  FOR EACH ROW
  EXECUTE FUNCTION clinical_record_copy_review_of_copy();

CREATE TRIGGER "trg_clinical_record_copy_review_immutable"
  BEFORE UPDATE OR DELETE ON "clinical_record_copy_review"
  FOR EACH ROW EXECUTE FUNCTION privacy_insert_only();
CREATE TRIGGER "trg_clinical_record_copy_review_no_truncate"
  BEFORE TRUNCATE ON "clinical_record_copy_review"
  FOR EACH STATEMENT EXECUTE FUNCTION privacy_insert_only();
