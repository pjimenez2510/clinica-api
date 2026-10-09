-- payment_and_cash_session
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Después: pnpm migrations:check && pnpm db:deploy
--
-- billing B6 (BI-101 a BI-105, BI-247 a BI-253): el cobro contra la factura y
-- el cierre diario de caja. Todo lo que es una cuenta de dinero lo arbitra la
-- base, porque son las cuentas que dos cajeras a la vez harían mal leyendo
-- primero y escribiendo después.

-- ═══════════════════════════════════════════════════════════════════════════
-- BI-253: LA CAJA DE UN USUARIO, EN UNA SEDE, UN DÍA, SE TOCA DE UNO EN UNO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El cierre lo toma ANTES de leer lo cobrado; el cobro y la reversión, antes
-- de mirar si la caja está cerrada. Así un cobro concurrente con el cierre o
-- entra en la foto o encuentra la caja cerrada: nunca se queda fuera de las
-- dos. Es un candado de transacción: se suelta solo al confirmar.
CREATE OR REPLACE FUNCTION cash_day_lock(p_site UUID, p_user UUID, p_day DATE)
RETURNS VOID AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('cash_day:' || p_site || ':' || p_user || ':' || p_day, 0)
  );
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════
-- BI-101, BI-102, BI-250: EL COBRO
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE "payment" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "invoice_id" UUID NOT NULL,
  -- La sede de la factura (lo comprueba el disparador): la caja es de una sede.
  "site_id" UUID NOT NULL,
  -- BI-100, BI-145. El MEDIO, no su código: la clave foránea es la garantía
  -- que B7 dejó para aquí, y la que impide borrar un medio con cobros.
  "payment_method_id" UUID NOT NULL,
  "amount" DECIMAL(12, 2) NOT NULL,
  -- El número del voucher o de la transferencia. Opcional.
  "reference" VARCHAR(100),
  -- El instante lo pone el reloj de la aplicación; la fecha de caja, la base.
  "received_at" TIMESTAMPTZ(6) NOT NULL,
  "received_by_id" UUID NOT NULL,
  -- BI-250. La fecha en Guayaquil de `received_at`, escrita por
  -- `trg_payment_guard` sea cual sea lo que traiga el INSERT.
  "cash_date" DATE NOT NULL,
  -- BI-102. Deshacer es poner quién y cuándo (y el motivo, si se da), una
  -- vez; nunca borrar.
  "reversed_at" TIMESTAMPTZ(6),
  "reversed_by_id" UUID,
  "reversal_reason" VARCHAR(200),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "payment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_invoice_fk" FOREIGN KEY ("invoice_id")
    REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "payment_site_fk" FOREIGN KEY ("site_id")
    REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "payment_payment_method_fk" FOREIGN KEY ("payment_method_id")
    REFERENCES "payment_method"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "payment_received_by_fk" FOREIGN KEY ("received_by_id")
    REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "payment_reversed_by_fk" FOREIGN KEY ("reversed_by_id")
    REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "payment_amount_is_positive" CHECK ("amount" > 0),
  -- Quién y cuándo, siempre juntos; el motivo, si se da, no en blanco
  -- (D-126: el motivo se elige de una lista y nunca es obligatorio).
  CONSTRAINT "payment_reversal_states_who_and_when" CHECK (
    ("reversed_at" IS NULL AND "reversed_by_id" IS NULL AND "reversal_reason" IS NULL)
    OR ("reversed_at" IS NOT NULL AND "reversed_by_id" IS NOT NULL
        AND ("reversal_reason" IS NULL OR btrim("reversal_reason") <> ''))
  )
);

CREATE INDEX "payment_by_invoice" ON "payment" ("invoice_id");
CREATE INDEX "payment_by_cash_day" ON "payment" ("site_id", "received_by_id", "cash_date");

COMMENT ON TABLE "payment" IS
  'Cobros contra una factura (BI-101 a BI-104). No se borran: se revierten.';

