-- credit_note_and_corrections
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
-- billing/B14 y sri/S7: CORREGIR UNA FACTURA (inventario CA-8 y CA-9)
-- ═══════════════════════════════════════════════════════════════════════════
--
--   1. La nota de crédito de verdad (BI-209 a BI-213, BI-095): motivo de
--      lista que cabe en el XML, receptor y totales copiados de la factura,
--      sus líneas, y nada de eso cambia una vez emitida.
--   2. El comprobante electrónico es de una factura O de una nota de crédito
--      (SRI-086), con el tipo que le toca.
--   3. Lo acreditado vuelve a la cuenta como un cargo nuevo que dice qué
--      corrige (BI-214), una sola vez.
--   4. La cuenta guarda su versión anterior (BI-215, D-142.2).
--   5. La factura devuelta se edita, y sólo ella (BI-216, BI-217, D-093 B).
--
-- `credit_note` no tiene filas: ningún código la escribía hasta hoy. Si una
-- base las tuviera, el `NOT NULL` de las columnas nuevas lo dice al aplicar.
-- Ninguna fila existente de las demás tablas cambia: las columnas nuevas
-- nacen nulas, que es «nunca se corrigió».

-- ── 1. La nota de crédito ──────────────────────────────────────────────────

ALTER TABLE "credit_note"
  ADD COLUMN "site_id" UUID NOT NULL,
  ADD COLUMN "reason_code" VARCHAR(24) NOT NULL,
  ADD COLUMN "buyer_identification_type" VARCHAR(2) NOT NULL,
  ADD COLUMN "buyer_identification" VARCHAR(20) NOT NULL,
  ADD COLUMN "buyer_name" VARCHAR(300) NOT NULL,
  ADD COLUMN "buyer_email" VARCHAR(320),
  ADD COLUMN "subtotal_taxed" DECIMAL(12, 2) NOT NULL,
  ADD COLUMN "subtotal_untaxed" DECIMAL(12, 2) NOT NULL,
  ADD COLUMN "discount_total" DECIMAL(12, 2) NOT NULL,
  ADD COLUMN "tax_total" DECIMAL(12, 2) NOT NULL;

ALTER TABLE "credit_note"
  ALTER COLUMN "status" SET DEFAULT 'ISSUED',
  ADD CONSTRAINT "credit_note_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT,
  -- BI-209. El motivo de la lista o el texto de «Otro», y en los dos casos
  -- lo que va en `<motivo>`: el XSD lo exige de 1 a 300.
  ADD CONSTRAINT "credit_note_reason_code_is_known"
    CHECK ("reason_code" IN ('RECEIVER_DATA', 'AMOUNT', 'SERVICE_NOT_PROVIDED', 'OTHER')),
  ADD CONSTRAINT "credit_note_reason_fits_the_voucher"
    CHECK (btrim("reason") <> '' AND char_length("reason") <= 300),
  -- BI-210. Como `invoice_total_is_consistent`.
  ADD CONSTRAINT "credit_note_total_is_consistent"
    CHECK ("amount" = "subtotal_taxed" + "subtotal_untaxed" + "tax_total" - "discount_total"),
  ADD CONSTRAINT "credit_note_issued_states_its_instant"
    CHECK ("status" = 'DRAFT' OR "issued_at" IS NOT NULL),
  ADD CONSTRAINT "credit_note_authorised_carries_its_key"
    CHECK ("status" <> 'AUTHORISED' OR "access_key" IS NOT NULL);

CREATE INDEX "credit_note_by_invoice" ON "credit_note" ("invoice_id");
CREATE INDEX "credit_note_by_site" ON "credit_note" ("site_id", "issued_at" DESC);

