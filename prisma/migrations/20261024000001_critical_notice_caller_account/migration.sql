-- critical_notice_caller_account
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy




-- QUÉ GARANTIZA (ORD-175, D-168 §4 decidida por el autor en D-223):
--
-- Quien hizo la llamada, cuando no fue quien registra, se elige de las cuentas
-- de la sede: la constancia guarda la cuenta (`caller_id`) además de su nombre
-- tal como se dijo (`caller_name`), para que juzgar el autoaviso no dependa de
-- un texto que se puede escribir a medias. Escrito a mano, el servicio exige al
-- menos dos palabras.
--
-- La cuenta apunta a "app_user" sin borrado en cascada: una cuenta con constancias
-- no se borra (se desactiva). Una cuenta sin nombre de quien llamó no dice
-- nada: `critical_result_notice_caller_account_named`.
--
-- La columna nueva viaja en `record_version` como el resto de la fila: el
-- archivo guarda `to_jsonb(OLD)` entero.
--
-- NO toca datos: las constancias existentes nacen sin cuenta.
--
-- PARA DESHACERLA: `ALTER TABLE critical_result_notice DROP COLUMN caller_id;`

ALTER TABLE "critical_result_notice"
  ADD COLUMN "caller_id" UUID REFERENCES "app_user"("id") ON DELETE RESTRICT;

ALTER TABLE "critical_result_notice"
  ADD CONSTRAINT "critical_result_notice_caller_account_named" CHECK (
    "caller_id" IS NULL OR "caller_name" IS NOT NULL
  );
