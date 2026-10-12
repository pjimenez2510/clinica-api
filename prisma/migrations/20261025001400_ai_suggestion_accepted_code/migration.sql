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
-- 3. El código aceptado es uno de los candidatos de la propuesta y una línea
--    sin anular de la orden enlazada (revisión de seguridad del 12-10-2026):
--    sin esto, una escritura directa podría marcar como obra de la propuesta
--    un examen que no propuso.
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

CREATE OR REPLACE FUNCTION ai_suggestion_accepted_code_of_its_order()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."accepted_code" IS NULL OR OLD."status" <> 'PROPOSED' THEN
    RETURN NEW;
  END IF;
  IF NOT (NEW."proposal" -> 'codes' ? NEW."accepted_code")
     OR NOT EXISTS (
       SELECT 1 FROM "service_order_item"
        WHERE "service_order_id" = NEW."service_order_id"
          AND "test_code" = NEW."accepted_code"
          AND "status" <> 'CANCELLED') THEN
    RAISE EXCEPTION 'ai_suggestion_accepted_code_of_its_order: the accepted exam is not a candidate on a live line of the order'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'ai_suggestion_accepted_code_of_its_order',
            HINT = 'AS-109. El examen aceptado es un candidato de la propuesta y una línea viva de la orden.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ai_suggestion_accepted_code_of_its_order"
  BEFORE UPDATE ON "ai_suggestion"
  FOR EACH ROW EXECUTE FUNCTION ai_suggestion_accepted_code_of_its_order();

COMMIT;
