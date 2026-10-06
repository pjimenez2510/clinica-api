-- charge_item_edit_in_place
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BI-195 A BI-200 (D-126, D-127): UN CARGO SIN FACTURAR SE CORRIGE EN EL SITIO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hasta aquí un cargo no se editaba: corregir una cantidad era anularlo con
-- motivo y añadir otro (BI-059), y cambiar el pagador obligaba a hacerlo con
-- cada línea (BI-033). El autor decidió que lo que todavía no salió de caja
-- se edita y se quita sin preguntar, y que la historia la guarda el sistema.
--
--   1. Sello de corrección (`changed_by`, `changed_at`) y el disparador
--      genérico `record_version_archive` (EN-210), con un WHEN que lo limita a
--      lo que ES corrección: el contenido del cargo, quitarlo, marcarlo «No se
--      cobra» y deshacer. Confirmar (`PLANNED` → `BILLABLE`) y facturar
--      (`BILLABLE` → `BILLED`) siguen sin sello, como hasta hoy.
--   2. Lo facturado no cambia (BI-197): hasta hoy sólo lo decía la `where` de
--      la aplicación. Ahora lo dice la base, antes de archivar nada.
--   3. El motivo de quitar (BI-195) y el del descuento (BI-200), opcionales.
--      Nunca se borran los motivos ya guardados: sólo se afloja el CHECK.
--
-- No hay relleno de datos: las filas existentes quedan sin sello, que es lo
-- que dice «nunca se corrigió».

-- ── 1. El sello ────────────────────────────────────────────────────────────
ALTER TABLE "charge_item"
  ADD COLUMN "changed_by" UUID,
  ADD COLUMN "changed_at" TIMESTAMPTZ(6);

ALTER TABLE "charge_item"
  ADD CONSTRAINT "charge_item_changed_by_fkey"
    FOREIGN KEY ("changed_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "charge_item_change_stamped"
    CHECK (("changed_by" IS NULL) = ("changed_at" IS NULL));

-- ── 3. Motivos opcionales ──────────────────────────────────────────────────
-- BI-195 (D-126.1): quién y cuándo siguen viajando juntos; el motivo, si
-- llega, se guarda.
ALTER TABLE "charge_item"
  DROP CONSTRAINT "charge_item_void_states_who_when_and_why",
  ADD CONSTRAINT "charge_item_void_states_who_and_when" CHECK (
    ("voided_at" IS NULL AND "voided_by_id" IS NULL AND "void_reason" IS NULL)
    OR
    ("voided_at" IS NOT NULL AND "voided_by_id" IS NOT NULL)
  );

-- BI-200 (D-126, CA-6): el SRI pide el descuento por ítem, no un motivo. El
-- control es el límite del rol (BI-062, BI-063); `..._within_line` se queda.
ALTER TABLE "charge_item"
  DROP CONSTRAINT "charge_item_discount_states_a_reason";

-- ── 2. Lo facturado no cambia ──────────────────────────────────────────────
CREATE FUNCTION charge_item_billed_is_frozen()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'BILLED'
     AND (OLD."account_id", OLD."billable_service_id", OLD."encounter_id",
          OLD."service_date", OLD."quantity", OLD."unit_amount",
          OLD."resolved_price_id", OLD."service_display", OLD."tax_sri_code",
          OLD."tax_percentage", OLD."discount_amount", OLD."discount_reason",
          OLD."status", OLD."invoice_id")
         IS DISTINCT FROM
         (NEW."account_id", NEW."billable_service_id", NEW."encounter_id",
          NEW."service_date", NEW."quantity", NEW."unit_amount",
          NEW."resolved_price_id", NEW."service_display", NEW."tax_sri_code",
          NEW."tax_percentage", NEW."discount_amount", NEW."discount_reason",
          NEW."status", NEW."invoice_id") THEN
    RAISE EXCEPTION 'charge_item_billed_is_frozen: a billed charge is corrected with a credit note'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'charge_item_billed_is_frozen',
            HINT = 'Un cargo facturado no se edita: se corrige la factura (BI-056).';
  END IF;
  RETURN NEW;
END;
$$;

-- Antes que el de versiones (orden alfabético de los BEFORE): lo que se
-- rechaza no llega a archivar nada.
CREATE TRIGGER "trg_charge_item_billed_is_frozen"
  BEFORE UPDATE ON "charge_item"
  FOR EACH ROW
  WHEN (OLD."status" = 'BILLED')
  EXECUTE FUNCTION charge_item_billed_is_frozen();

-- ── 1. La versión anterior la guarda la base ───────────────────────────────
CREATE TRIGGER "trg_charge_item_record_version"
  BEFORE UPDATE ON "charge_item"
  FOR EACH ROW
  WHEN (
    (OLD."billable_service_id", OLD."service_date", OLD."quantity",
     OLD."unit_amount", OLD."resolved_price_id", OLD."service_display",
     OLD."tax_sri_code", OLD."tax_percentage", OLD."discount_amount")
    IS DISTINCT FROM
    (NEW."billable_service_id", NEW."service_date", NEW."quantity",
     NEW."unit_amount", NEW."resolved_price_id", NEW."service_display",
     NEW."tax_sri_code", NEW."tax_percentage", NEW."discount_amount")
    OR (OLD."status" IS DISTINCT FROM NEW."status"
        AND (OLD."status" IN ('CANCELLED', 'NOT_BILLABLE')
             OR NEW."status" IN ('CANCELLED', 'NOT_BILLABLE')))
  )
  EXECUTE FUNCTION record_version_archive('changed_by', 'changed_at', 'id');