-- BI-101, BI-104, BI-247, BI-248, BI-250, BI-253. Todo cobro nuevo pasa por
-- aquí, lo escriba la aplicación o un guion.
CREATE OR REPLACE FUNCTION trg_payment_guard()
RETURNS TRIGGER AS $$
DECLARE
  v_invoice RECORD;
  v_active BOOLEAN;
  v_credited NUMERIC(12, 2);
  v_paid NUMERIC(12, 2);
BEGIN
  NEW."cash_date" := (NEW."received_at" AT TIME ZONE 'America/Guayaquil')::date;

  IF NEW."reversed_at" IS NOT NULL OR NEW."reversed_by_id" IS NOT NULL
     OR NEW."reversal_reason" IS NOT NULL THEN
    RAISE EXCEPTION 'payment_is_born_unreversed: un cobro nace sin reversión'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  PERFORM cash_day_lock(NEW."site_id", NEW."received_by_id", NEW."cash_date");
  IF EXISTS (
    SELECT 1 FROM "cash_session"
     WHERE "site_id" = NEW."site_id" AND "user_id" = NEW."received_by_id"
       AND "cash_date" = NEW."cash_date"
  ) THEN
    RAISE EXCEPTION 'cash_session_closed: la caja de ese día ya está cerrada'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- El candado de la factura: dos cobros a la vez sobre el mismo saldo se
  -- ponen en fila, y el segundo ya ve el primero.
  SELECT "status", "total", "site_id" INTO v_invoice
    FROM "invoice" WHERE "id" = NEW."invoice_id" FOR UPDATE;
  IF v_invoice."site_id" IS DISTINCT FROM NEW."site_id" THEN
    RAISE EXCEPTION 'payment_site_is_its_invoices: el cobro es de la sede de su factura'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_invoice."status" IN ('DRAFT', 'VOIDED') THEN
    RAISE EXCEPTION 'invoice_not_payable: la factura no está emitida o está anulada'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT "active" INTO v_active FROM "payment_method"
   WHERE "id" = NEW."payment_method_id";
  IF v_active IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'payment_method_inactive: el medio de pago no está activo'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- BI-101, BI-103. El saldo se deriva, nunca se guarda.
  SELECT COALESCE(SUM("amount"), 0) INTO v_credited FROM "credit_note"
   WHERE "invoice_id" = NEW."invoice_id" AND "status" <> 'REJECTED';
  SELECT COALESCE(SUM("amount"), 0) INTO v_paid FROM "payment"
   WHERE "invoice_id" = NEW."invoice_id" AND "reversed_at" IS NULL;
  IF v_paid + NEW."amount" > v_invoice."total" - v_credited THEN
    RAISE EXCEPTION 'payment_exceeds_balance: el cobro supera el saldo de la factura'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payment_guard
  BEFORE INSERT ON "payment"
  FOR EACH ROW EXECUTE FUNCTION trg_payment_guard();

-- BI-102, BI-104. Lo único que cambia de un cobro es su reversión, una vez, y
-- no en un día cerrado. Borrarlo, nunca.
CREATE OR REPLACE FUNCTION trg_payment_only_reverses()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment is never deleted: se revierte con motivo'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."reversed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'payment_already_reversed: el cobro ya está revertido'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."invoice_id" IS DISTINCT FROM OLD."invoice_id"
     OR NEW."site_id" IS DISTINCT FROM OLD."site_id"
     OR NEW."payment_method_id" IS DISTINCT FROM OLD."payment_method_id"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."received_at" IS DISTINCT FROM OLD."received_at"
     OR NEW."received_by_id" IS DISTINCT FROM OLD."received_by_id"
     OR NEW."cash_date" IS DISTINCT FROM OLD."cash_date"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'payment cannot be modified: sólo se revierte'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM cash_day_lock(OLD."site_id", OLD."received_by_id", OLD."cash_date");
  IF EXISTS (
    SELECT 1 FROM "cash_session"
     WHERE "site_id" = OLD."site_id" AND "user_id" = OLD."received_by_id"
       AND "cash_date" = OLD."cash_date"
  ) THEN
    RAISE EXCEPTION 'cash_session_closed: la caja de ese día ya está cerrada'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payment_only_reverses
  BEFORE UPDATE OR DELETE ON "payment"
  FOR EACH ROW EXECUTE FUNCTION trg_payment_only_reverses();

