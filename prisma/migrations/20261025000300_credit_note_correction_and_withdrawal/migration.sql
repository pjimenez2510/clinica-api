-- credit_note_correction_and_withdrawal
--
-- Escrito a mano (scripts/new-migration.mts).
--
-- D-212 §2 (D-223). LA NOTA DE CRÉDITO QUE EL SRI RECHAZA.
--
-- Hasta hoy una nota devuelta o no autorizada sólo se reenviaba tal cual, y
-- sus líneas quedaban tomadas para siempre: `credit_note_line_one_per_charge`
-- no deja acreditar otra vez un cargo, y las copias por facturar de BI-214
-- esperaban una autorización que no iba a llegar.
--
-- 1. BI-303, SRI-103. Mientras está `REJECTED`, su MOTIVO se corrige —lo único
--    de la nota que no sale de la factura que modifica— y se reenvía con su
--    clave. Sin pasar entre «Servicio no prestado» y los motivos que vuelven a
--    facturar: eso decidió si hay copias (BI-214). La fila anterior va a
--    `record_version` con quién y cuándo.
--
-- 2. BI-304, SRI-104. Si no tiene remedio, una persona DESISTE de ella:
--    `WITHDRAWN`, con su motivo. En la misma transacción la aplicación quita
--    las copias por facturar y BORRA SUS LÍNEAS, que se archivan enteras en
--    `record_version`: una nota que el SRI nunca autorizó no acredita nada, y
--    sólo así sus cargos admiten otra nota. La cabecera queda, con su número
--    y su clave. Una desistida no vuelve a ningún estado.
--
-- 3. Una copia QUITADA ya no ocupa su cargo (`charge_item_one_correction_per_charge`):
--    la nota siguiente sobre ese cargo deja la suya. Mientras la nota viva,
--    su línea ya impide una segunda nota, y por tanto una segunda copia.
BEGIN;

ALTER TABLE "credit_note"
  ADD COLUMN "changed_by" UUID,
  ADD COLUMN "changed_at" TIMESTAMPTZ(6),
  ADD COLUMN "withdrawal_reason" VARCHAR(300);

ALTER TABLE "credit_note"
  ADD CONSTRAINT "credit_note_changed_by_fkey"
    FOREIGN KEY ("changed_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "credit_note_change_stamped"
    CHECK (("changed_by" IS NULL) = ("changed_at" IS NULL)),
  ADD CONSTRAINT "credit_note_withdrawal_says_why"
    CHECK (("status" = 'WITHDRAWN') = ("withdrawal_reason" IS NOT NULL
           AND length(btrim("withdrawal_reason")) > 0));

ALTER TABLE "credit_note" DROP CONSTRAINT "credit_note_status_is_known";
ALTER TABLE "credit_note"
  ADD CONSTRAINT "credit_note_status_is_known"
  CHECK ("status" IN ('DRAFT', 'ISSUED', 'AUTHORISED', 'REJECTED', 'WITHDRAWN'));

-- BI-212, BI-303, BI-304. Emitida, sólo se mueve lo que escribe `sri` (la
-- clave, una vez, y su estado ante el SRI), el motivo de una devuelta y el
-- desistimiento de una devuelta. Autorizada o desistida, nada.
CREATE OR REPLACE FUNCTION credit_note_is_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  reason_moves BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credit_note_immutable: a credit note is never deleted'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'credit_note_immutable',
            HINT = 'Una nota de crédito no se elimina.';
  END IF;

  reason_moves := (OLD."reason_code", OLD."reason")
                  IS DISTINCT FROM (NEW."reason_code", NEW."reason");

  IF (OLD."invoice_id", OLD."site_id", OLD."emission_point_id", OLD."sequential",
      OLD."amount", OLD."subtotal_taxed",
      OLD."subtotal_untaxed", OLD."discount_total", OLD."tax_total",
      OLD."buyer_identification_type", OLD."buyer_identification",
      OLD."buyer_name", OLD."buyer_email", OLD."issued_by_id", OLD."issued_at")
     IS DISTINCT FROM
     (NEW."invoice_id", NEW."site_id", NEW."emission_point_id", NEW."sequential",
      NEW."amount", NEW."subtotal_taxed",
      NEW."subtotal_untaxed", NEW."discount_total", NEW."tax_total",
      NEW."buyer_identification_type", NEW."buyer_identification",
      NEW."buyer_name", NEW."buyer_email", NEW."issued_by_id", NEW."issued_at")
     OR (OLD."access_key" IS NOT NULL AND NEW."access_key" IS DISTINCT FROM OLD."access_key")
     -- BI-303. Only a returned note's reason, staying returned, and never
     -- across «servicio no prestado».
     OR (reason_moves AND NOT (
           OLD."status" = 'REJECTED' AND NEW."status" = 'REJECTED'
           AND (OLD."reason_code" = 'SERVICE_NOT_PROVIDED')
             = (NEW."reason_code" = 'SERVICE_NOT_PROVIDED')))
     OR (NEW."withdrawal_reason" IS DISTINCT FROM OLD."withdrawal_reason"
         AND NOT (OLD."status" = 'REJECTED' AND NEW."status" = 'WITHDRAWN'))
     OR (OLD."status" IN ('AUTHORISED', 'WITHDRAWN') AND NEW."status" <> OLD."status")
     OR (NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
           (OLD."status" = 'ISSUED' AND NEW."status" IN ('AUTHORISED', 'REJECTED'))
        OR (OLD."status" = 'REJECTED' AND NEW."status" IN ('ISSUED', 'AUTHORISED', 'WITHDRAWN'))))
  THEN
    RAISE EXCEPTION 'credit_note_immutable: an issued credit note only records what the SRI says'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'credit_note_immutable',
            HINT = 'Una nota de crédito emitida no se modifica: sólo se corrige el motivo de una devuelta, o se desiste de ella.';
  END IF;
  RETURN NEW;
