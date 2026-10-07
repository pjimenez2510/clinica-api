-- corrections_wait_for_the_sri
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

--
-- ═══════════════════════════════════════════════════════════════════════════
-- Revisión clínica de fix/corregir-factura (C1, C2, menores)
-- ═══════════════════════════════════════════════════════════════════════════
--
--   1. C1. Lo acreditado vuelve a la cuenta al emitir la nota de crédito,
--      pero NO SE FACTURA hasta que el SRI la autoriza: si la nota no se
--      autorizara, el servicio quedaría en dos facturas válidas. La copia
--      `CORRECTION` no pasa a BILLED mientras la nota que acreditó su cargo
--      no esté AUTHORISED. Qué hacer con una nota que nunca se autoriza es
--      D-152.7, del autor y del contador.
--   2. C2. Una factura autorizada no sale de AUTHORISED más que hacia
--      VOIDED: `trg_invoice_immutable` congelaba sus columnas pero no su
--      estado, y dos sentencias —a REJECTED y luego el receptor— la editaban.
--      Y el receptor solo se corrige si además su comprobante está devuelto
--      o no autorizado por el SRI.
--   3. BI-213. Consumidor Final se reconoce también por su identificación
--      `9999999999999`, no solo por la marca.
--
-- No toca filas.

CREATE OR REPLACE FUNCTION invoice_authorised_only_voids()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'invoice_authorised_is_immutable: an authorised invoice only moves to VOIDED'
    USING ERRCODE = 'check_violation',
          HINT = 'Una factura autorizada por el SRI no se modifica: se corrige con nota de credito.';
END;
$$;

DROP TRIGGER IF EXISTS "trg_invoice_authorised_only_voids" ON "invoice";
CREATE TRIGGER "trg_invoice_authorised_only_voids"
  BEFORE UPDATE OF "status" ON "invoice"
  FOR EACH ROW
  WHEN (OLD."status" = 'AUTHORISED' AND NEW."status" NOT IN ('AUTHORISED', 'VOIDED'))
  EXECUTE FUNCTION invoice_authorised_only_voids();

CREATE OR REPLACE FUNCTION invoice_receiver_editable_only_when_rejected()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" <> 'REJECTED' OR NOT EXISTS (
    SELECT 1 FROM "electronic_voucher"
     WHERE "invoice_id" = OLD."id"
       AND "status" IN ('RETURNED', 'NOT_AUTHORISED')
  ) THEN
    RAISE EXCEPTION 'invoice_receiver_editable_only_when_rejected: only an invoice the SRI did not accept is corrected'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'invoice_receiver_editable_only_when_rejected',
            HINT = 'Sólo la factura devuelta o no autorizada por el SRI se corrige y se reenvía.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION charge_item_correction_awaits_its_credit_note()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM "credit_note_line" l
      JOIN "credit_note" n ON n."id" = l."credit_note_id"
     WHERE l."charge_item_id" = NEW."corrects_charge_item_id"
       AND n."status" = 'AUTHORISED'
  ) THEN
    RAISE EXCEPTION 'charge_item_correction_awaits_credit_note: what a credit note credited is billed again once the SRI authorises it'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'charge_item_correction_awaits_credit_note',
            HINT = 'Lo acreditado se vuelve a facturar cuando el SRI autoriza la nota de crédito.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_charge_item_correction_awaits_credit_note" ON "charge_item";
CREATE TRIGGER "trg_charge_item_correction_awaits_credit_note"
  BEFORE UPDATE OF "status" ON "charge_item"
  FOR EACH ROW
  WHEN (NEW."status" = 'BILLED' AND NEW."corrects_charge_item_id" IS NOT NULL)
  EXECUTE FUNCTION charge_item_correction_awaits_its_credit_note();

CREATE OR REPLACE FUNCTION credit_note_credits_an_authorised_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  credited RECORD;
BEGIN
  SELECT "status", "is_final_consumer", "buyer_identification" INTO credited
    FROM "invoice" WHERE "id" = NEW."invoice_id";
  IF credited."is_final_consumer"
     OR credited."buyer_identification" = '9999999999999' THEN
    RAISE EXCEPTION 'credit_note_final_consumer: an invoice to «consumidor final» admits no credit note'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'credit_note_final_consumer',
            HINT = 'Consumidor Final no admite nota de crédito.';
  END IF;
  IF credited."status" <> 'AUTHORISED' THEN
    RAISE EXCEPTION 'credit_note_invoice_not_authorised: only an authorised invoice is credited'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'credit_note_invoice_not_authorised',
            HINT = 'Sólo una factura autorizada por el SRI se corrige con nota de crédito.';
  END IF;
  RETURN NEW;
END;
$$;
