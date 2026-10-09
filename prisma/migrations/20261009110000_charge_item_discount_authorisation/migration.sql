-- charge_item_discount_authorisation
--
-- B4 (billing/SPEC.md §7): el descuento de una línea, con quién lo aplicó,
-- quién lo autorizó y cuándo, en LA FILA DEL CARGO (BI-066, SC-021).
--
-- Hasta hoy ninguna ruta concedía descuentos: toda fila tiene
-- `discount_amount = 0` y ningún autorizador (comprobado en la base del autor
-- el 08-10-2026), así que los CHECK nuevos se validan sin relleno.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. QUIÉN Y CUÁNDO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `created_by_id` es quien añadió la línea, no quien la rebajó: son dos actos y
-- a menudo dos personas. `discount_authorised_by_id` ya existía (es la segunda
-- persona de BI-063); le faltaba su instante.
ALTER TABLE "charge_item"
  ADD COLUMN "discount_applied_by_id" UUID,
  ADD COLUMN "discount_applied_at" TIMESTAMPTZ(6),
  ADD COLUMN "discount_authorised_at" TIMESTAMPTZ(6);

ALTER TABLE "charge_item"
  ADD CONSTRAINT "charge_item_discount_applied_by_fk"
    FOREIGN KEY ("discount_applied_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  -- Sin descuento no hay sellos, ni motivo; con descuento, quién y cuándo
  -- siempre, y el autorizador con su instante o ninguno de los dos.
  ADD CONSTRAINT "charge_item_discount_states_who_and_when" CHECK (
    (
      "discount_amount" = 0
      AND "discount_reason" IS NULL
      AND "discount_applied_by_id" IS NULL
      AND "discount_applied_at" IS NULL
      AND "discount_authorised_by_id" IS NULL
      AND "discount_authorised_at" IS NULL
    )
    OR (
      "discount_amount" > 0
      AND "discount_applied_by_id" IS NOT NULL
      AND "discount_applied_at" IS NOT NULL
      AND ("discount_authorised_by_id" IS NULL) = ("discount_authorised_at" IS NULL)
    )
  ),
  -- BI-064 en la base: un campo de autorización que se rellena solo no
  -- autoriza nada. El servicio lo dice antes con su frase; esto es lo que
  -- queda si otro camino escribe la fila.
  ADD CONSTRAINT "charge_item_discount_not_self_authorised" CHECK (
    "discount_authorised_by_id" IS NULL
    OR "discount_authorised_by_id" <> "discount_applied_by_id"
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. LO AUTORIZADO NO SE EDITA (BI-066) Y NO SE DESPLAZA (BI-244)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Un descuento se pone, se quita o se reemplaza por otro: los tres son un acto
-- nuevo con su `discount_applied_at`. Lo que este disparador rechaza es cambiar
-- lo que dice el descuento —el importe, el motivo, quién, cuándo— SIN un acto
-- nuevo, y cambiar la cantidad o el precio de una línea que lleva descuento:
-- el descuento está en dólares y el límite es un porcentaje, así que bajar la
-- cantidad de una línea con un 10 % autorizado lo convertiría en un 50 % que
-- nadie autorizó.
CREATE FUNCTION charge_item_discount_is_permanent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."discount_applied_at" IS NOT DISTINCT FROM OLD."discount_applied_at"
     AND (
       (OLD."discount_amount", OLD."discount_reason", OLD."discount_applied_by_id",
        OLD."discount_authorised_by_id", OLD."discount_authorised_at")
       IS DISTINCT FROM
       (NEW."discount_amount", NEW."discount_reason", NEW."discount_applied_by_id",
        NEW."discount_authorised_by_id", NEW."discount_authorised_at")
       OR (OLD."discount_amount" > 0
           AND (OLD."quantity", OLD."unit_amount")
               IS DISTINCT FROM (NEW."quantity", NEW."unit_amount"))
     ) THEN
    RAISE EXCEPTION 'charge_item_discount_is_permanent: a discount is removed or replaced, never edited, and its line keeps its amount'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'charge_item_discount_is_permanent',
            HINT = 'Quite el descuento antes de cambiar la cantidad o el precio (BI-244).';
  END IF;
  RETURN NEW;
END;
$$;

-- Entre `..._billed_is_frozen` y `..._record_version` (orden alfabético de los
-- BEFORE): lo facturado se rechaza antes, y lo rechazado aquí no archiva nada.
CREATE TRIGGER "trg_charge_item_discount_is_permanent"
  BEFORE UPDATE ON "charge_item"
  FOR EACH ROW
  EXECUTE FUNCTION charge_item_discount_is_permanent();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. LO FACTURADO SIGUE SIN CAMBIAR, CON LAS COLUMNAS NUEVAS
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION charge_item_billed_is_frozen()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'BILLED'
     AND (OLD."account_id", OLD."billable_service_id", OLD."encounter_id",
          OLD."service_date", OLD."quantity", OLD."unit_amount",
          OLD."resolved_price_id", OLD."service_display", OLD."tax_sri_code",
          OLD."tax_percentage", OLD."discount_amount", OLD."discount_reason",
          OLD."discount_applied_by_id", OLD."discount_applied_at",
          OLD."discount_authorised_by_id", OLD."discount_authorised_at",
          OLD."status", OLD."invoice_id")
         IS DISTINCT FROM
         (NEW."account_id", NEW."billable_service_id", NEW."encounter_id",
          NEW."service_date", NEW."quantity", NEW."unit_amount",
          NEW."resolved_price_id", NEW."service_display", NEW."tax_sri_code",
          NEW."tax_percentage", NEW."discount_amount", NEW."discount_reason",
          NEW."discount_applied_by_id", NEW."discount_applied_at",
          NEW."discount_authorised_by_id", NEW."discount_authorised_at",
          NEW."status", NEW."invoice_id") THEN
    RAISE EXCEPTION 'charge_item_billed_is_frozen: a billed charge is corrected with a credit note'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'charge_item_billed_is_frozen',
            HINT = 'Un cargo facturado no se edita: se corrige la factura (BI-056).';
  END IF;
  RETURN NEW;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. LA VERSIÓN ANTERIOR, TAMBIÉN DE UN DESCUENTO REEMPLAZADO POR OTRO IGUAL
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El WHEN miraba `discount_amount`: un descuento del mismo importe pero con
-- otro autorizador no dejaba versión. Con `discount_applied_at` cada acto la
-- deja.
DROP TRIGGER "trg_charge_item_record_version" ON "charge_item";
CREATE TRIGGER "trg_charge_item_record_version"
  BEFORE UPDATE ON "charge_item"
  FOR EACH ROW
  WHEN (
    (OLD."billable_service_id", OLD."service_date", OLD."quantity",
     OLD."unit_amount", OLD."resolved_price_id", OLD."service_display",
     OLD."tax_sri_code", OLD."tax_percentage", OLD."discount_amount",
     OLD."discount_applied_at")
    IS DISTINCT FROM
    (NEW."billable_service_id", NEW."service_date", NEW."quantity",
     NEW."unit_amount", NEW."resolved_price_id", NEW."service_display",
     NEW."tax_sri_code", NEW."tax_percentage", NEW."discount_amount",
     NEW."discount_applied_at")
    OR (OLD."status" IS DISTINCT FROM NEW."status"
        AND (OLD."status" IN ('CANCELLED', 'NOT_BILLABLE')
             OR NEW."status" IN ('CANCELLED', 'NOT_BILLABLE')))
  )
  EXECUTE FUNCTION record_version_archive('changed_by', 'changed_at', 'id');

COMMENT ON COLUMN "charge_item"."discount_applied_by_id" IS
  'Quien puso el descuento (BI-066); no es quien anadio la linea.';
COMMENT ON COLUMN "charge_item"."discount_authorised_at" IS
  'Cuando lo autorizo otra persona (BI-063); NULL si cupo en el limite.';
