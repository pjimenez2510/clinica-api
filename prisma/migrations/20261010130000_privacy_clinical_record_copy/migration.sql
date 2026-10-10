-- privacy_clinical_record_copy
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio. Ver scripts/new-migration.mts.
--
-- PD-052 a PD-054 (D-198 §1, A.M. 5216 arts. 28 a 33). La solicitud de acceso
-- es también el registro de la entrega de la historia clínica (EN-033):
--
-- 1. QUIEN LA PRESENTA tiene un enum propio, `data_request_party`, con los
--    terceros del art. 28 (apoderado, persona autorizada, autoridad, familiar
--    del fallecido). El consentimiento sigue con `data_subject_party`: sólo
--    el titular o su representante consienten.
-- 2. LA COPIA DE LA HISTORIA es una solicitud de acceso marcada, con la
--    casilla de la solicitud firmada y la copia de la cédula, y el nombre y
--    el documento de quien no es el titular. Un tercero sólo pide la copia.
-- 3. EL VENCIMIENTO ES UN INSTANTE (`due_at`): la copia vence a las 48 horas
--    (art. 30) y una fecha no puede decir la hora. Los ya fijados pasan al
--    final de su día en America/Guayaquil, que es el mismo vencimiento.
--
-- Sin relleno: `ALTER COLUMN ... TYPE` reescribe la tabla sin disparar los
-- disparadores de fila, y las columnas nuevas nacen con su valor por defecto.
--
-- PARA DESHACERLA: volver `due_at` a `due_on` con
-- `((due_at - interval '1 microsecond') AT TIME ZONE 'America/Guayaquil')::date`,
-- quitar las columnas y las restricciones nuevas, devolver `requested_by` a
-- `data_subject_party` (fallará si hay terceros) y restaurar la función de
-- `20261006084539_privacy_corrections`.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Quien presenta (PD-052)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE "data_request_party" AS ENUM (
  'HOLDER',
  'REPRESENTATIVE',
  'ATTORNEY',
  'AUTHORIZED_PERSON',
  'AUTHORITY',
  'DECEASED_RELATIVE'
);

ALTER TABLE "data_subject_request"
  ALTER COLUMN "requested_by" TYPE "data_request_party"
    USING "requested_by"::text::"data_request_party";

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. La copia de la historia clínica (PD-052, PD-053)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "data_subject_request"
  ADD COLUMN "clinical_record_copy" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "documents_checked"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "requester_name"       TEXT,
  ADD COLUMN "requester_document"   TEXT;

ALTER TABLE "data_subject_request"
  -- PD-053. La copia es del derecho de acceso.
  ADD CONSTRAINT "data_subject_request_copy_is_access" CHECK (
    NOT "clinical_record_copy" OR "right" = 'ACCESS'
  ),
  -- PD-053. La solicitud firmada y la copia de la cédula, en la mano.
  ADD CONSTRAINT "data_subject_request_copy_documents_checked" CHECK (
    NOT "clinical_record_copy" OR "documents_checked"
  ),
  -- PD-052. Un tercero pide la copia, no ejerce los derechos del titular.
  ADD CONSTRAINT "data_subject_request_third_party_copy_only" CHECK (
    "requested_by" IN ('HOLDER', 'REPRESENTATIVE') OR "clinical_record_copy"
  ),
  -- PD-052. Quien no es el titular y pide la copia, con nombre y documento.
  ADD CONSTRAINT "data_subject_request_requester_named" CHECK (
    "requested_by" = 'HOLDER'
    OR NOT "clinical_record_copy"
    OR ("requester_name" IS NOT NULL AND "requester_document" IS NOT NULL)
  ),
  ADD CONSTRAINT "data_subject_request_requester_valid" CHECK (
    ("requester_name" IS NULL
      OR (btrim("requester_name") <> '' AND char_length("requester_name") <= 200))
    AND ("requester_document" IS NULL
      OR (btrim("requester_document") <> '' AND char_length("requester_document") <= 200))
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. El vencimiento, un instante (PD-054)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "data_subject_request"
  DROP CONSTRAINT "data_subject_request_due_after_receipt";
DROP INDEX "data_subject_request_open_by_due";

-- El final del día clínico que se fijó: las 00:00 del día siguiente en
-- America/Guayaquil. Vencida es «ahora ≥ due_at», lo mismo que antes era
-- «due_on < hoy».
ALTER TABLE "data_subject_request"
  ALTER COLUMN "due_on" TYPE TIMESTAMPTZ(6)
    USING (("due_on" + 1)::timestamp AT TIME ZONE 'America/Guayaquil');
ALTER TABLE "data_subject_request" RENAME COLUMN "due_on" TO "due_at";

ALTER TABLE "data_subject_request"
  ADD CONSTRAINT "data_subject_request_due_after_receipt" CHECK (
    "due_at" > "received_at"
  );

-- PD-035, PD-054. Las abiertas por vencimiento; las respondidas no entran.
CREATE INDEX "data_subject_request_open_by_due"
  ON "data_subject_request" ("due_at")
  WHERE "outcome" IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Lo que no cambia al editar ni al responder (PD-038, PD-046, PD-053)
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
  IF NEW."id"                      IS DISTINCT FROM OLD."id"
     OR NEW."patient_id"           IS DISTINCT FROM OLD."patient_id"
     OR NEW."requested_by"         IS DISTINCT FROM OLD."requested_by"
     OR NEW."requester_name"       IS DISTINCT FROM OLD."requester_name"
     OR NEW."requester_document"   IS DISTINCT FROM OLD."requester_document"
     OR NEW."clinical_record_copy" IS DISTINCT FROM OLD."clinical_record_copy"
     OR NEW."documents_checked"    IS DISTINCT FROM OLD."documents_checked"
     OR NEW."registered_at"        IS DISTINCT FROM OLD."registered_at"
     OR NEW."registered_by"        IS DISTINCT FROM OLD."registered_by" THEN
    RAISE EXCEPTION 'data_subject_request_only_answered_once: a request never changes its patient, who presents it, whether it asks for the copy of the record or who registered it'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'PD-038, PD-046, PD-053.';
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
