-- analyte_reference_range_validity
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- QUÉ GARANTIZA (orders/SPEC.md ORD-113, ORD-114; D-123.4, resuelta por el
-- autor: A).
--
-- Cada resultado congela el rango de REFERENCIA que aplicó (ORD-037), pero no
-- el CRÍTICO. Ante un crítico que no se avisó, «¿qué umbral regía ese día?»
-- sólo tiene respuesta si la fila de entonces sigue ahí. Hasta aquí, sustituir
-- los rangos de un analito los BORRABA y los volvía a insertar.
--
-- Desde aquí cada fila tiene vigencia: `valid_from` siempre, `valid_to` cuando
-- deja de regir. Sustituir los rangos cierra las vigentes que cambian y abre
-- las nuevas. Lo vigente es «sin `valid_to`», no una comparación de
-- instantes: un reloj desfasado no puede dejar a un paciente sin rango.
--
-- Los instantes los escribe la APLICACIÓN, con su reloj, y no `now()`: los
-- recorridos de Playwright adelantan el de la API y no el de PostgreSQL.

-- Las filas que ya había rigen desde que se escribieron. No cambia ninguna
-- bandera: todas siguen vigentes, y la bandera se calcula con las vigentes.
ALTER TABLE "analyte_reference_range"
  ADD COLUMN "valid_from" TIMESTAMPTZ(6),
  ADD COLUMN "valid_to"   TIMESTAMPTZ(6);

UPDATE "analyte_reference_range" SET "valid_from" = "created_at";

ALTER TABLE "analyte_reference_range"
  ALTER COLUMN "valid_from" SET NOT NULL,
  ADD CONSTRAINT "analyte_reference_range_validity_is_ordered"
    CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from");

-- Lo que clasifica lee las vigentes de un analito: el índice es ese.
CREATE INDEX "analyte_reference_range_in_force_by_analyte"
  ON "analyte_reference_range" ("analyte_definition_id")
  WHERE "valid_to" IS NULL;

-- ORD-113. NI SE BORRA NI SE REESCRIBE: sólo se cierra, una vez.
--
-- Disparador y no `REVOKE`: la aplicación conecta como propietaria de la
-- tabla. Lo único que admite un UPDATE es poner `valid_to` a una fila que no
-- lo tenía (y el `updated_at` que Prisma toca con él); cualquier otro cambio
-- —un límite, el sexo, reabrirla, moverle la fecha— reescribiría lo que regía.
CREATE OR REPLACE FUNCTION analyte_reference_range_history_kept()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
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
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'analyte_reference_range keeps its history: operation % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Un rango no se borra ni se corrige: se cierra su vigencia y '
                 'se abre otro (ORD-113).';
END;
$$;

CREATE TRIGGER trg_analyte_reference_range_history_kept
  BEFORE UPDATE OR DELETE ON "analyte_reference_range"
  FOR EACH ROW
  EXECUTE FUNCTION analyte_reference_range_history_kept();

-- `TRUNCATE` no dispara los `FOR EACH ROW`: necesita el suyo.
CREATE TRIGGER trg_analyte_reference_range_no_truncate
  BEFORE TRUNCATE ON "analyte_reference_range"
  FOR EACH STATEMENT
  EXECUTE FUNCTION analyte_reference_range_history_kept();
