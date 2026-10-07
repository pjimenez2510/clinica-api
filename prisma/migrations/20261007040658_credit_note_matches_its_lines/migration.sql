-- credit_note_matches_its_lines
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
-- Revisión de fix/corregir-factura (I-2, S-2)
-- ═══════════════════════════════════════════════════════════════════════════
--
--   1. BI-210. La cabecera de la nota de crédito cuadra con SUS LÍNEAS, y
--      tiene al menos una. `credit_note_total_is_consistent` solo mira la
--      coherencia interna de la cabecera: una nota escrita por debajo con
--      una cabecera que no suma sus líneas quedaba admitida y luego el XML
--      la rechazaba (`assertTotals`), atascada sin comprobante. Diferido al
--      final de la transacción, porque la cabecera se escribe antes que sus
--      líneas.
--   2. BI-214. Lo acreditado con «Servicio no prestado» no vuelve a la
--      cuenta: el disparador que admite una copia `CORRECTION` mira ahora el
--      motivo de la nota que acreditó el cargo.
--
-- No toca filas: `credit_note` no tiene ninguna fuera de esta rama.

CREATE OR REPLACE FUNCTION credit_note_matches_its_lines()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  header RECORD;
  sums   RECORD;
BEGIN
  SELECT "subtotal_taxed", "subtotal_untaxed", "discount_total", "tax_total"
    INTO header
    FROM "credit_note" WHERE "id" = NEW."id";
  SELECT count(*) AS lines,
         coalesce(sum("net_amount"), 0) AS net,
         coalesce(sum("tax_amount"), 0) AS tax,
         coalesce(sum("discount_amount"), 0) AS discount
    INTO sums
    FROM "credit_note_line" WHERE "credit_note_id" = NEW."id";
  IF sums.lines = 0
     OR sums.net <> header."subtotal_taxed" + header."subtotal_untaxed" - header."discount_total"
     OR sums.tax <> header."tax_total"
     OR sums.discount <> header."discount_total" THEN
    RAISE EXCEPTION 'credit_note_matches_its_lines: the credit note does not add up to its lines'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'credit_note_matches_its_lines',
            HINT = 'Una nota de crédito suma sus líneas, y tiene al menos una.';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "trg_credit_note_matches_its_lines" ON "credit_note";
CREATE CONSTRAINT TRIGGER "trg_credit_note_matches_its_lines"
  AFTER INSERT ON "credit_note"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION credit_note_matches_its_lines();

CREATE OR REPLACE FUNCTION charge_item_corrects_a_credited_charge()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM "credit_note_line" l
      JOIN "credit_note" n ON n."id" = l."credit_note_id"
     WHERE l."charge_item_id" = NEW."corrects_charge_item_id"
       AND n."reason_code" <> 'SERVICE_NOT_PROVIDED'
  ) THEN
    RAISE EXCEPTION 'charge_item_corrects_a_credited_charge: only a charge credited to be billed again comes back'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'charge_item_corrects_a_credited_charge',
            HINT = 'Sólo vuelve a facturarse lo que una nota de crédito acreditó para corregirlo; «Servicio no prestado» no vuelve.';
  END IF;
  RETURN NEW;
END;
$$;
