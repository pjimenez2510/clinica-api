-- result_already_reported
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy




-- QUÉ GARANTIZA (ORD-170, D-168 §1 decidida por el autor en D-223):
--
-- Un informe que NO corrige a otro (`supersedes_id` vacío) no trae el valor de
-- una determinación que ya tiene valor en un informe VIGENTE de la misma
-- orden: ni sustituido (ningún informe lo nombra en `supersedes_id`) ni
-- anulado. El 95 transcrito como informe nuevo junto al 25 avisado dejaba dos
-- valores vigentes sin cadena de corrección, y el 95 nunca entraba en la cola
-- de correcciones (ORD-143). Cambiar un valor que ya está es la corrección de
-- su informe (ORD-050, ORD-119), que sí encadena los dos.
--
-- La determinación se compara por `analyte_display`: es el nombre con el que
-- la cadena de correcciones empareja los valores (ORD-031: la fila no apunta a
-- su definición) y no cambia mientras tenga resultados (ORD-110).
--
-- La CORRECCIÓN no se juzga aquí: sustituye a su informe, y una cadena con dos
-- vigentes anteriores a esta regla tiene que poder corregirse.
--
-- CARRERAS. Dos informes nuevos de la misma orden a la vez (un doble clic, el
-- mismo papel en dos puestos): el bloqueo consultivo de la transacción, por
-- orden, hace esperar al segundo, y su consulta —una instantánea nueva por
-- sentencia en READ COMMITTED— ve el valor que el primero confirmó. Consultivo
-- y no `FOR UPDATE` sobre la orden: así no se cruza con ningún otro bloqueo de
-- `service_order` y no abre un interbloqueo nuevo.
--
-- NO toca datos: los informes anteriores con valores repetidos se quedan.
--
-- PARA DESHACERLA: `DROP TRIGGER trg_observation_result_one_standing_per_analyte
-- ON observation_result; DROP FUNCTION observation_result_one_standing_per_analyte();`

CREATE OR REPLACE FUNCTION observation_result_one_standing_per_analyte()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  report_order uuid;
  report_supersedes uuid;
BEGIN
  SELECT service_order_id, supersedes_id
    INTO report_order, report_supersedes
    FROM diagnostic_report
   WHERE id = NEW.report_id;

  IF report_supersedes IS NOT NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('observation_result_one_standing_per_analyte:' || report_order::text, 0));

  IF EXISTS (
    SELECT 1
      FROM observation_result other
      JOIN diagnostic_report standing ON standing.id = other.report_id
     WHERE standing.service_order_id = report_order
       AND standing.id <> NEW.report_id
       AND standing.status <> 'CANCELLED'
       AND NOT EXISTS (
             SELECT 1 FROM diagnostic_report correction
              WHERE correction.supersedes_id = standing.id)
       AND other.analyte_display = NEW.analyte_display
  ) THEN
    -- El prefijo `<nombre>: ` es lo que lee database-problem.ts: el adaptador
    -- no copia CONSTRAINT para un 23514.
    RAISE EXCEPTION 'observation_result_one_standing_per_analyte: Esa determinación ya tiene un valor vigente en la orden (ORD-170)'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'observation_result_one_standing_per_analyte';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_observation_result_one_standing_per_analyte
  BEFORE INSERT ON observation_result
  FOR EACH ROW EXECUTE FUNCTION observation_result_one_standing_per_analyte();