-- Las líneas: cada una acredita un cargo ENTERO de la factura (D-152.6), con
-- sus valores congelados otra vez, porque es lo que dice el XML.
CREATE TABLE "credit_note_line" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "credit_note_id" UUID NOT NULL,
  "charge_item_id" UUID NOT NULL,

  "service_code"      VARCHAR(25) NOT NULL,
  "description"       VARCHAR(300) NOT NULL,
  "quantity"          DECIMAL(10, 3) NOT NULL,
  "unit_amount"       DECIMAL(12, 2) NOT NULL,
  "discount_amount"   DECIMAL(12, 2) NOT NULL,
  "tax_sri_code"      VARCHAR(4) NOT NULL,
  "tax_percentage"    DECIMAL(5, 2),
  "net_amount"        DECIMAL(12, 2) NOT NULL,
  "tax_amount"        DECIMAL(12, 2) NOT NULL,

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "credit_note_line_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_note_line_credit_note_fk"
    FOREIGN KEY ("credit_note_id") REFERENCES "credit_note"("id") ON DELETE RESTRICT,
  CONSTRAINT "credit_note_line_charge_fk"
    FOREIGN KEY ("charge_item_id") REFERENCES "charge_item"("id") ON DELETE RESTRICT,
  -- BI-211. Un cargo se acredita una vez. Con la línea entera, lo acreditado
  -- nunca suma más que la factura (BI-095), y aun así se comprueba abajo.
  CONSTRAINT "credit_note_line_one_per_charge" UNIQUE ("charge_item_id"),
  CONSTRAINT "credit_note_line_amounts_are_sane"
    CHECK ("quantity" > 0 AND "unit_amount" >= 0 AND "discount_amount" >= 0
       AND "net_amount" >= 0 AND "tax_amount" >= 0)
);

CREATE INDEX "credit_note_line_by_credit_note" ON "credit_note_line" ("credit_note_id");

-- BI-211. El cargo acreditado es de la factura que la nota de crédito
-- modifica. No cabe en una clave foránea: el cargo dice su factura y la nota
-- de crédito la suya, y la igualdad es entre dos filas distintas.
CREATE FUNCTION credit_note_line_belongs_to_its_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM "credit_note" cn
      JOIN "charge_item" ci ON ci."invoice_id" = cn."invoice_id"
     WHERE cn."id" = NEW."credit_note_id"
       AND ci."id" = NEW."charge_item_id"
  ) THEN
    RAISE EXCEPTION 'credit_note_line_not_in_invoice: the charge is not a line of the credited invoice'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'credit_note_line_not_in_invoice',
            HINT = 'Una nota de crédito acredita líneas de la factura que modifica.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_credit_note_line_belongs_to_its_invoice"
  BEFORE INSERT ON "credit_note_line"
  FOR EACH ROW EXECUTE FUNCTION credit_note_line_belongs_to_its_invoice();

-- BI-212. Las líneas no cambian ni se borran.
CREATE FUNCTION credit_note_line_is_permanent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'credit_note_immutable: a credit note line never changes'
    USING ERRCODE = 'check_violation',
          CONSTRAINT = 'credit_note_immutable',
          HINT = 'Una nota de crédito emitida no se modifica: se compensa con los documentos que la siguen.';
END;
$$;

CREATE TRIGGER "trg_credit_note_line_permanent"
  BEFORE UPDATE OR DELETE ON "credit_note_line"
  FOR EACH ROW EXECUTE FUNCTION credit_note_line_is_permanent();

-- BI-208, BI-213. Sólo se acredita una factura autorizada, y nunca la de
-- Consumidor Final (Res. NAC-DGERCGC25-00000014, art. 3: «no procede la
-- emisión de notas de crédito»).
CREATE FUNCTION credit_note_credits_an_authorised_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  credited RECORD;
BEGIN
  SELECT "status", "is_final_consumer" INTO credited
    FROM "invoice" WHERE "id" = NEW."invoice_id";
  IF credited."is_final_consumer" THEN
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

CREATE TRIGGER "trg_credit_note_credits_an_authorised_invoice"
  BEFORE INSERT ON "credit_note"
  FOR EACH ROW EXECUTE FUNCTION credit_note_credits_an_authorised_invoice();

-- BI-095. Lo acreditado de una factura no supera su total. Diferido al final
-- de la transacción: la nota de crédito se escribe con sus líneas, y la suma
-- se mira cuando ya están todas. El bloqueo de la factura serializa dos notas
-- de crédito simultáneas sobre ella.
CREATE FUNCTION credit_note_within_its_invoice()
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
    FROM "credit_note" WHERE "invoice_id" = NEW."invoice_id";
  IF credited > invoice_total THEN
    RAISE EXCEPTION 'credit_note_exceeds_invoice: % credited over an invoice of %', credited, invoice_total
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'credit_note_exceeds_invoice',
            HINT = 'Lo acreditado no puede superar el total de la factura.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "trg_credit_note_within_its_invoice"
  AFTER INSERT ON "credit_note"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION credit_note_within_its_invoice();

