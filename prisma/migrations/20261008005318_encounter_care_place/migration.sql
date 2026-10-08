-- encounter_care_place
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- ═══════════════════════════════════════════════════════════════════════════
-- EN-012, EN-013: EL LUGAR DE ATENCIÓN Y LA ESTRATEGIA MÉDICO DEL BARRIO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El RDACAA pide por atención el LUGAR donde se dio, con el código de su
-- catálogo, y si pertenece a la estrategia «Médico del Barrio» del MSP (1 sí /
-- 2 no). `care_setting` sólo distinguía intramural de extramural, y el
-- ministerio espera un código, no una etiqueta que este sistema inventó.
--
-- EL CATÁLOGO, LEÍDO DE LA IMAGEN DEL INSTRUCTIVO (RDACAA 2.0, § 1.2.5, p. 46):
--   1 Establecimiento de Salud · 2 Comunidad · 3 Instituciones educativas ·
--   4 Domicilio · 5 Albergues creados por desastre · 6 Albergues para
--   refugiados · 7 Albergues · 8 CDI · 9 CNH · 10 CEI · 11 EIFC · 12 Centro
--   de rehabilitación / carcelario · 13 Grupos laborales · 14 Centros de
--   recuperación de adicciones · 15 Casa Hogar o Acogimiento Institucional ·
--   16 Centro Gerontológico · 98 Otros.
--
-- LO QUE GARANTIZA:
--   · `encounter_care_place_in_catalogue`: sólo un código del catálogo.
--   · `trg_encounter_care_setting_from_place`: `care_setting` deja de ser un
--     dato y pasa a derivarse del lugar (1 → INTRAMURAL, el resto →
--     EXTRAMURAL), así que no pueden discrepar. El enum no se borra: lo leen
--     el reporte y quien ya lo lee.
--   · Corregir el lugar o la estrategia es una corrección de la codificación
--     como la modalidad y la primera vez (EN-215, D-127): se rechaza en una
--     atención ya reportada y deja la atención anterior en `record_version`
--     con quién y cuándo.
--
-- LAS FILAS QUE YA EXISTEN: `ADD COLUMN ... DEFAULT` no dispara nada. Las
-- intramurales quedan en 1, que es lo que significaba intramural. Una
-- extramural no dice dónde fue; queda en 98 «Otros», que es el código del
-- instructivo para un lugar que no está entre los anteriores, ANTES de crear
-- los disparadores para que el relleno no exija un sello de corrección. En la
-- base del autor no hay ninguna (07-10-2026: 5 atenciones, todas intramurales).

ALTER TABLE "encounter"
  ADD COLUMN "care_place" SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN "medico_del_barrio" BOOLEAN NOT NULL DEFAULT false;

UPDATE "encounter" SET "care_place" = 98 WHERE "careSetting" = 'EXTRAMURAL';

ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_care_place_in_catalogue" CHECK (
    "care_place" BETWEEN 1 AND 16 OR "care_place" = 98
  );

-- ── care_setting se deriva del lugar ───────────────────────────────────────
CREATE FUNCTION encounter_care_setting_from_place()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."careSetting" := CASE WHEN NEW."care_place" = 1
                            THEN 'INTRAMURAL'::"care_setting"
                            ELSE 'EXTRAMURAL'::"care_setting" END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_care_setting_from_place"
  BEFORE INSERT OR UPDATE OF "care_place", "careSetting" ON "encounter"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_care_setting_from_place();

-- ── Su corrección es de la codificación (EN-215) ───────────────────────────
-- Se rehacen los dos disparadores de `encounter_coding_after_discharge` con
-- las dos columnas nuevas; las funciones no cambian.
DROP TRIGGER "trg_encounter_coding_correction_admits" ON "encounter";
DROP TRIGGER "trg_encounter_record_version" ON "encounter";

CREATE TRIGGER "trg_encounter_coding_correction_admits"
  BEFORE UPDATE OF "careModality", "visitSequence", "care_place", "medico_del_barrio" ON "encounter"
  FOR EACH ROW
  WHEN (OLD."careModality" IS DISTINCT FROM NEW."careModality"
        OR OLD."visitSequence" IS DISTINCT FROM NEW."visitSequence"
        OR OLD."care_place" IS DISTINCT FROM NEW."care_place"
        OR OLD."medico_del_barrio" IS DISTINCT FROM NEW."medico_del_barrio")
  EXECUTE FUNCTION encounter_coding_correction_admits();

CREATE TRIGGER "trg_encounter_record_version"
  BEFORE UPDATE OF "careModality", "visitSequence", "care_place", "medico_del_barrio" ON "encounter"
  FOR EACH ROW
  WHEN (OLD."careModality" IS DISTINCT FROM NEW."careModality"
        OR OLD."visitSequence" IS DISTINCT FROM NEW."visitSequence"
        OR OLD."care_place" IS DISTINCT FROM NEW."care_place"
        OR OLD."medico_del_barrio" IS DISTINCT FROM NEW."medico_del_barrio")
  EXECUTE FUNCTION record_version_archive('corrected_by_id', 'corrected_at', 'id');
