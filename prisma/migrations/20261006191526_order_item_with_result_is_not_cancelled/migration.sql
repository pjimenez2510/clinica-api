-- order_item_with_result_is_not_cancelled
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy



-- QUÉ GARANTIZA (ORD-131, D-139.1 resuelta por el autor el 06-10-2026):
--
-- Un examen del que cuelga ALGÚN resultado no pasa a ANULADO, aunque le falten
-- otros y siga pendiente. Antes sólo se protegía la línea completada (ORD-008):
-- la de un informe parcial se anulaba y sus valores quedaban bajo una línea
-- anulada, fuera del resumen de la atención. Lo que sigue es editar el informe
-- (ORD-119) o pedir el examen otra vez.
--
-- Se amplía el disparador de ORD-008 en vez de añadir otro: es la misma
-- transición (→ CANCELLED) y un solo sitio la juzga.
--
-- CARRERAS. El disparador de los resultados (`observation_result_not_on_cancelled_line`)
-- lee la línea FOR SHARE; la anulación la bloquea al actualizarla. Si el
-- informe va primero, la anulación espera a su COMMIT y la consulta de abajo
-- —una instantánea nueva por sentencia en READ COMMITTED— ve el resultado. Si
-- la anulación va primero, el informe espera y ve la línea anulada (ORD-124).
--
-- El índice sobre `order_item_id` es para esa consulta: sin él, cada anulación
-- recorrería todos los resultados. NO toca datos: las líneas ya anuladas con
-- resultados (anteriores a esta migración) se quedan como están.
--
-- PARA DESHACERLA: volver a la función de
-- 20261006091024_order_item_cancelled_takes_no_result y
-- `DROP INDEX observation_result_order_item_id_idx`.

CREATE INDEX "observation_result_order_item_id_idx" ON "observation_result" ("order_item_id");

CREATE OR REPLACE FUNCTION service_order_item_completed_is_not_cancelled()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'COMPLETED' AND NEW.status = 'CANCELLED' THEN
    -- El prefijo `<nombre>: ` es lo que lee database-problem.ts: el adaptador
    -- no copia CONSTRAINT para un 23514.
    RAISE EXCEPTION 'service_order_item_completed_is_not_cancelled: Un examen con su resultado no se anula (ORD-008)'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'service_order_item_completed_is_not_cancelled';
  END IF;
  IF NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED'
     AND EXISTS (SELECT 1 FROM observation_result WHERE order_item_id = NEW.id) THEN
    RAISE EXCEPTION 'service_order_item_with_result_is_not_cancelled: Un examen con algún resultado no se anula (ORD-131)'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'service_order_item_with_result_is_not_cancelled';
  END IF;
  RETURN NEW;
END;
$$;
