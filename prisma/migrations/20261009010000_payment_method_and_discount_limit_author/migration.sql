-- payment_method_and_discount_limit_author
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Después: pnpm migrations:check && pnpm db:deploy

-- ═══════════════════════════════════════════════════════════════════════════
-- BI-100, BI-144: LOS MEDIOS DE PAGO SON FILAS, Y CADA UNO DECLARA SU CÓDIGO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hasta aquí la única lista de medios que veía caja era la Tabla 24 del SRI
-- quemada en la interfaz. La clínica cobra con «Deuna» o «Visa», y el SRI no
-- conoce esos nombres: conoce `20` y `19`. Por eso el nombre es de la clínica
-- y el código del SRI va al lado, en la lista cerrada que la factura ya admite
-- (`invoice_payment_method_is_known`, BI-170). Dos medios pueden compartir
-- código —Visa y Mastercard son los dos `19`—, y por eso el código no puede
-- ser la clave.
--
-- No se borra un medio (BI-146): el cobro de B6 lo referenciará. Se desactiva.
CREATE TABLE "payment_method" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "name" VARCHAR(60) NOT NULL,
  "sri_code" CHAR(2) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  -- El orden en que caja los ve: efectivo y tarjetas primero. Un entero y no
  -- el orden alfabético porque «Efectivo» no va después de «Deuna».
  "display_order" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- BI-147. Quién lo cambió por última vez; NULL sólo en lo que trae la
  -- instalación, que nadie tocó todavía.
  "updated_by_id" UUID,

  CONSTRAINT "payment_method_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_method_updated_by_fk"
    FOREIGN KEY ("updated_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  -- La misma lista cerrada que la factura (BI-170): un medio que declarara
  -- otro código produciría una factura que la base no deja escribir.
  CONSTRAINT "payment_method_sri_code_is_known"
    CHECK ("sri_code" IN ('01', '15', '16', '17', '18', '19', '20', '21')),
  CONSTRAINT "payment_method_name_is_not_blank"
    CHECK (btrim("name") <> '')
);

-- Dos «Deuna» en el selector de caja son una pregunta que el cajero no sabe
-- contestar. Sin distinguir mayúsculas ni espacios de los bordes.
CREATE UNIQUE INDEX "payment_method_name_unique"
  ON "payment_method" (lower(btrim("name")));

COMMENT ON TABLE "payment_method" IS
  'Medios de pago de la clinica (BI-100, BI-144): nombre propio y la forma de '
  'pago de la Tabla 24 del SRI con que se declara en la factura.';

-- Lo que la instalación trae: las ocho formas de la Tabla 24 con los mismos
-- formas y el mismo orden que el selector de caja tenía hasta hoy, con nombres cortos, todas
-- activas. Caja ve exactamente lo que veía; qué se desactiva y qué se añade
-- lo decide la clínica (D-193.1), no esta migración.
INSERT INTO "payment_method" ("name", "sri_code", "display_order") VALUES
  ('Efectivo', '01', 1),
  ('Tarjeta de crédito', '19', 2),
  ('Tarjeta de débito', '16', 3),
  ('Transferencia', '20', 4),
  ('Tarjeta prepago', '18', 5),
  ('Dinero electrónico', '17', 6),
  ('Compensación de deudas', '15', 7),
  ('Endoso de títulos', '21', 8);

-- ═══════════════════════════════════════════════════════════════════════════
-- BI-147: EL LÍMITE DE DESCUENTO DICE QUIÉN LO PUSO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- «¿Quién subió el límite de recepción al 30 %?» se pregunta después de un
-- descuadre. `updated_at` ya estaba; faltaba el autor. NULL sólo en una fila
-- anterior a esta columna (no hay ninguna: ninguna ruta la escribía).
ALTER TABLE "role_discount_limit" ADD COLUMN "updated_by_id" UUID;

ALTER TABLE "role_discount_limit"
  ADD CONSTRAINT "role_discount_limit_updated_by_fk"
  FOREIGN KEY ("updated_by_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ═══════════════════════════════════════════════════════════════════════════
-- BI-147: EL ANTES Y EL DESPUÉS DE LOS DOS, EN LA BITÁCORA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `access_audit_payload_only_for_declared_resources` admite el antes y el
-- después sólo en los recursos de administración que enumera. Se añaden los
-- dos de esta entrega; ninguno es de paciente, que es lo que D-017 protege.
-- Toda fila existente cumple el CHECK anterior, así que cumple éste.
ALTER TABLE "access_audit"
  DROP CONSTRAINT "access_audit_payload_only_for_declared_resources",
  ADD CONSTRAINT "access_audit_payload_only_for_declared_resources"
  CHECK (
    ("before" IS NULL AND "after" IS NULL)
    OR "resource_type" IN (
      'configuration',
      'staff',
      'organization',
      'auth',
      'billable_service',
      'billable_service_category',
      'price',
      'payer',
      'exam_definition',
      'analyte_definition',
      'payment_method',
      'role_discount_limit'
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- BI-146: NUNCA SE BORRA, Y NUNCA SE QUEDA CAJA SIN NINGUNO ACTIVO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El servicio cuenta los activos antes de desactivar uno, pero una cuenta
-- seguida de una escritura no arbitra a dos administradores a la vez: cada uno
-- ve dos activos, cada uno apaga el suyo, y quedan cero. La base lo arbitra con
-- un candado de transacción: la segunda espera a que la primera confirme, y
-- entonces ya ve que el suyo era el último.
--
-- Y no se borra: el cobro de B6 lo referenciará y una factura ya declaró su
-- código. Hasta que exista esa clave foránea, lo impide este disparador.
CREATE OR REPLACE FUNCTION trg_payment_method_one_stays_active()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_method_is_never_deleted'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Un medio de pago se desactiva; no se borra.';
  END IF;
  IF OLD."active" AND NOT NEW."active" THEN
    PERFORM pg_advisory_xact_lock(hashtext('payment_method_one_stays_active'));
    IF NOT EXISTS (
      SELECT 1 FROM "payment_method"
       WHERE "active" AND "id" <> NEW."id"
    ) THEN
      RAISE EXCEPTION 'payment_method_one_stays_active: es el único medio de pago activo'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payment_method_one_stays_active
  BEFORE UPDATE OF "active" OR DELETE ON "payment_method"
  FOR EACH ROW EXECUTE FUNCTION trg_payment_method_one_stays_active();
