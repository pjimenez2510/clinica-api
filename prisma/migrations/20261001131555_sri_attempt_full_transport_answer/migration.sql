-- sri_attempt_full_transport_answer
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- SRI-059. El 01-10-2026 la recepción de pruebas del SRI (celcer) contestó
-- HTTP 500 con un `soap:Fault` de `javax.persistence.PersistenceException`, y
-- el intento guardó 210 caracteres: la causa quedó cortada. Desde aquí, un
-- fallo de transporte con respuesta guarda su estado HTTP, el `faultcode`, el
-- `faultstring` y el `detail` completos, y el cuerpo tal como llegó.
--
-- TOPE: 16 384 caracteres por texto, más la marca del corte que pone el
-- cliente (`… [cortado: N caracteres más]`). 16 640 deja sitio a la marca y
-- a nada más: un cuerpo sin cortar mayor que eso es un defecto del cliente,
-- y la base lo dice en vez de llenarse.
--
-- Lo que se guarda es la RESPUESTA del SRI; la petición firmada no se copia
-- (el cliente la sustituye por una marca si vuelve en la respuesta).
--
-- La tabla es de solo añadir (`trg_sri_trail_is_append_only`): ese disparador
-- es de fila, y ni el cambio de tipo ni las columnas nuevas tocan filas. Las
-- filas antiguas tienen todo lo nuevo en NULL, que cumple cada CHECK.

-- El resumen del fallo deja de cortarse a 500: VARCHAR(500) → TEXT no reescribe
-- la tabla en PostgreSQL.
ALTER TABLE "electronic_voucher_attempt"
  ALTER COLUMN "transport_error" TYPE TEXT;

ALTER TABLE "electronic_voucher_attempt"
  ADD COLUMN "http_status"   INTEGER,
  ADD COLUMN "fault_code"    TEXT,
  ADD COLUMN "fault_string"  TEXT,
  ADD COLUMN "fault_detail"  TEXT,
  ADD COLUMN "response_body" TEXT;

ALTER TABLE "electronic_voucher_attempt"
  ADD CONSTRAINT "electronic_voucher_attempt_detail_only_on_transport_failure"
    CHECK (
      "outcome" = 'TRANSPORT_FAILURE'
      OR num_nonnulls("http_status", "fault_code", "fault_string", "fault_detail", "response_body") = 0
    ),
  ADD CONSTRAINT "electronic_voucher_attempt_http_status_is_http"
    CHECK ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599),
  ADD CONSTRAINT "electronic_voucher_attempt_response_is_capped"
    CHECK (
      coalesce(char_length("transport_error"), 0) <= 16640
      AND coalesce(char_length("fault_code"), 0) <= 16640
      AND coalesce(char_length("fault_string"), 0) <= 16640
      AND coalesce(char_length("fault_detail"), 0) <= 16640
      AND coalesce(char_length("response_body"), 0) <= 16640
    );
