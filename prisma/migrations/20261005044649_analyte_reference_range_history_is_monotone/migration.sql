-- analyte_reference_range_history_is_monotone
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- QUÉ GARANTIZA (orders/SPEC.md ORD-113; revisión clínica de
-- `fix/examenes-criticos-d123`).
--
-- `20261005034644_analyte_reference_range_validity` impidió borrar y reescribir
-- una fila de rango, pero dejaba FABRICAR historia: insertar una fila ya
-- cerrada, o abierta «desde marzo», o cerrar una con cualquier fecha. La
-- historia de un analito sólo avanza:
--
--   · una fila nace ABIERTA, y no antes del último cierre de su analito;
--   · una fila se cierra no antes de la apertura más reciente de su analito.
--
-- Así «qué umbral regía en tal fecha» tiene una sola respuesta. No se compara
-- con `now()`: los recorridos de Playwright adelantan el reloj de la API y no
-- el de PostgreSQL, y las dos fechas las escribe la aplicación.

CREATE OR REPLACE FUNCTION analyte_reference_range_history_kept()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  latest TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT max(greatest("valid_from", coalesce("valid_to", "valid_from")))
      INTO latest
      FROM "analyte_reference_range"
     WHERE "analyte_definition_id" = NEW."analyte_definition_id";
    IF NEW."valid_to" IS NULL
       AND (latest IS NULL OR NEW."valid_from" >= latest) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'analyte_reference_range keeps its history: a new range opens, and not before the last change'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Un rango nace vigente y no antes del último cambio de su '
                   'determinación (ORD-113).';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."valid_to" IS NULL
     AND NEW."valid_to" IS NOT NULL
     AND NEW."id" = OLD."id"
     AND NEW."analyte_definition_id" = OLD."analyte_definition_id"
     AND NEW."sex" IS NOT DISTINCT FROM OLD."sex"
     AND NEW."age_min_days" IS NOT DISTINCT FROM OLD."age_min_days"
     AND NEW."age_max_days" IS NOT DISTINCT FROM OLD."age_max_days"
     AND NEW."range_kind" = OLD."range_kind"
     AND NEW."low" IS NOT DISTINCT FROM OLD."low"
     AND NEW."high" IS NOT DISTINCT FROM OLD."high"
     AND NEW."text" IS NOT DISTINCT FROM OLD."text"
     AND NEW."valid_from" = OLD."valid_from"
     AND NEW."created_at" = OLD."created_at" THEN
    SELECT max("valid_from")
      INTO latest
      FROM "analyte_reference_range"
     WHERE "analyte_definition_id" = NEW."analyte_definition_id";
    IF NEW."valid_to" >= latest THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'analyte_reference_range keeps its history: operation % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Un rango no se borra ni se corrige: se cierra su vigencia, no '
                 'antes del último cambio, y se abre otro (ORD-113).';
END;
$$;

CREATE TRIGGER trg_analyte_reference_range_history_opens
  BEFORE INSERT ON "analyte_reference_range"
  FOR EACH ROW
  EXECUTE FUNCTION analyte_reference_range_history_kept();
