-- encounter_exit_fewer_questions
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-218 (D-126.2, AT-21): ANULAR LA ATENCIÓN NO EXIGE MOTIVO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Anular una atención abierta por error pide UNA confirmación que dice la
-- consecuencia, y el motivo pasa a ser opcional, de una lista de la pantalla
-- («Paciente equivocado», «Duplicada», «Otro»). Lo que la norma sí necesita
-- —quién anuló y cuándo— sigue siendo obligatorio, en la propia fila.
--
-- `encounter_entered_in_error_states_who_why_when` se sustituye por
-- `encounter_entered_in_error_states_who_when`: ya no dice «why», y un
-- nombre que promete lo que no garantiza engaña a quien lee el error. Sigue
-- exigiendo que un motivo, si lo hay, no esté en blanco, y que una atención
-- viva no lleve ninguno de los tres datos.
--
-- Lo que esta migración NO toca, y por qué:
--   · `encounter_exit_substitute_reason_belongs_to_an_exit` sólo dice que el
--     motivo de sustitución vive en una salida; nunca lo exigió. Que
--     actuar en nombre de otro deje de pedirlo (AT-23) es del servicio: quién
--     lo hizo ya está en `entered_in_error_by_id` / `discontinued_by_id`.
--   · `encounter_discontinued_states_who_why_when`: interrumpir sigue con
--     motivo y origen (AT-19 los toma de una lista que ya lleva el origen).
--   · Descartar los borradores al anular es del adaptador, en la misma
--     transacción (EN-218): los estados `DISCARDED` y sus columnas ya los
--     garantizan `prescription_discard_states_who_and_when` y
--     `service_order_discard_states_who_and_when`.
--
-- Las filas existentes cumplen la regla nueva, que es más ancha: toda
-- anulada tenía los tres datos.

ALTER TABLE "encounter"
  DROP CONSTRAINT "encounter_entered_in_error_states_who_why_when";

ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_entered_in_error_states_who_when" CHECK (
    (
      "status" = 'ENTERED_IN_ERROR'
      AND "entered_in_error_by_id" IS NOT NULL
      AND "entered_in_error_at" IS NOT NULL
      AND ("entered_in_error_reason" IS NULL
           OR btrim("entered_in_error_reason") <> '')
    )
    OR (
      "status" <> 'ENTERED_IN_ERROR'
      AND "entered_in_error_reason" IS NULL
      AND "entered_in_error_by_id" IS NULL
      AND "entered_in_error_at" IS NULL
    )
  );
