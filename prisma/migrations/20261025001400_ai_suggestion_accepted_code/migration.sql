-- ai_suggestion_accepted_code
--
-- Escrito a mano. feat/ia-d3-examenes (D3), AS-109.
--
-- Un examen propuesto se acepta ELIGIENDO uno de sus candidatos, y elegir
-- cualquiera de ellos es «tal cual» (distancia 0, como un diagnóstico). Sin
-- guardar cuál se eligió, nada dice qué línea de la orden es obra de la
-- propuesta: dos propuestas con candidatos en común («biometría y glucosa»,
-- dos líneas de una misma frase) podrían responder por la MISMA línea, y la
-- fase F la contaría dos veces. La línea de una orden no tiene identidad
-- propia (D-243 §5); su servicio, en esa orden, sí: el código.
--
-- 1. `accepted_code`: el código del servicio aceptado. Está exactamente
--    cuando una propuesta de examen se aceptó, y en ninguna otra fila. Lo
--    fija la decisión; después no cambia (`ai_suggestion_decided_once` ya
--    rechaza toda escritura sobre una propuesta decidida).
-- 2. Un examen de una orden responde por UNA propuesta, como un diagnóstico
--    (`ai_suggestion_one_per_diagnosis`).
BEGIN;

ALTER TABLE "ai_suggestion" ADD COLUMN "accepted_code" VARCHAR(32);

ALTER TABLE "ai_suggestion" ADD CONSTRAINT "ai_suggestion_accepted_code_of_an_accepted_exam"
  CHECK (
    ("kind" = 'order-item' AND "status" IN ('ACCEPTED', 'ACCEPTED_WITH_CHANGES'))
    = ("accepted_code" IS NOT NULL)
  );

CREATE UNIQUE INDEX "ai_suggestion_one_per_ordered_exam"
  ON "ai_suggestion" ("service_order_id", "accepted_code")
  WHERE "service_order_id" IS NOT NULL;

COMMIT;