-- BI-212. Emitida, sólo se mueve lo que escribe `sri`: la clave, una vez, y
-- el estado ante el SRI (ISSUED → AUTHORISED | REJECTED, REJECTED → ISSUED al
-- reenviar). Autorizada, nada. Nunca se borra.
CREATE FUNCTION credit_note_is_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credit_note_immutable: a credit note is never deleted'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'credit_note_immutable',
            HINT = 'Una nota de crédito no se elimina.';
  END IF;

  IF (OLD."invoice_id", OLD."site_id", OLD."emission_point_id", OLD."sequential",
      OLD."reason_code", OLD."reason", OLD."amount", OLD."subtotal_taxed",
      OLD."subtotal_untaxed", OLD."discount_total", OLD."tax_total",
      OLD."buyer_identification_type", OLD."buyer_identification",
      OLD."buyer_name", OLD."buyer_email", OLD."issued_by_id", OLD."issued_at")
     IS DISTINCT FROM
     (NEW."invoice_id", NEW."site_id", NEW."emission_point_id", NEW."sequential",
      NEW."reason_code", NEW."reason", NEW."amount", NEW."subtotal_taxed",
      NEW."subtotal_untaxed", NEW."discount_total", NEW."tax_total",
      NEW."buyer_identification_type", NEW."buyer_identification",
      NEW."buyer_name", NEW."buyer_email", NEW."issued_by_id", NEW."issued_at")
     OR (OLD."access_key" IS NOT NULL AND NEW."access_key" IS DISTINCT FROM OLD."access_key")
     OR (OLD."status" = 'AUTHORISED' AND NEW."status" <> 'AUTHORISED')
     OR (NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
           (OLD."status" = 'ISSUED' AND NEW."status" IN ('AUTHORISED', 'REJECTED'))
        OR (OLD."status" = 'REJECTED' AND NEW."status" IN ('ISSUED', 'AUTHORISED'))))
  THEN
    RAISE EXCEPTION 'credit_note_immutable: an issued credit note only records what the SRI says'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'credit_note_immutable',
            HINT = 'Una nota de crédito emitida no se modifica: se compensa con los documentos que la siguen.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_credit_note_immutable"
  BEFORE UPDATE OR DELETE ON "credit_note"
  FOR EACH ROW EXECUTE FUNCTION credit_note_is_immutable();

-- ── 2. El comprobante es de una factura o de una nota de crédito ──────────

ALTER TABLE "electronic_voucher"
  ALTER COLUMN "invoice_id" DROP NOT NULL,
  ADD COLUMN "credit_note_id" UUID;

ALTER TABLE "electronic_voucher"
  DROP CONSTRAINT "electronic_voucher_document_type_is_known",
  ADD CONSTRAINT "electronic_voucher_document_type_is_known"
    CHECK ("document_type" IN ('01', '04')),
  ADD CONSTRAINT "electronic_voucher_credit_note_fk"
    FOREIGN KEY ("credit_note_id") REFERENCES "credit_note"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "electronic_voucher_one_document"
    CHECK (num_nonnulls("invoice_id", "credit_note_id") = 1),
  ADD CONSTRAINT "electronic_voucher_type_matches_its_document"
    CHECK (("document_type" = '01') = ("invoice_id" IS NOT NULL)),
  ADD CONSTRAINT "electronic_voucher_one_per_credit_note" UNIQUE ("credit_note_id"),
  ADD CONSTRAINT "electronic_voucher_credit_note_key_pair" UNIQUE ("credit_note_id", "access_key");

-- SRI-086. Como `invoice_access_key_is_its_vouchers` (SRI-007).
ALTER TABLE "credit_note"
  ADD CONSTRAINT "credit_note_access_key_is_its_vouchers"
  FOREIGN KEY ("id", "access_key")
  REFERENCES "electronic_voucher"("credit_note_id", "access_key")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- SRI-005 y SRI-086: el documento del comprobante tampoco se cambia.
