-- document_render_credit_note
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy


-- QUÉ GARANTIZA (SRI-089, DOC-003): que el RIDE archivado de una nota de
-- crédito apunte a SU nota de crédito con una clave foránea real, y que la
-- base siga exigiendo exactamente un sujeto por fila y que ese sujeto sea el
-- de su clase. Sin la quinta columna habría que guardar la nota de crédito en
-- `invoice_id` —un RIDE que dice ser de la factura que corrige— o abrir un par
-- polimórfico sin clave foránea, que es lo que DOC-003 rechaza.
--
-- `ON DELETE RESTRICT` como las otras cuatro: una nota de crédito no se borra
-- (`credit_note_immutable`), y el archivo no puede quedarse apuntando a nada.

ALTER TABLE "document_render" ADD COLUMN IF NOT EXISTS "credit_note_id" UUID;

ALTER TABLE "document_render" DROP CONSTRAINT IF EXISTS "document_render_credit_note_fk";
ALTER TABLE "document_render" ADD CONSTRAINT "document_render_credit_note_fk"
  FOREIGN KEY ("credit_note_id") REFERENCES "credit_note"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Como `document_render_by_invoice`: el historial de un sujeto se busca por él.
CREATE INDEX IF NOT EXISTS "document_render_by_credit_note"
  ON "document_render"("credit_note_id");

-- DOC-003. EXACTAMENTE UN SUJETO, ahora entre cinco columnas.
ALTER TABLE "document_render" DROP CONSTRAINT IF EXISTS "document_render_one_subject";
ALTER TABLE "document_render"
  ADD CONSTRAINT "document_render_one_subject"
  CHECK (num_nonnulls("prescription_id", "service_order_id", "certificate_id",
                      "invoice_id", "credit_note_id") = 1);

-- DOC-003. Y EL SUJETO CONCUERDA CON LA CLASE: un CREDIT_NOTE_RIDE que
-- apuntara a una factura cumpliría todas las claves foráneas y mentiría sobre
-- lo que contiene el fichero. ENCOUNTER_SUMMARY sigue sin cláusula: nunca se
-- archiva (DOC-111).
ALTER TABLE "document_render" DROP CONSTRAINT IF EXISTS "document_render_kind_matches_subject";
ALTER TABLE "document_render"
  ADD CONSTRAINT "document_render_kind_matches_subject"
  CHECK (
    ("kind" = 'PRESCRIPTION'        AND "prescription_id"  IS NOT NULL) OR
    ("kind" = 'SERVICE_ORDER'       AND "service_order_id" IS NOT NULL) OR
    ("kind" = 'MEDICAL_CERTIFICATE' AND "certificate_id"   IS NOT NULL) OR
    ("kind" = 'INVOICE_RIDE'        AND "invoice_id"       IS NOT NULL) OR
    ("kind" = 'CREDIT_NOTE_RIDE'    AND "credit_note_id"   IS NOT NULL)
  );

-- DOC-009. La sucesión coherente compara el sujeto entero: sin la quinta
-- columna, el RIDE de una nota de crédito podría anular el de otra.
CREATE OR REPLACE FUNCTION document_render_supersession_is_coherent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  superseded document_render%ROWTYPE;
BEGIN
  IF NEW.supersedes_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO superseded FROM document_render WHERE id = NEW.supersedes_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_render_supersession_is_coherent: superseded render % does not exist', NEW.supersedes_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF superseded.kind <> NEW.kind
     OR superseded.prescription_id  IS DISTINCT FROM NEW.prescription_id
     OR superseded.service_order_id IS DISTINCT FROM NEW.service_order_id
     OR superseded.certificate_id   IS DISTINCT FROM NEW.certificate_id
     OR superseded.invoice_id       IS DISTINCT FROM NEW.invoice_id
     OR superseded.credit_note_id   IS DISTINCT FROM NEW.credit_note_id THEN
    RAISE EXCEPTION
      'document_render_supersession_is_coherent: a render may only supersede one of the same kind and subject'
      USING ERRCODE = 'check_violation',
            HINT = 'DOC-009. Annulling is emitting a new document OF THE SAME '
                   'act; superseding across subjects would leave the archive '
                   'unable to say which document is current.';
  END IF;

  RETURN NEW;
END;
$$;
