-- document_kind_credit_note_ride
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy


-- QUÉ GARANTIZA (SRI-089): que el RIDE de la nota de crédito sea una clase
-- de documento propia, archivada como el de la factura (DOC-002), para que
-- `sri` lo adjunte al correo de la nota de crédito autorizada (SRI-072).
--
-- EN UNA MIGRACIÓN PROPIA porque un valor nuevo de un enum no se puede usar en
-- la misma transacción que lo añade, y la siguiente lo usa en
-- `document_render_kind_matches_subject`.
--
-- No lleva plantilla propia: se compone con la vigente de INVOICE_RIDE (la
-- identidad visual es una sola, D-095.3), así que ninguna fila de
-- `document_template` se escribe con esta clase.

ALTER TYPE "document_kind" ADD VALUE IF NOT EXISTS 'CREDIT_NOTE_RIDE';