-- ═══════════════════════════════════════════════════════════════════════════
-- BI-104, BI-105, BI-252: EL CIERRE, UNA FOTO QUE NO SE EDITA
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE "cash_session" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "site_id" UUID NOT NULL,
  -- De quién es la caja, que es quien la cierra (BI-104, D-197.5).
  "user_id" UUID NOT NULL,
  "cash_date" DATE NOT NULL,
  "closed_at" TIMESTAMPTZ(6) NOT NULL,
  "collected_total" DECIMAL(12, 2) NOT NULL,
  -- BI-105, D-197.1. Lo cobrado con medios de forma de pago 01, y lo contado.
  "expected_cash" DECIMAL(12, 2) NOT NULL,
  "declared_cash" DECIMAL(12, 2) NOT NULL,
  -- Lo que sobra (+) o falta (−). Registrado, nunca un motivo para no cerrar.
  "difference" DECIMAL(12, 2) GENERATED ALWAYS AS ("declared_cash" - "expected_cash") STORED,
  -- Lo que facturó ese día y seguía sin cobrar al cerrar: cambia después, y
  -- por eso es parte de la foto.
  "pending_total" DECIMAL(12, 2) NOT NULL,
  "pending_count" INTEGER NOT NULL,
  "note" VARCHAR(300),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cash_session_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cash_session_site_fk" FOREIGN KEY ("site_id")
    REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "cash_session_user_fk" FOREIGN KEY ("user_id")
    REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "cash_session_amounts_are_not_negative" CHECK (
    "collected_total" >= 0 AND "expected_cash" >= 0 AND "declared_cash" >= 0
    AND "pending_total" >= 0 AND "pending_count" >= 0
  )
);

CREATE UNIQUE INDEX "cash_session_one_per_day"
  ON "cash_session" ("site_id", "user_id", "cash_date");

COMMENT ON TABLE "cash_session" IS
  'Cierre diario de la caja de un usuario en una sede (BI-104, BI-105, BI-252). No se edita.';

-- Lo cobrado por cada medio, con su nombre y su código copiados: la foto dice
-- «Deuna» aunque mañana se renombre.
CREATE TABLE "cash_session_line" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "cash_session_id" UUID NOT NULL,
  "payment_method_id" UUID NOT NULL,
  "method_name" VARCHAR(60) NOT NULL,
  "sri_code" CHAR(2) NOT NULL,
  "payment_count" INTEGER NOT NULL,
  "amount" DECIMAL(12, 2) NOT NULL,

  CONSTRAINT "cash_session_line_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cash_session_line_session_fk" FOREIGN KEY ("cash_session_id")
    REFERENCES "cash_session"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "cash_session_line_payment_method_fk" FOREIGN KEY ("payment_method_id")
    REFERENCES "payment_method"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "cash_session_line_is_positive" CHECK ("payment_count" > 0 AND "amount" > 0)
);

CREATE UNIQUE INDEX "cash_session_line_one_per_method"
  ON "cash_session_line" ("cash_session_id", "payment_method_id");

-- BI-252, BI-253. Un cierre no es de una fecha futura, y se toma el candado de
-- su caja: si la aplicación no lo tomó antes de leer, la comprobación diferida
-- de abajo lo descubre.
CREATE OR REPLACE FUNCTION trg_cash_session_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."cash_date" > (NEW."closed_at" AT TIME ZONE 'America/Guayaquil')::date THEN
    RAISE EXCEPTION 'cash_session_date_in_future: no se cierra un día que no ha llegado'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM cash_day_lock(NEW."site_id", NEW."user_id", NEW."cash_date");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cash_session_guard
  BEFORE INSERT ON "cash_session"
  FOR EACH ROW EXECUTE FUNCTION trg_cash_session_guard();

