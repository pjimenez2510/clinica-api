-- invoice_chart_of_record
--
-- Escrito a mano (scripts/new-migration.mts).
--
-- BI-302 (D-169 §2 l, D-223). QUÉ FICHA NOMBRA EL RIDE DE UNA FACTURA.
--
-- La fusión no mueve nada (D-031): la cuenta de una ficha duplicada que se
-- unificó con la real sigue colgando de la duplicada, cuyo documento pasó a la
-- vigente (PA-043). El RIDE de la factura emitida desde ella salía con el
-- nombre de la duplicada y sin cédula. Con el criterio del 117 y de la orden
-- (CER-057, ORD-161, `20261008000000_paper_chart_of_record`): la factura guarda
-- al emitirse LA FICHA QUE NOMBRA —la vigente de la ficha de su cuenta en ese
-- instante—, la escribe la BASE y no cambia después, ni al unificar más tarde
-- ni al deshacer la unificación.
--
-- La factura nace `ISSUED` (nunca `DRAFT`), así que basta la inserción.
--
-- LAS YA EMITIDAS nombraban la ficha de su cuenta, que es lo que el RIDE leía:
-- se rellenan con ella. `trg_invoice_immutable` compara columnas con nombre y
-- ésta no está entre ellas; el freno nuevo se crea después del relleno.
BEGIN;

ALTER TABLE "invoice" ADD COLUMN "chart_of_record_id" UUID;

UPDATE "invoice" i
   SET "chart_of_record_id" = a.patient_id
  FROM patient_account a
 WHERE a.id = i.account_id;

ALTER TABLE "invoice" ALTER COLUMN "chart_of_record_id" SET NOT NULL;
ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_chart_of_record_fk"
  FOREIGN KEY ("chart_of_record_id") REFERENCES "patient"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- La ficha la escribe la base, mande lo que mande quien emite: la vigente de
-- la ficha de la cuenta, un nivel y nunca una cadena (PA-046).
CREATE OR REPLACE FUNCTION invoice_freeze_chart_of_record()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT COALESCE(chart.merged_into_id, chart.id)
    INTO NEW.chart_of_record_id
    FROM patient_account a
    JOIN patient chart ON chart.id = a.patient_id
   WHERE a.id = NEW.account_id;
  RETURN NEW;
END;
$$;

-- «a_» para correr antes que el resto de disparadores de inserción.
CREATE TRIGGER "a_invoice_freeze_chart_of_record"
  BEFORE INSERT ON "invoice"
  FOR EACH ROW
  EXECUTE FUNCTION invoice_freeze_chart_of_record();

CREATE OR REPLACE FUNCTION invoice_chart_of_record_frozen()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'invoice_chart_of_record_frozen: the chart an invoice names is fixed when it is issued'
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'BI-302.';
END;
$$;

CREATE TRIGGER "invoice_chart_of_record_frozen"
  BEFORE UPDATE OF "chart_of_record_id" ON "invoice"
  FOR EACH ROW
  WHEN (NEW."chart_of_record_id" IS DISTINCT FROM OLD."chart_of_record_id")
  EXECUTE FUNCTION invoice_chart_of_record_frozen();

COMMIT;
