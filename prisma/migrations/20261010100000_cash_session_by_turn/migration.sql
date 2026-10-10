-- cash_session_by_turn
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Después: pnpm migrations:check && pnpm db:deploy
--
-- billing B6, D-197.4 (aceptada el 09-10-2026): EL CIERRE VA POR TURNO, NO
-- POR FECHA. Enmienda BI-104, BI-252, BI-253 y BI-255.
--
-- Antes, la caja de un usuario en una sede era la de un día, y cerrarla
-- impedía cobrar hasta el día siguiente. Ahora un cierre abarca los cobros de
-- esa caja que aún no estaban en un cierre, y el cobro siguiente abre el turno
-- siguiente: varios cierres al día, y cerrar no frena a nadie.
--
-- El turno abierto es «los cobros sin cierre» (`payment.cash_session_id`
-- vacío), y no «los cobros después del último cierre» por su instante: un
-- cobro cuyo reloj marcó un instante anterior al cierre pero que se escribió
-- después no tiene por qué rechazarse ni perderse; queda vacío y entra en el
-- turno siguiente.
--
-- SIN RELLENO (desarrollo, datos borrables): los cierres que hubiera se
-- borran, y sus cobros vuelven al turno abierto de su caja.

-- ═══════════════════════════════════════════════════════════════════════════
-- LO QUE SE VA: EL CIERRE POR FECHA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- DROP TABLE no dispara `trg_cash_session_is_final` (es de fila): es la única
-- manera de borrar una foto, y sólo la tiene una migración.
DROP TABLE "cash_session_line";
DROP TABLE "cash_session";
DROP FUNCTION trg_cash_session_guard();
DROP FUNCTION trg_cash_session_matches_its_payments();

-- ═══════════════════════════════════════════════════════════════════════════
-- BI-253: LA CAJA DE UN USUARIO EN UNA SEDE SE CIERRA DE UNA EN UNA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El cierre lo toma ANTES de leer los cobros del turno; la reversión, antes
-- de escribir. Así una reversión concurrente con el cierre o entra en la foto
-- o encuentra el cobro ya cerrado. El cobro no lo necesita: nace sin cierre,
-- y el cierre sólo marca los que leyó. La aplicación lo toma antes de su
-- UPDATE (los candados de transacción son reentrantes): si lo tomara sólo el
-- disparador, con la fila ya bloqueada, se cruzaría con el cierre.
CREATE OR REPLACE FUNCTION cash_drawer_lock(p_site UUID, p_user UUID)
RETURNS VOID AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('cash_drawer:' || p_site || ':' || p_user, 0)
  );
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════════
-- BI-104, BI-105, BI-252: EL CIERRE DE UN TURNO, UNA FOTO QUE NO SE EDITA
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE "cash_session" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "site_id" UUID NOT NULL,
  -- De quién es la caja, que es quien la cierra (BI-104, D-197.5).
  "user_id" UUID NOT NULL,
  -- El instante del cierre, del reloj de la aplicación. «Desde cuándo» es el
  -- cierre anterior de la misma caja (BI-258): derivado, no guardado.
  "closed_at" TIMESTAMPTZ(6) NOT NULL,
  "collected_total" DECIMAL(12, 2) NOT NULL,
  -- BI-105, D-197.1. Lo cobrado con medios de forma de pago 01, y lo contado
  -- sin el fondo de cambio.
  "expected_cash" DECIMAL(12, 2) NOT NULL,
  "declared_cash" DECIMAL(12, 2) NOT NULL,
  -- Lo que sobra (+) o falta (−). Registrado, nunca un motivo para no cerrar.
  "difference" DECIMAL(12, 2) GENERATED ALWAYS AS ("declared_cash" - "expected_cash") STORED,
  -- Lo que facturó en el turno y seguía sin cobrar al cerrar: cambia después,
  -- y por eso es parte de la foto.
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

-- BI-251, BI-258: el último cierre de una caja, y los de un día, en orden.
CREATE INDEX "cash_session_by_drawer"
  ON "cash_session" ("site_id", "user_id", "closed_at");

COMMENT ON TABLE "cash_session" IS
  'Cierre de un turno de la caja de un usuario en una sede (BI-104, BI-105, BI-252). No se edita.';

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

-- BI-252, BI-253. Un cierre se toma con el candado de su caja y va después
-- del anterior: el turno es «desde el cierre anterior», y dos cierres en el
-- mismo instante, o uno anterior al último, dejarían el turno sin principio.
CREATE OR REPLACE FUNCTION trg_cash_session_guard()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM cash_drawer_lock(NEW."site_id", NEW."user_id");
  IF EXISTS (
    SELECT 1 FROM "cash_session"
     WHERE "site_id" = NEW."site_id" AND "user_id" = NEW."user_id"
       AND "closed_at" >= NEW."closed_at"
  ) THEN
    RAISE EXCEPTION 'cash_session_after_the_last: un cierre va después del último de su caja'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cash_session_guard
  BEFORE INSERT ON "cash_session"
  FOR EACH ROW EXECUTE FUNCTION trg_cash_session_guard();

