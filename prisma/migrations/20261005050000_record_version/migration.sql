-- record_version
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- D-127: CORREGIR ES EDITAR, Y LA HISTORIA LA GUARDA LA BASE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El autor decidió el 04-10-2026 que lo registrado se edita en el sitio y que
-- el sistema guarda la versión anterior, con quién y cuándo. Hasta hoy cada
-- tabla resolvía «no perder lo de antes» a su manera —solo-inserción, archivo
-- aparte, refutar y registrar otro—, y eso obligaba al usuario a quitar y
-- volver a registrar.
--
-- Esta migración pone UNA pieza para todas las tablas que se vayan editando
-- (EN-210):
--
--   - `record_version`: la fila ANTERIOR entera, como jsonb, con quién y
--     cuándo la cambió. Solo inserción.
--   - `record_version_archive(columna_por, columna_cuando, columna_id)`: un
--     disparador BEFORE UPDATE que se engancha a cada tabla versionada. Exige
--     que el UPDATE traiga un SELLO NUEVO —quién en `columna_por`, y un
--     instante distinto del anterior en `columna_cuando`— y archiva OLD.
--
-- POR QUÉ EN LA BASE Y NO EN LA APLICACIÓN. La API no es la única que escribe:
-- vendrá un asistente de IA (D-127.5), hay importaciones y hay psql. Un UPDATE
-- sin sello se RECHAZA, así que nadie edita sin dejar quién fue, y la versión
-- anterior se archiva en la misma sentencia: no hay ruta que la olvide.
--
-- POR QUÉ EL INSTANTE LO PONE LA APLICACIÓN. Los recorridos e2e mueven el
-- reloj de la API, y lo que la pantalla compara tiene que salir de ese reloj y
-- no de `now()` de PostgreSQL. El disparador solo exige que el sello cambie.
--
-- ⚠️ DOS CORRECCIONES DE LA MISMA FILA EN EL MISMO INSTANTE chocan: la
-- segunda trae el mismo sello y se rechaza. Es el precio de detectar el UPDATE
-- que no puso sello (un sello que no cambia no se distingue de uno que nadie
-- escribió). En una persona que corrige a mano no ocurre.

CREATE TABLE "record_version" (
  "id"            UUID PRIMARY KEY DEFAULT uuidv7(),

  -- El nombre de la TABLA, que es lo que el disparador conoce (TG_TABLE_NAME).
  "resource_type" VARCHAR(63) NOT NULL,
  "resource_id"   UUID NOT NULL,

  -- 1 es la primera versión que se sustituyó; la vigente sigue en su tabla.
  "version"       INTEGER NOT NULL,

  -- La fila anterior entera. Un JSON y no columnas: la pieza sirve a cualquier
  -- tabla, y quien lee la versión la lee con el mismo mapeo que la vigente.
  "data"          JSONB NOT NULL,

  -- Quién y cuándo la SUSTITUYÓ: el sello nuevo del UPDATE.
  "changed_by"    UUID NOT NULL,
  "changed_at"    TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "record_version_changed_by_fkey"
    FOREIGN KEY ("changed_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "record_version_number_positive" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX "record_version_resource_version_key"
  ON "record_version" ("resource_type", "resource_id", "version");

-- La historia no se reescribe ni se borra.
CREATE OR REPLACE FUNCTION record_version_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'record_version is insert-only'
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Una versión guardada no se modifica ni se borra.';
END;
$$;

CREATE TRIGGER trg_record_version_insert_only
  BEFORE UPDATE OR DELETE ON "record_version"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_insert_only();

-- TG_ARGV: [0] columna de quién, [1] columna de cuándo, [2] columna id.
CREATE OR REPLACE FUNCTION record_version_archive()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  old_row   JSONB := to_jsonb(OLD);
  new_row   JSONB := to_jsonb(NEW);
  by_col    TEXT  := TG_ARGV[0];
  at_col    TEXT  := TG_ARGV[1];
  id_col    TEXT  := TG_ARGV[2];
  next_version INTEGER;
BEGIN
  IF new_row ->> by_col IS NULL
     OR new_row ->> at_col IS NULL
     OR (new_row -> at_col) IS NOT DISTINCT FROM (old_row -> at_col) THEN
    -- The name goes FIRST in the message: it is how `database-problem.ts`
    -- reads which rule a trigger raised (the adapter drops `CONSTRAINT`).
    RAISE EXCEPTION 'record_version_change_is_stamped: % must be edited with a new stamp in % and %',
      TG_TABLE_NAME, by_col, at_col
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'record_version_change_is_stamped',
            HINT = 'Toda edición dice quién y cuándo; la versión anterior se guarda sola.';
  END IF;

  SELECT coalesce(max("version"), 0) + 1
    INTO next_version
    FROM "record_version"
   WHERE "resource_type" = TG_TABLE_NAME
     AND "resource_id" = (old_row ->> id_col)::uuid;

  INSERT INTO "record_version"
    ("resource_type", "resource_id", "version", "data", "changed_by", "changed_at")
  VALUES (
    TG_TABLE_NAME,
    (old_row ->> id_col)::uuid,
    next_version,
    old_row,
    (new_row ->> by_col)::uuid,
    (new_row ->> at_col)::timestamptz
  );

  RETURN NEW;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PRIMERA TABLA: los signos vitales (EN-210, AT-17 del inventario)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Ya se corregían en el sitio, pero el UPDATE SOBRESCRIBÍA la toma anterior:
-- quien corregía la temperatura borraba lo que había. Ahora la toma anterior
-- queda en `record_version`, y el sello es el de EN-143: `corrected_by` y
-- `corrected_at`. Quién la TOMÓ no cambia (`trg_encounter_vitals_keeps_its_author`).
CREATE TRIGGER trg_encounter_vitals_record_version
  BEFORE UPDATE ON "encounter_vitals"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_archive('corrected_by', 'corrected_at', 'encounter_id');
