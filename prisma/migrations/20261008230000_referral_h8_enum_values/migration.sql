-- referral_h8_enum_values
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- QUÉ GARANTIZA (encounter H8):
--
--  * EN-100. La cuarta dirección del subsistema: la REFERENCIA INVERSA
--    (columna 109 del RDACAA, código 4). Sin ella se registraría como
--    referencia y el reporte diría que esta clínica envió a un paciente que se
--    presentó por su cuenta.
--  * EN-107, D-103 §3. Que una referencia emitida por error pueda ANULARSE:
--    `REJECTED` es «el destino no la aceptó», que es otra cosa.
--  * EN-243. El 053 y el 007 como clase de documento que se compone al pedirla
--    y no se archiva, como el resumen de la atención:
--    `document_render_kind_matches_subject` exige una columna de sujeto que
--    esta clase no tiene, así que ninguna fila de `document_render` puede ser
--    de ella.
--
-- EN UNA MIGRACIÓN PROPIA porque un valor nuevo de un enum no se puede usar en
-- la misma transacción que lo añade, y la siguiente lo usa en sus CHECK y
-- disparadores.

ALTER TYPE "referral_direction" ADD VALUE IF NOT EXISTS 'REVERSE_REFERRAL';
ALTER TYPE "referral_status" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "document_kind" ADD VALUE IF NOT EXISTS 'CLINICAL_FORM';