-- BI-252. La foto no cambia ni se borra; tampoco sus líneas. La función es la
-- de la migración anterior, que sigue viva.
CREATE TRIGGER trg_cash_session_is_final
  BEFORE UPDATE OR DELETE ON "cash_session"
  FOR EACH ROW EXECUTE FUNCTION trg_cash_session_is_final();

CREATE TRIGGER trg_cash_session_line_is_final
  BEFORE UPDATE OR DELETE ON "cash_session_line"
  FOR EACH ROW EXECUTE FUNCTION trg_cash_session_is_final();

-- ═══════════════════════════════════════════════════════════════════════════
-- BI-104, BI-252: CADA COBRO DICE EN QUÉ CIERRE QUEDÓ
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "payment"
  ADD COLUMN "cash_session_id" UUID,
  ADD CONSTRAINT "payment_cash_session_fk" FOREIGN KEY ("cash_session_id")
    REFERENCES "cash_session"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- El turno abierto de una caja es lo que se lee al abrir «Caja» y al cerrar.
CREATE INDEX "payment_open_turn"
  ON "payment" ("site_id", "received_by_id") WHERE "cash_session_id" IS NULL;
CREATE INDEX "payment_by_cash_session"
  ON "payment" ("cash_session_id") WHERE "cash_session_id" IS NOT NULL;

COMMENT ON COLUMN "payment"."cash_session_id" IS
  'El cierre que abarca el cobro (BI-252); vacío mientras su turno está abierto.';

-- BI-101, BI-247, BI-248, BI-250. Como en la migración anterior, salvo dos
-- cosas: un cobro ya no se rechaza por una caja cerrada (BI-104: entra en el
-- turno siguiente), y nace sin cierre.
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
  IF NEW."cash_session_id" IS NOT NULL THEN
    RAISE EXCEPTION 'payment_is_born_open: un cobro nace en el turno abierto'
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

-- BI-102, BI-104, BI-252. Un cobro admite dos cambios, cada uno una vez y
-- nunca juntos: su reversión, mientras su turno está abierto, y pasar al
-- cierre de SU caja que lo abarca. Cerrado, nada más. Borrarlo, nunca.
CREATE OR REPLACE FUNCTION trg_payment_only_reverses()
RETURNS TRIGGER AS $$
DECLARE
  v_session RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment is never deleted: se revierte con motivo'
      USING ERRCODE = 'insufficient_privilege';
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

  -- BI-104. Ya en un cierre: ni su reversión ni otro cierre.
  IF OLD."cash_session_id" IS NOT NULL THEN
    RAISE EXCEPTION 'cash_session_closed: el cobro ya está en un cierre'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW."cash_session_id" IS NOT NULL THEN
    -- BI-252. El cierre que lo abarca: el de su caja, en su sede, y no
    -- anterior a su instante. Sin tocar su reversión en el mismo acto.
    IF NEW."reversed_at" IS DISTINCT FROM OLD."reversed_at"
       OR NEW."reversed_by_id" IS DISTINCT FROM OLD."reversed_by_id"
       OR NEW."reversal_reason" IS DISTINCT FROM OLD."reversal_reason" THEN
      RAISE EXCEPTION 'payment cannot be modified: se revierte o se cierra, no las dos'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT "site_id", "user_id", "closed_at" INTO v_session
      FROM "cash_session" WHERE "id" = NEW."cash_session_id";
    IF v_session."site_id" IS DISTINCT FROM OLD."site_id"
       OR v_session."user_id" IS DISTINCT FROM OLD."received_by_id"
       OR v_session."closed_at" < OLD."received_at" THEN
      RAISE EXCEPTION 'payment_session_is_its_drawer: el cobro va al cierre de su caja'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."reversed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'payment_already_reversed: el cobro ya está revertido'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM cash_drawer_lock(OLD."site_id", OLD."received_by_id");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- El candado por fecha ya no lo usa nadie.
DROP FUNCTION cash_day_lock(UUID, UUID, DATE);

-- ═══════════════════════════════════════════════════════════════════════════
-- BI-252. LA FOTO SUMA LO QUE DE VERDAD ABARCA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Diferida al final de la transacción, porque el cierre, sus líneas y la
-- marca de sus cobros son varias filas: cuando se confirma, cada medio dice
-- exactamente lo cobrado (sin revertir) con él entre los cobros que el cierre
-- abarca, el total es la suma, y el efectivo esperado es lo de forma 01. Una
-- línea añadida o un cobro marcado después, sobre un cierre ya confirmado,
-- dejan de cuadrar y se rechazan igual.
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
  IF v_session."id" IS NULL THEN
    RETURN NULL;
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
            WHERE "cash_session_id" = v_session."id"
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

CREATE CONSTRAINT TRIGGER trg_payment_closed_matches_its_session
  AFTER UPDATE OF "cash_session_id" ON "payment"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."cash_session_id" IS NOT NULL)
  EXECUTE FUNCTION trg_cash_session_matches_its_payments();
