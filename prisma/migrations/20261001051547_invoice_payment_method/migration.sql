-- BI-170, SRI-017, D-092 (resuelta, opción B): the payment method is a fact of
-- the invoice, asked of the cashier when issuing it — not a setting of the
-- installation. The SRI's Ficha v2.34 demands it in every voucher
-- (`pagos/pago/formaPago`, Tabla 24).
--
-- NULLABLE only for the invoices issued before this column existed; the
-- application demands it on every new one, and such an old invoice's voucher
-- waits unsigned with `NO_PAYMENT_METHOD` (SRI-017).
ALTER TABLE "invoice" ADD COLUMN "payment_method" CHAR(2);

ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_payment_method_is_known"
  CHECK ("payment_method" IS NULL
      OR "payment_method" IN ('01', '15', '16', '17', '18', '19', '20', '21'));

-- Once written, it does not change: the voucher declares it to the SRI, and an
-- invoice is not edited (BI-084, BI-090).
CREATE OR REPLACE FUNCTION trg_invoice_payment_method_is_permanent()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."payment_method" IS NOT NULL
     AND NEW."payment_method" IS DISTINCT FROM OLD."payment_method" THEN
    RAISE EXCEPTION 'invoice_payment_method_is_permanent'
      USING HINT = 'La forma de pago de una factura emitida no se cambia.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_payment_method_permanent
  BEFORE UPDATE OF "payment_method" ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION trg_invoice_payment_method_is_permanent();
