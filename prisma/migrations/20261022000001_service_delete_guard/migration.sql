-- ═══════════════════════════════════════════════════════════════════════════
-- BI-288, ORD-002 (revisión de feat/f08-catalogo-servicios). Lo que la base
-- garantiza del catálogo único, después de 20261022000000_service_catalogue.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. UN SERVICIO YA PEDIDO NO SE BORRA. La línea de orden congela el CÓDIGO
--    (ORD-002) y no lleva clave hacia el servicio, así que ninguna `RESTRICT`
--    lo impedía: contar y borrar en dos pasos dejaba pasar una orden emitida
--    entre medias, y la orden quedaba sin determinaciones que transcribir —o
--    con las de otro servicio que tomara ese código después—. El que emite la
--    orden bloquea el servicio `FOR SHARE` en su transacción (`linesOf`); el
--    borrado espera, y este disparador ve la línea ya confirmada.
CREATE OR REPLACE FUNCTION service_not_deleted_once_ordered()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "service_order_item" WHERE "test_code" = OLD."code") THEN
    RAISE EXCEPTION 'service_code_in_use: an order line names this service'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'service_code_in_use',
            HINT = 'Un servicio ya pedido no se borra: se desactiva (BI-288, ORD-002).';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "trg_service_not_deleted_once_ordered"
  BEFORE DELETE ON "service"
  FOR EACH ROW EXECUTE FUNCTION service_not_deleted_once_ordered();

-- 2. NINGUNA EXTENSIÓN DE ORDEN SOBRE LO QUE NO SE PIDE. La migración anterior
--    copió las extensiones de `exam_definition` antes de crear
--    `trg_service_exam_kind_admits`, así que nada las validó. En la base del
--    autor no hay ninguna fuera de sitio (comprobado el 11-10-2026); si una
--    base las tuviera, se para aquí y se dice cuál, en vez de dejar un examen
--    que desaparece del catálogo sin aviso.
DO $$
DECLARE
  misplaced TEXT;
BEGIN
  SELECT string_agg(s."code" || ' (' || s."kind" || ')', ', ')
    INTO misplaced
    FROM "service_exam" e
    JOIN "service" s ON s."id" = e."service_id"
   WHERE s."kind" NOT IN ('LAB_EXAM', 'IMAGING', 'PROCEDURE');
  IF misplaced IS NOT NULL THEN
    RAISE EXCEPTION 'service_exam_kind_admits: order extension on a kind that is not ordered: %', misplaced
      USING ERRCODE = 'check_violation',
            HINT = 'Corregir el tipo de esos servicios antes de migrar (BI-284).';
  END IF;
END;
$$;