CREATE OR REPLACE FUNCTION trg_electronic_voucher_is_permanent()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'electronic_voucher_is_never_deleted'
      USING HINT = 'Un comprobante electronico no se elimina.';
  END IF;

  IF NEW."access_key"     IS DISTINCT FROM OLD."access_key"
  OR NEW."numeric_code"   IS DISTINCT FROM OLD."numeric_code"
  OR NEW."environment"    IS DISTINCT FROM OLD."environment"
  OR NEW."document_type"  IS DISTINCT FROM OLD."document_type"
  OR NEW."invoice_id"     IS DISTINCT FROM OLD."invoice_id"
  OR NEW."credit_note_id" IS DISTINCT FROM OLD."credit_note_id"
  OR NEW."site_id"        IS DISTINCT FROM OLD."site_id"
  THEN
    RAISE EXCEPTION 'electronic_voucher_access_key_is_permanent'
      USING HINT = 'La clave de acceso no se regenera: los errores 43 y 70 significan ya enviado.';
  END IF;

  IF OLD."status" = 'AUTHORISED' AND (
       NEW."status"               IS DISTINCT FROM OLD."status"
    OR NEW."signed_xml"           IS DISTINCT FROM OLD."signed_xml"
    OR NEW."unsigned_xml"         IS DISTINCT FROM OLD."unsigned_xml"
    OR NEW."authorisation_number" IS DISTINCT FROM OLD."authorisation_number"
    OR NEW."authorised_at"        IS DISTINCT FROM OLD."authorised_at"
    OR NEW."authorised_xml"       IS DISTINCT FROM OLD."authorised_xml")
  THEN
    RAISE EXCEPTION 'electronic_voucher_authorised_is_immutable'
      USING HINT = 'Un comprobante autorizado por el SRI no se modifica.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 3. Lo acreditado vuelve a la cuenta ────────────────────────────────────

ALTER TABLE "charge_item" ADD COLUMN "corrects_charge_item_id" UUID;

ALTER TABLE "charge_item"
  ADD CONSTRAINT "charge_item_corrects_fk"
    FOREIGN KEY ("corrects_charge_item_id") REFERENCES "charge_item"("id") ON DELETE RESTRICT,
  DROP CONSTRAINT "charge_item_origin_is_known",
  ADD CONSTRAINT "charge_item_origin_is_known" CHECK (
    "origin" IN ('MANUAL', 'CONSULTATION', 'PROCEDURE', 'EXAM', 'CORRECTION')
  ),
  -- Una corrección no nombra el acto clínico: lo nombra el cargo que corrige.
  -- Así no ocupa `charge_item_one_consultation_per_encounter` ni los índices
  -- de procedimiento y examen, que siguen ocupados por el original.
  DROP CONSTRAINT "charge_item_origin_names_its_act",
  ADD CONSTRAINT "charge_item_origin_names_its_act" CHECK (
    CASE "origin"
      WHEN 'PROCEDURE' THEN
        "encounter_procedure_id" IS NOT NULL
        AND "service_order_item_id" IS NULL
        AND "encounter_id" IS NOT NULL
        AND "corrects_charge_item_id" IS NULL
      WHEN 'EXAM' THEN
        "service_order_item_id" IS NOT NULL
        AND "encounter_procedure_id" IS NULL
        AND "encounter_id" IS NOT NULL
        AND "corrects_charge_item_id" IS NULL
      WHEN 'CONSULTATION' THEN
        "encounter_id" IS NOT NULL
        AND "encounter_procedure_id" IS NULL
        AND "service_order_item_id" IS NULL
        AND "corrects_charge_item_id" IS NULL
      WHEN 'CORRECTION' THEN
        "corrects_charge_item_id" IS NOT NULL
        AND "encounter_procedure_id" IS NULL
        AND "service_order_item_id" IS NULL
      ELSE
        "encounter_procedure_id" IS NULL
        AND "service_order_item_id" IS NULL
        AND "corrects_charge_item_id" IS NULL
    END
  );

-- BI-214. Una sola copia por cargo acreditado, aunque se quite (como BI-157:
-- quitarla fue una decisión de una persona).
CREATE UNIQUE INDEX "charge_item_one_correction_per_charge"
  ON "charge_item" ("corrects_charge_item_id")
  WHERE "corrects_charge_item_id" IS NOT NULL;

CREATE FUNCTION charge_item_corrects_a_credited_charge()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "credit_note_line"
     WHERE "charge_item_id" = NEW."corrects_charge_item_id"
  ) THEN
    RAISE EXCEPTION 'charge_item_corrects_a_credited_charge: only a credited charge is billed again'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'charge_item_corrects_a_credited_charge',
            HINT = 'Sólo vuelve a facturarse lo que una nota de crédito acreditó.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_charge_item_corrects_a_credited_charge"
  BEFORE INSERT OR UPDATE OF "corrects_charge_item_id" ON "charge_item"
  FOR EACH ROW
  WHEN (NEW."corrects_charge_item_id" IS NOT NULL)
  EXECUTE FUNCTION charge_item_corrects_a_credited_charge();

-- ── 4. La cuenta guarda su versión anterior (BI-215, D-142.2) ─────────────

ALTER TABLE "patient_account"
  ADD COLUMN "changed_by" UUID,
  ADD COLUMN "changed_at" TIMESTAMPTZ(6);

