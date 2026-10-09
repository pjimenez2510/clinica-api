-- encounter_program_block_h
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio:
-- propone borrar las columnas generadas, los índices GIN y BRIN, los índices
-- únicos parciales y los disparadores, porque schema.prisma no puede
-- describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-092. EL BLOQUE H DEL RDACAA: DATOS DEL SIVAN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Columnas 52 a 54 (instructivo RDACAA 2.0, pp. 54 y 55 del PDF), todas
-- 1 sí / 2 no. Una fila por atención, versionada como el bloque G (EN-249).
--
-- LA EDAD ES LA CONGELADA EN LA ATENCIÓN (EN-008), en MESES CUMPLIDOS: el
-- bloque es de «usuarios menores o iguales a 8 meses», así que pide
-- `age_years = 0` y `age_months <= 8` (ocho meses y veinte días siguen siendo
-- ocho meses). Dentro de él:
--  · columna 52, «madre en período de lactancia»: siempre;
--  · columna 53, «sólo leche materna en las últimas 24 horas»: de 0 a 5 meses;
--  · columna 54, «alimento sólido, semisólido o suave»: de 6 a 8 meses.
-- Cada una obligatoria en su tramo y vacía fuera de él.
--
-- La madre lactante COMO PACIENTE no se construye (D-195.3).
--
-- Qué se llama cada rechazo y qué responde la API (encounter.constraints.ts):
--  · `encounter_nutrition_applies` — la edad congelada pasa de 8 meses o no
--    existe, o se respondió la pregunta del otro tramo →
--    PROGRAM_BLOCK_NOT_APPLICABLE (422).
--  · `encounter_nutrition_exclusive_required` /
--    `encounter_nutrition_complementary_required` — falta la pregunta del
--    tramo → VALIDATION_FAILED en ese campo.
-- Después: pnpm migrations:check && pnpm db:deploy

CREATE TABLE "encounter_nutrition" (
  "encounter_id" UUID PRIMARY KEY,

  "mother_breastfeeding"    BOOLEAN NOT NULL,
  "exclusive_breastfeeding" BOOLEAN,
  "complementary_feeding"   BOOLEAN,

  "recorded_by_id" UUID NOT NULL,
  "recorded_at"    TIMESTAMPTZ(6) NOT NULL,
  "edited_by_id"   UUID,
  "edited_at"      TIMESTAMPTZ(6),

  CONSTRAINT "encounter_nutrition_encounter_id_fkey"
    FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "encounter_nutrition_recorded_by_id_fkey"
    FOREIGN KEY ("recorded_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "encounter_nutrition_edited_by_id_fkey"
    FOREIGN KEY ("edited_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "encounter_nutrition_edit_stamp_whole"
    CHECK (("edited_by_id" IS NULL) = ("edited_at" IS NULL))
);

COMMENT ON TABLE "encounter_nutrition" IS
  'EN-092. Bloque H del RDACAA (columnas 52 a 54): sólo con la edad congelada '
  'de 8 meses cumplidos o menos (trg_encounter_nutrition_applies). Versionada '
  'en record_version (EN-249).';

CREATE FUNCTION encounter_nutrition_applies()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  years  integer;
  months integer;
BEGIN
  SELECT e.age_years, e.age_months INTO years, months
    FROM encounter e WHERE e.id = NEW.encounter_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF years IS NULL OR months IS NULL OR years > 0 OR months > 8 THEN
    RAISE EXCEPTION 'encounter_nutrition_applies: the frozen age of the attention is over 8 months or unknown'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'encounter_nutrition_applies';
  END IF;

  IF months <= 5 THEN
    IF NEW.complementary_feeding IS NOT NULL THEN
      RAISE EXCEPTION 'encounter_nutrition_applies: solid food is asked from 6 to 8 months'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'encounter_nutrition_applies';
    END IF;
    IF NEW.exclusive_breastfeeding IS NULL THEN
      RAISE EXCEPTION 'encounter_nutrition_exclusive_required: only breast milk is asked from 0 to 5 months'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'encounter_nutrition_exclusive_required';
    END IF;
  ELSE
    IF NEW.exclusive_breastfeeding IS NOT NULL THEN
      RAISE EXCEPTION 'encounter_nutrition_applies: only breast milk is asked from 0 to 5 months'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'encounter_nutrition_applies';
    END IF;
    IF NEW.complementary_feeding IS NULL THEN
      RAISE EXCEPTION 'encounter_nutrition_complementary_required: solid food is asked from 6 to 8 months'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'encounter_nutrition_complementary_required';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_nutrition_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "encounter_nutrition"
  FOR EACH ROW EXECUTE FUNCTION program_block_guard();

CREATE TRIGGER "trg_encounter_nutrition_applies"
  BEFORE INSERT OR UPDATE ON "encounter_nutrition"
  FOR EACH ROW EXECUTE FUNCTION encounter_nutrition_applies();

CREATE TRIGGER "trg_encounter_nutrition_keeps_its_author"
  BEFORE UPDATE ON "encounter_nutrition"
  FOR EACH ROW EXECUTE FUNCTION program_block_keeps_its_author();

CREATE TRIGGER "trg_encounter_nutrition_record_version"
  BEFORE UPDATE ON "encounter_nutrition"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_archive('edited_by_id', 'edited_at', 'encounter_id');