END;
$$;

-- Después del freno (orden alfabético de los BEFORE): lo rechazado no archiva.
CREATE TRIGGER "trg_credit_note_record_version"
  BEFORE UPDATE ON "credit_note"
  FOR EACH ROW
  WHEN (
    (OLD."reason_code", OLD."reason") IS DISTINCT FROM (NEW."reason_code", NEW."reason")
    OR (NEW."status" = 'WITHDRAWN' AND OLD."status" <> 'WITHDRAWN')
  )
  EXECUTE FUNCTION record_version_archive('changed_by', 'changed_at', 'id');

-- BI-212, BI-304. Las líneas no cambian; sólo se borran las de una nota
-- desistida, y entonces se archivan enteras con el sello del desistimiento.
CREATE OR REPLACE FUNCTION credit_note_line_is_permanent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  note RECORD;
  next_version INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT "status", "changed_by", "changed_at" INTO note
      FROM "credit_note" WHERE "id" = OLD."credit_note_id";
    IF note."status" = 'WITHDRAWN' THEN
      SELECT coalesce(max("version"), 0) + 1 INTO next_version
        FROM "record_version"
       WHERE "resource_type" = 'credit_note_line' AND "resource_id" = OLD."id";
      INSERT INTO "record_version"
        ("resource_type", "resource_id", "version", "data", "changed_by", "changed_at")
      VALUES ('credit_note_line', OLD."id", next_version, to_jsonb(OLD),
              note."changed_by", note."changed_at");
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'credit_note_immutable: a credit note line never changes'
    USING ERRCODE = 'check_violation',
          CONSTRAINT = 'credit_note_immutable',
          HINT = 'Una nota de crédito emitida no se modifica: sólo se liberan las líneas de una desistida.';
END;
$$;

-- BI-095. Lo acreditado no supera la factura; una desistida no acredita nada.
CREATE OR REPLACE FUNCTION credit_note_within_its_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  invoice_total DECIMAL(12, 2);
  credited      DECIMAL(12, 2);
BEGIN
  SELECT "total" INTO invoice_total
    FROM "invoice" WHERE "id" = NEW."invoice_id" FOR UPDATE;
  SELECT coalesce(sum("amount"), 0) INTO credited
    FROM "credit_note"
   WHERE "invoice_id" = NEW."invoice_id" AND "status" <> 'WITHDRAWN';
  IF credited > invoice_total THEN
    RAISE EXCEPTION 'credit_note_exceeds_invoice: % credited over an invoice of %', credited, invoice_total
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'credit_note_exceeds_invoice',
            HINT = 'Lo acreditado no puede superar el total de la factura.';
  END IF;
  RETURN NULL;
END;
$$;

DROP INDEX "charge_item_one_correction_per_charge";
CREATE UNIQUE INDEX "charge_item_one_correction_per_charge"
  ON "charge_item" ("corrects_charge_item_id")
  WHERE "corrects_charge_item_id" IS NOT NULL AND "status" <> 'CANCELLED';

COMMIT;
