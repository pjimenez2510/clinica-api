-- order_item_cancelled_takes_no_result
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy


-- QUÉ GARANTIZA (ORD-124, ORD-008; revisión de fix/ordenes-documentos-resumen):
--
-- 1. Ningún resultado apunta a una línea ANULADA: ni al insertarlo con el
--    informe ni al emparejarlo después (ORD-043). Antes lo decía sólo la
--    aplicación, y entre su lectura y su escritura otra sesión podía anular la
--    línea.
-- 2. Una línea COMPLETADA no pasa a ANULADA (ORD-008). La anulación leía el
--    estado sin bloqueo; si esperaba al informe que la completaba, escribía
--    después «anulada» sobre una línea con todos sus resultados.
--
-- El disparador lee la línea con FOR SHARE: una anulación de la misma línea en
-- curso espera o hace esperar, y lo que se compara es lo confirmado.
--
-- No toca datos: sólo mira escrituras nuevas. Los resultados que ya cuelgan de
-- una línea anulada (un parcial cuya línea se anuló después) se quedan como
-- están; anular una línea con resultado parcial es D-139.

CREATE OR REPLACE FUNCTION observation_result_not_on_cancelled_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
BEGIN
  IF NEW.order_item_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.order_item_id IS NOT DISTINCT FROM OLD.order_item_id THEN
    RETURN NEW;
  END IF;
  SELECT status::text INTO v_status
    FROM service_order_item
   WHERE id = NEW.order_item_id
     FOR SHARE;
  IF v_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Un resultado no responde a un examen anulado (ORD-124)'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'observation_result_not_on_cancelled_line';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_observation_result_not_on_cancelled_line ON "observation_result";
CREATE TRIGGER trg_observation_result_not_on_cancelled_line
  BEFORE INSERT OR UPDATE OF "order_item_id" ON "observation_result"
  FOR EACH ROW EXECUTE FUNCTION observation_result_not_on_cancelled_line();

CREATE OR REPLACE FUNCTION service_order_item_completed_is_not_cancelled()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'COMPLETED' AND NEW.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Un examen con su resultado no se anula (ORD-008)'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'service_order_item_completed_is_not_cancelled';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_service_order_item_completed_is_not_cancelled ON "service_order_item";
CREATE TRIGGER trg_service_order_item_completed_is_not_cancelled
  BEFORE UPDATE OF "status" ON "service_order_item"
  FOR EACH ROW EXECUTE FUNCTION service_order_item_completed_is_not_cancelled();
