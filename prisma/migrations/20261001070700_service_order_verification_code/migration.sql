-- service_order_verification_code
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- QUÉ GARANTIZA (D-095): que la orden lleve, como la receta y el certificado,
-- un código corto con el que un laboratorio la comprueba sin recibir ningún
-- dato clínico. Es ALEATORIO a propósito y no es el número (ORD-006): un código
-- secuencial impreso en un papel que sale del edificio dejaría enumerar las
-- demás órdenes a quien tenga una.
--
-- Lo genera la base al insertar, así que ningún escritor —repositorio,
-- importación, `psql`— deja una orden sin código. `gen_random_uuid()` es
-- aleatorio (v4); dieciséis caracteres hexadecimales de su md5 bastan, y la
-- unicidad la dice la base por si acaso.

ALTER TABLE "service_order"
  ADD COLUMN IF NOT EXISTS "verification_code" VARCHAR(16);

UPDATE "service_order"
   SET "verification_code" = upper(substr(md5(gen_random_uuid()::text), 1, 16))
 WHERE "verification_code" IS NULL;

ALTER TABLE "service_order"
  ALTER COLUMN "verification_code" SET DEFAULT upper(substr(md5(gen_random_uuid()::text), 1, 16)),
  ALTER COLUMN "verification_code" SET NOT NULL;

ALTER TABLE "service_order"
  DROP CONSTRAINT IF EXISTS "service_order_verification_code_key";
ALTER TABLE "service_order"
  ADD CONSTRAINT "service_order_verification_code_key" UNIQUE ("verification_code");
