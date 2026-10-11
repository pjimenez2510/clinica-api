-- result_already_reported_in_corrections
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy




-- QUÉ GARANTIZA (ORD-170, revisión clínica G2 de feat/d223-ordenes-resultados):
--
-- La corrección de un informe tampoco AÑADE el valor de una determinación que
-- ya tiene valor en OTRO informe vigente de la orden. Corregir el informe de la
-- hemoglobina añadiendo «glucosa 95» dejaba la glucosa 25 avisada del segundo
-- envío y la 95 vigentes a la vez, sin cadena: el 95 nunca llegaba a la cola de
-- correcciones (ORD-143), que es lo que D-168 §1 cerró.
--
-- Lo que el informe sustituido ya decía se vuelve a escribir sin juzgarse: es la
-- corrección de esos valores, y una cadena con dos vigentes anteriores a la
-- regla tiene que poder corregirse. El informe sustituido no cuenta como
-- «otro».
--
-- Reemplaza la función de 20261024000000_result_already_reported; el disparador
-- es el mismo.
--
-- PARA DESHACERLA: volver a la función de 20261024000000.

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

  -- La corrección de un valor que el informe sustituido ya tenía.
  IF report_supersedes IS NOT NULL AND EXISTS (
       SELECT 1 FROM observation_result
        WHERE report_id = report_supersedes
          AND analyte_display = NEW.analyte_display
     ) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('observation_result_one_standing_per_analyte:' || report_order::text, 0));

  IF EXISTS (
    SELECT 1
      FROM observation_result other
      JOIN diagnostic_report standing ON standing.id = other.report_id
     WHERE standing.service_order_id = report_order
       AND standing.id <> NEW.report_id
       AND standing.id IS DISTINCT FROM report_supersedes
       AND standing.status <> 'CANCELLED'
       AND NOT EXISTS (
             SELECT 1 FROM diagnostic_report correction
              WHERE correction.supersedes_id = standing.id)
       AND other.analyte_display = NEW.analyte_display
  ) THEN
    RAISE EXCEPTION 'observation_result_one_standing_per_analyte: Esa determinación ya tiene un valor vigente en la orden (ORD-170)'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'observation_result_one_standing_per_analyte';
  END IF;
  RETURN NEW;
END;
$$;
