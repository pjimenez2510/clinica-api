-- encounter_supplement
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio:
-- propone borrar las columnas generadas, los índices GIN y BRIN, los índices
-- únicos parciales y los disparadores, porque schema.prisma no puede
-- describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-096. PRESCRIPCIÓN DE SUPLEMENTOS — COLUMNAS 105 A 108 DEL RDACAA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Instructivo RDACAA 2.0, «Prescripción de suplementos» (pp. 67 y 68 del
-- PDF, leídas el 09-10-2026): «si prescribe o no» cada suplemento, 1 sí /
-- 2 no, con su población:
--   105 hierro, multivitaminas y minerales en polvo (chispas) — 6 a 24 meses
--   106 vitamina A                                          — 6 a 59 meses
--   107 hierro en jarabe                                    — 24 a 59 meses
--   108 hierro + ácido fólico — «mujeres embarazadas y mujeres lactantes»
-- Edad: la CONGELADA en la atención (EN-008), en meses cumplidos. Embarazada:
-- el registro de la ficha en la fecha clínica (`encounter_is_pregnant`, la
-- regla de EN-090). Lactante: su propia respuesta en la columna 52 de la
-- misma atención (`encounter_nutrition`, EN-260) — la lactancia se pregunta
-- una vez y la leen los dos bloques (D-195.3, D-198.2).
--
-- Una fila por atención, cada casilla optativa y vacía fuera de su población
-- (EN-097). La pantalla las PROPONE desde la receta (EN-262); aquí se guarda
-- lo que quien prescribe confirmó. Corregir es editar, con la fila anterior
-- en `record_version` (EN-249), con la guarda y el autor de los demás
-- bloques: sólo con la atención abierta o suspendida, nunca se borra.
--
-- Qué se llama cada rechazo (encounter.constraints.ts):
--  · `encounter_supplement_applies` — una casilla fuera de su población →
--    PROGRAM_BLOCK_NOT_APPLICABLE (422).
-- Después: pnpm migrations:check && pnpm db:deploy

CREATE TABLE "encounter_supplement" (
  "encounter_id" UUID PRIMARY KEY,

  "micronutrient_powder" BOOLEAN,
  "vitamin_a"            BOOLEAN,
  "iron_syrup"           BOOLEAN,
  "iron_folic_acid"      BOOLEAN,

  "recorded_by_id" UUID NOT NULL,
  "recorded_at"    TIMESTAMPTZ(6) NOT NULL,
  "edited_by_id"   UUID,
  "edited_at"      TIMESTAMPTZ(6),

  CONSTRAINT "encounter_supplement_encounter_id_fkey"
    FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "encounter_supplement_recorded_by_id_fkey"
    FOREIGN KEY ("recorded_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "encounter_supplement_edited_by_id_fkey"
    FOREIGN KEY ("edited_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "encounter_supplement_edit_stamp_whole"
    CHECK (("edited_by_id" IS NULL) = ("edited_at" IS NULL))
);

COMMENT ON TABLE "encounter_supplement" IS
  'EN-096. Columnas 105 a 108 del RDACAA: si se prescribieron chispas, '
  'vitamina A, hierro en jarabe e hierro + ácido fólico, cada uno sólo en su '
  'población (trg_encounter_supplement_applies). Propuestas desde la receta '
  '(EN-262) y confirmadas por quien prescribe. Versionada en record_version '
  '(EN-249).';

-- EN-260. La mujer de 10 a 49 años que respondió en esta atención que está
-- en período de lactancia (la columna 52 de su propia fila).
CREATE FUNCTION encounter_is_lactating(p_encounter_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM encounter e
      JOIN patient p ON p.id = e.patient_id
      JOIN encounter_nutrition n ON n.encounter_id = e.id
     WHERE e.id = p_encounter_id
       AND p.sex = 'FEMALE'
       AND e.age_years BETWEEN 10 AND 49
       AND n.mother_breastfeeding
  );
$$;

CREATE FUNCTION encounter_supplement_applies()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  total_months integer;
BEGIN
  SELECT e.age_years * 12 + e.age_months INTO total_months
    FROM encounter e WHERE e.id = NEW.encounter_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.micronutrient_powder IS NOT NULL
     AND (total_months IS NULL OR total_months NOT BETWEEN 6 AND 24) THEN
    RAISE EXCEPTION 'encounter_supplement_applies: the micronutrient powder is prescribed from 6 to 24 months'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'encounter_supplement_applies';
  END IF;
  IF NEW.vitamin_a IS NOT NULL
     AND (total_months IS NULL OR total_months NOT BETWEEN 6 AND 59) THEN
    RAISE EXCEPTION 'encounter_supplement_applies: vitamin A is prescribed from 6 to 59 months'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'encounter_supplement_applies';
  END IF;
  IF NEW.iron_syrup IS NOT NULL
     AND (total_months IS NULL OR total_months NOT BETWEEN 24 AND 59) THEN
    RAISE EXCEPTION 'encounter_supplement_applies: the iron syrup is prescribed from 24 to 59 months'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'encounter_supplement_applies';
  END IF;
  IF NEW.iron_folic_acid IS NOT NULL
     AND NOT (encounter_is_pregnant(NEW.encounter_id)
              OR encounter_is_lactating(NEW.encounter_id)) THEN
    RAISE EXCEPTION 'encounter_supplement_applies: iron with folic acid is prescribed to pregnant and lactating women'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'encounter_supplement_applies';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_supplement_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "encounter_supplement"
  FOR EACH ROW EXECUTE FUNCTION program_block_guard();

CREATE TRIGGER "trg_encounter_supplement_applies"
  BEFORE INSERT OR UPDATE ON "encounter_supplement"
  FOR EACH ROW EXECUTE FUNCTION encounter_supplement_applies();

CREATE TRIGGER "trg_encounter_supplement_keeps_its_author"
  BEFORE UPDATE ON "encounter_supplement"
  FOR EACH ROW EXECUTE FUNCTION program_block_keeps_its_author();

CREATE TRIGGER "trg_encounter_supplement_record_version"
  BEFORE UPDATE ON "encounter_supplement"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_archive('edited_by_id', 'edited_at', 'encounter_id');