ALTER TABLE "patient_account"
  ADD CONSTRAINT "patient_account_changed_by_fkey"
    FOREIGN KEY ("changed_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patient_account_change_stamped"
    CHECK (("changed_by" IS NULL) = ("changed_at" IS NULL));

-- Lo que es un cambio de la cuenta: quién paga, con qué lista, y su estado
-- (cerrarla, y reabrirla tras una nota de crédito). `updated_at` no.
CREATE TRIGGER "trg_patient_account_record_version"
  BEFORE UPDATE ON "patient_account"
  FOR EACH ROW
  WHEN (
    (OLD."payer_id", OLD."price_list_id", OLD."status", OLD."closed_at")
    IS DISTINCT FROM
    (NEW."payer_id", NEW."price_list_id", NEW."status", NEW."closed_at")
  )
  EXECUTE FUNCTION record_version_archive('changed_by', 'changed_at', 'id');

-- ── 5. La factura devuelta se edita, y sólo ella (BI-216, BI-217) ─────────

ALTER TABLE "invoice"
  ADD COLUMN "changed_by" UUID,
  ADD COLUMN "changed_at" TIMESTAMPTZ(6);

ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_changed_by_fkey"
    FOREIGN KEY ("changed_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "invoice_change_stamped"
    CHECK (("changed_by" IS NULL) = ("changed_at" IS NULL));

-- Hasta hoy el receptor de una factura emitida o devuelta se podía cambiar
-- por debajo (`trg_invoice_immutable` sólo congela lo autorizado o anulado).
-- Ahora sólo la devuelta o no autorizada por el SRI, que es la que la Nota 1
-- de la Ficha deja reenviar «una vez corregido el error».
CREATE FUNCTION invoice_receiver_editable_only_when_rejected()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" <> 'REJECTED' THEN
    RAISE EXCEPTION 'invoice_receiver_editable_only_when_rejected: only an invoice the SRI did not accept is corrected'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'invoice_receiver_editable_only_when_rejected',
            HINT = 'Sólo la factura devuelta o no autorizada por el SRI se corrige y se reenvía.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_invoice_receiver_editable_only_when_rejected"
  BEFORE UPDATE ON "invoice"
  FOR EACH ROW
  WHEN (
    (OLD."buyer_identification_type", OLD."buyer_identification",
     OLD."buyer_name", OLD."buyer_email", OLD."is_final_consumer")
    IS DISTINCT FROM
    (NEW."buyer_identification_type", NEW."buyer_identification",
     NEW."buyer_name", NEW."buyer_email", NEW."is_final_consumer")
    OR (OLD."payment_method" IS NOT NULL
        AND NEW."payment_method" IS DISTINCT FROM OLD."payment_method")
  )
  EXECUTE FUNCTION invoice_receiver_editable_only_when_rejected();

-- La forma de pago que falta en una factura anterior a BI-170 se puede poner
-- una vez, como hasta hoy: eso no es corregir, y no pasa por aquí.
--
-- La forma de pago seguía sin cambiar nunca (BI-170). Ahora, como el
-- receptor, en la devuelta sí; en las demás lo frena el disparador de arriba.
CREATE OR REPLACE FUNCTION trg_invoice_payment_method_is_permanent()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."payment_method" IS NOT NULL
     AND NEW."payment_method" IS DISTINCT FROM OLD."payment_method"
     AND (NEW."payment_method" IS NULL OR OLD."status" <> 'REJECTED') THEN
    RAISE EXCEPTION 'invoice_payment_method_is_permanent'
      USING HINT = 'La forma de pago de una factura emitida no se cambia.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Después del freno (orden alfabético de los BEFORE): lo rechazado no llega
-- a archivar nada.
CREATE TRIGGER "trg_invoice_record_version"
  BEFORE UPDATE ON "invoice"
  FOR EACH ROW
  WHEN (
    (OLD."buyer_identification_type", OLD."buyer_identification",
     OLD."buyer_name", OLD."buyer_email", OLD."is_final_consumer")
    IS DISTINCT FROM
    (NEW."buyer_identification_type", NEW."buyer_identification",
     NEW."buyer_name", NEW."buyer_email", NEW."is_final_consumer")
    OR (OLD."payment_method" IS NOT NULL
        AND NEW."payment_method" IS DISTINCT FROM OLD."payment_method")
  )
  EXECUTE FUNCTION record_version_archive('changed_by', 'changed_at', 'id');
