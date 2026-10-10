-- encounter_nutrition_keeps_supplement
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio.
--
-- EN-096, EN-260 (revisión clínica de feat/f04-rdacaa-ajustes, G1).
-- El otro lado de `encounter_supplement_applies`: la lactancia de la
-- mujer no pasa a «no» mientras su hierro con ácido fólico siga registrado y
-- no esté embarazada; si no, la columna 108 quedaría fuera de su población.
-- Primero se quita el suplemento. Ambas escrituras toman el bloqueo de la
-- atención (FOR UPDATE), así que no se cruzan.
-- `encounter_nutrition_supplement_depends` → VALIDATION_FAILED en
-- `motherBreastfeeding`.
CREATE FUNCTION encounter_nutrition_keeps_supplement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT NEW.mother_breastfeeding
     AND EXISTS (SELECT 1 FROM encounter_supplement s
                  WHERE s.encounter_id = NEW.encounter_id
                    AND s.iron_folic_acid IS NOT NULL)
     AND NOT encounter_is_pregnant(NEW.encounter_id) THEN
    RAISE EXCEPTION 'encounter_nutrition_supplement_depends: iron with folic acid is recorded for this lactation'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'encounter_nutrition_supplement_depends';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_nutrition_keeps_supplement"
  BEFORE UPDATE ON "encounter_nutrition"
  FOR EACH ROW EXECUTE FUNCTION encounter_nutrition_keeps_supplement();

-- Después: pnpm migrations:check && pnpm db:deploy
