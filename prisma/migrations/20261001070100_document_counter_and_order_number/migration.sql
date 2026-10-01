-- document_counter_and_order_number
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- QUÉ GARANTIZA: que cada documento clínico que se entrega en papel lleve un
-- número propio, consecutivo POR SEDE y SIN HUECOS, que nadie elige y nadie
-- cambia. Hoy lo usa la orden (ORD-006, A.M. 00002393 art. 43); la receta
-- (PR-020) y el certificado (CER-009) se suman en sus migraciones.
--
-- POR QUÉ UN CONTADOR Y NO UNA `SEQUENCE`. `patient_mrn_seq` es una secuencia
-- y para la historia clínica está bien: un hueco allí no significa nada. Aquí
-- sí: una inspección que encuentra la orden 41 y la 43 pregunta por la 42. Una
-- secuencia no vuelve atrás cuando la transacción se revierte; una fila de
-- contador que se actualiza DENTRO de la transacción sí. El precio es que dos
-- emisiones de la misma sede y del mismo tipo esperan una a la otra el tiempo
-- de un `UPDATE`, que en una clínica no se nota.
--
-- POR QUÉ POR SEDE. Cada sede tiene su unicódigo del MSP, que es el
-- «establecimiento de salud» de los formularios. D-074 lo deja abierto con esa
-- recomendación; cambiarlo es cambiar la clave de este contador.
--
-- POR QUÉ EN UN DISPARADOR. Si lo asignara el repositorio, un `INSERT` por SQL
-- directo —una importación, un `psql`— crearía una orden sin número o con el
-- que quisiera. El disparador lo asigna siempre y PISA cualquier valor que
-- traiga la fila.

CREATE TABLE IF NOT EXISTS "document_counter" (
  "site_id"     UUID        NOT NULL,
  "kind"        VARCHAR(32) NOT NULL,
  "last_number" INTEGER     NOT NULL DEFAULT 0,
  CONSTRAINT "document_counter_pkey" PRIMARY KEY ("site_id", "kind"),
  CONSTRAINT "document_counter_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT,
  CONSTRAINT "document_counter_kind_is_known"
    CHECK ("kind" IN ('PRESCRIPTION', 'SERVICE_ORDER', 'MEDICAL_CERTIFICATE')),
  CONSTRAINT "document_counter_not_negative" CHECK ("last_number" >= 0)
);

COMMENT ON TABLE "document_counter" IS
  'Último número entregado por sede y tipo de documento. Se incrementa dentro '
  'de la transacción que emite, así que una emisión revertida devuelve su '
  'número y la serie no tiene huecos (ORD-006, PR-020, CER-009).';

-- El siguiente número de (sede, tipo). La fila del contador queda bloqueada
-- hasta el fin de la transacción: es lo que serializa a dos emisores y lo que
-- hace que un ROLLBACK deshaga el incremento.
CREATE OR REPLACE FUNCTION next_document_number(p_site_id UUID, p_kind TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  assigned INTEGER;
BEGIN
  INSERT INTO document_counter (site_id, kind, last_number)
  VALUES (p_site_id, p_kind, 1)
  ON CONFLICT (site_id, kind)
    DO UPDATE SET last_number = document_counter.last_number + 1
  RETURNING last_number INTO assigned;
  RETURN assigned;
END;
$$;

-- ── La orden ─────────────────────────────────────────────────────────────

ALTER TABLE "service_order" ADD COLUMN IF NOT EXISTS "number" INTEGER;

-- Las órdenes que ya existen se numeran por sede en el orden en que se
-- pidieron, y el contador arranca detrás de la última.
WITH numbered AS (
  SELECT id,
         row_number() OVER (PARTITION BY site_id ORDER BY requested_at, id) AS n
  FROM service_order
)
UPDATE service_order so
   SET number = numbered.n
  FROM numbered
 WHERE so.id = numbered.id;

INSERT INTO document_counter (site_id, kind, last_number)
SELECT site_id, 'SERVICE_ORDER', max(number)
  FROM service_order
 GROUP BY site_id
ON CONFLICT (site_id, kind) DO UPDATE SET last_number = EXCLUDED.last_number;

-- El valor por defecto sólo existe para que Prisma pueda omitir la columna al
-- crear: el disparador lo pisa siempre.
ALTER TABLE "service_order" ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "service_order" ALTER COLUMN "number" SET NOT NULL;

ALTER TABLE "service_order"
  DROP CONSTRAINT IF EXISTS "service_order_site_number_unique";
ALTER TABLE "service_order"
  ADD CONSTRAINT "service_order_site_number_unique" UNIQUE ("site_id", "number");

CREATE OR REPLACE FUNCTION service_order_assign_number()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.number := next_document_number(NEW.site_id, 'SERVICE_ORDER');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "service_order_number_assigned" ON "service_order";
CREATE TRIGGER "service_order_number_assigned"
  BEFORE INSERT ON "service_order"
  FOR EACH ROW
  EXECUTE FUNCTION service_order_assign_number();

CREATE OR REPLACE FUNCTION service_order_number_is_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.number IS DISTINCT FROM OLD.number
     OR NEW.site_id IS DISTINCT FROM OLD.site_id THEN
    RAISE EXCEPTION
      'service_order_number_immutable: the number and the site of an order never change'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'ORD-006 (A.M. 00002393 art. 43). The number is printed on the '
                   'request the patient carries; changing it breaks the match '
                   'when the report comes back on paper.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "service_order_number_immutable" ON "service_order";
CREATE TRIGGER "service_order_number_immutable"
  BEFORE UPDATE ON "service_order"
  FOR EACH ROW
  EXECUTE FUNCTION service_order_number_is_immutable();