-- BI-252. La foto no cambia ni se borra; tampoco sus líneas.
CREATE OR REPLACE FUNCTION trg_cash_session_is_final()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'cash_session_is_final: a closed cash session cannot be modified'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cash_session_is_final
  BEFORE UPDATE OR DELETE ON "cash_session"
  FOR EACH ROW EXECUTE FUNCTION trg_cash_session_is_final();

CREATE TRIGGER trg_cash_session_line_is_final
  BEFORE UPDATE OR DELETE ON "cash_session_line"
  FOR EACH ROW EXECUTE FUNCTION trg_cash_session_is_final();

-- BI-252. LA FOTO SUMA LO QUE DE VERDAD SE COBRÓ. Diferida al final de la
-- transacción, porque el cierre y sus líneas son varias filas: cuando se
-- confirma, cada medio dice exactamente lo cobrado con él, el total es la
-- suma, y el efectivo esperado es lo de forma 01. Una línea añadida después a
-- un cierre ya confirmado deja de cuadrar y se rechaza igual.
CREATE OR REPLACE FUNCTION trg_cash_session_matches_its_payments()
RETURNS TRIGGER AS $$
DECLARE
  v_session RECORD;
  v_lines_total NUMERIC(12, 2);
  v_lines_cash NUMERIC(12, 2);
BEGIN
  IF TG_TABLE_NAME = 'cash_session' THEN
    SELECT * INTO v_session FROM "cash_session" WHERE "id" = NEW."id";
  ELSE
    SELECT * INTO v_session FROM "cash_session" WHERE "id" = NEW."cash_session_id";
  END IF;

  SELECT COALESCE(SUM("amount"), 0),
         COALESCE(SUM("amount") FILTER (WHERE "sri_code" = '01'), 0)
    INTO v_lines_total, v_lines_cash
    FROM "cash_session_line" WHERE "cash_session_id" = v_session."id";

  IF v_lines_total <> v_session."collected_total"
     OR v_lines_cash <> v_session."expected_cash"
     OR EXISTS (
       SELECT 1
         FROM (
           SELECT "payment_method_id", SUM("amount") AS "amount", COUNT(*) AS "n"
             FROM "payment"
            WHERE "site_id" = v_session."site_id"
              AND "received_by_id" = v_session."user_id"
              AND "cash_date" = v_session."cash_date"
              AND "reversed_at" IS NULL
            GROUP BY "payment_method_id"
         ) AS p
         FULL JOIN (
           SELECT "payment_method_id", "amount", "payment_count" AS "n"
             FROM "cash_session_line" WHERE "cash_session_id" = v_session."id"
         ) AS l USING ("payment_method_id")
        WHERE p."amount" IS DISTINCT FROM l."amount" OR p."n" IS DISTINCT FROM l."n"
     )
     OR EXISTS (
       SELECT 1 FROM "cash_session_line" AS l
         JOIN "payment_method" AS m ON m."id" = l."payment_method_id"
        WHERE l."cash_session_id" = v_session."id" AND m."sri_code" <> l."sri_code"
     ) THEN
    RAISE EXCEPTION 'cash_session_matches_its_payments: el cierre no suma lo cobrado'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_cash_session_matches_its_payments
  AFTER INSERT ON "cash_session"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_cash_session_matches_its_payments();

CREATE CONSTRAINT TRIGGER trg_cash_session_line_matches_its_payments
  AFTER INSERT ON "cash_session_line"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_cash_session_matches_its_payments();

-- ═══════════════════════════════════════════════════════════════════════════
-- BI-146: EL MEDIO DE PAGO YA NO SE BORRA POR LA CLAVE FORÁNEA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `trg_payment_method_one_stays_active` sigue rechazando el DELETE de un medio
-- sin cobros: un medio que una factura ya declaró tampoco se borra. Nada cambia.
