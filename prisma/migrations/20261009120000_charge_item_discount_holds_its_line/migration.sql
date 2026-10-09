-- charge_item_discount_holds_its_line
--
-- Revisión clínica de B4 (08-10-2026), sobre `20261009110000`:
--
--   M2. `trg_charge_item_discount_is_permanent` sólo vigilaba cantidad y precio;
--       BI-244 dice que tampoco cambian la prestación, su fecha ni su tarifa
--       de IVA mientras la línea lleve descuento. Ahora vigila el bloque
--       congelado entero.
--   m2. Un acto nuevo podía, en la misma sentencia, mover la línea o fecharse
--       antes que el anterior. Ahora la línea con descuento no se mueve NUNCA
--       —se quita el descuento primero, en otra sentencia— y un acto nuevo
--       va siempre después del que reemplaza.
--   m1. `charge_item_discount_within_line` comparaba con `unit_amount *
--       quantity` sin redondear, y el servidor y la pantalla con el bruto
--       redondeado al centavo (BI-058): un 100 % de 12,35 × 1,5 se rechazaba.
--       Ahora la base redondea igual (ROUND de numeric: mitad hacia arriba
--       para positivos, como `Money.times`).

CREATE OR REPLACE FUNCTION charge_item_discount_is_permanent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
       -- Lo que dice el descuento sólo cambia con un acto nuevo...
       NEW."discount_applied_at" IS NOT DISTINCT FROM OLD."discount_applied_at"
       AND (OLD."discount_amount", OLD."discount_reason", OLD."discount_applied_by_id",
            OLD."discount_authorised_by_id", OLD."discount_authorised_at")
           IS DISTINCT FROM
           (NEW."discount_amount", NEW."discount_reason", NEW."discount_applied_by_id",
            NEW."discount_authorised_by_id", NEW."discount_authorised_at")
     )
     -- ...y ese acto va después del que reemplaza.
     OR (OLD."discount_applied_at" IS NOT NULL
         AND NEW."discount_applied_at" IS NOT NULL
         AND NEW."discount_applied_at" <= OLD."discount_applied_at"
         AND NEW."discount_applied_at" IS DISTINCT FROM OLD."discount_applied_at")
     -- BI-244. La línea con descuento no se mueve, haya acto nuevo o no.
     OR (OLD."discount_amount" > 0
         AND (OLD."quantity", OLD."unit_amount", OLD."billable_service_id",
              OLD."service_date", OLD."resolved_price_id", OLD."tax_sri_code",
              OLD."tax_percentage")
             IS DISTINCT FROM
             (NEW."quantity", NEW."unit_amount", NEW."billable_service_id",
              NEW."service_date", NEW."resolved_price_id", NEW."tax_sri_code",
              NEW."tax_percentage"))
  THEN
    RAISE EXCEPTION 'charge_item_discount_is_permanent: a discount is removed or replaced, never edited, and its line keeps its amount'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'charge_item_discount_is_permanent',
            HINT = 'Quite el descuento antes de cambiar la cantidad, la prestación, la fecha o el precio (BI-244).';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "charge_item"
  DROP CONSTRAINT "charge_item_discount_within_line",
  ADD CONSTRAINT "charge_item_discount_within_line"
    CHECK ("discount_amount" <= ROUND("unit_amount" * "quantity", 2));
