-- credit_note_review_fixes
--
-- Escrito a mano (scripts/new-migration.mts). Revisión en contexto limpio de
-- feat/d223-caja-sri.
--
-- 1. SRI-104. El comprobante de una nota de crédito DESISTIDA no vuelve a
--    salir: «Reenviar» y «Desistir» a la vez dejaban reabrir y enviar al SRI
--    una nota que la clínica ya no cuenta (doble crédito posible). La
--    aplicación lo comprueba bajo bloqueo; la base lo garantiza.
--
-- 2. BI-303, BI-304. Quién corrigió o desistió (`changed_by`, `changed_at`)
--    sólo cambia con el motivo o con el desistimiento: lo demás lo reescribía
--    sin dejar versión.
--
-- 3. BI-303 (D-152.8, D-236). «Error en los datos del receptor» también es una
--    frontera: al emitir deja la nota sin correo del receptor equivocado; pasar
--    a ese motivo, o salir de él, al corregir, cambiaría a quién se envía.
--
-- 4. SRI-098. El aviso de correos atascados tiene su índice: los autorizados
--    crecen sin tope con los años.
BEGIN;

CREATE OR REPLACE FUNCTION electronic_voucher_withdrawn_note_stays()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "credit_note"
              WHERE "id" = NEW."credit_note_id" AND "status" = 'WITHDRAWN') THEN
    RAISE EXCEPTION 'electronic_voucher_withdrawn_note_stays: the voucher of a withdrawn credit note is not sent again'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'electronic_voucher_withdrawn_note_stays',
            HINT = 'SRI-104.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "electronic_voucher_withdrawn_note_stays"
  BEFORE UPDATE OF "status" ON "electronic_voucher"
  FOR EACH ROW
  WHEN (NEW."credit_note_id" IS NOT NULL AND NEW."status" IS DISTINCT FROM OLD."status")
  EXECUTE FUNCTION electronic_voucher_withdrawn_note_stays();

CREATE OR REPLACE FUNCTION credit_note_is_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  reason_moves BOOLEAN;
  withdrawn_now BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credit_note_immutable: a credit note is never deleted'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'credit_note_immutable',
            HINT = 'Una nota de crédito no se elimina.';
  END IF;

  reason_moves := (OLD."reason_code", OLD."reason")
                  IS DISTINCT FROM (NEW."reason_code", NEW."reason");
  withdrawn_now := OLD."status" = 'REJECTED' AND NEW."status" = 'WITHDRAWN';

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
     -- across «servicio no prestado» or «datos del receptor».
     OR (reason_moves AND NOT (
           OLD."status" = 'REJECTED' AND NEW."status" = 'REJECTED'
           AND (OLD."reason_code" = 'SERVICE_NOT_PROVIDED')
             = (NEW."reason_code" = 'SERVICE_NOT_PROVIDED')
           AND (OLD."reason_code" = 'RECEIVER_DATA')
             = (NEW."reason_code" = 'RECEIVER_DATA')))
     OR (NEW."withdrawal_reason" IS DISTINCT FROM OLD."withdrawal_reason"
         AND NOT withdrawn_now)
     -- Who corrected or withdrew moves only with what they did.
     OR ((NEW."changed_by", NEW."changed_at") IS DISTINCT FROM (OLD."changed_by", OLD."changed_at")
         AND NOT (reason_moves OR withdrawn_now))
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

CREATE INDEX "electronic_voucher_failed_delivery"
  ON "electronic_voucher" ("site_id", "authorised_at")
  WHERE "delivery_status" = 'FAILED';

COMMIT;
