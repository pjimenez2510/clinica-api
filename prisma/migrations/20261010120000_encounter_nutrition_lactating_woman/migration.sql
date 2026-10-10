-- encounter_nutrition_lactating_woman
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio:
-- propone borrar las columnas generadas, los índices GIN y BRIN, los índices
-- únicos parciales y los disparadores, porque schema.prisma no puede
-- describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-260. LA MADRE LACTANTE COMO PACIENTE: LA COLUMNA 52 DE SU PROPIA FILA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- D-195.3, aceptada el 09-10-2026. El bloque H del RDACAA es de «usuarios
-- menores o iguales a 8 meses de edad y madres en período de lactancia», y la
-- columna 52 se registra «cuando el profesional de salud pregunte a la madre
-- si se encuentra o no en período de lactancia». Hasta hoy sólo la fila del
-- lactante la tenía.
--
-- Ahora `encounter_nutrition` admite además la atención de una MUJER DE 10 A
-- 49 AÑOS (sexo femenino, edad congelada EN-008; la edad fértil del MSP), con
-- `mother_breastfeeding` —su propia respuesta— y las dos preguntas del
-- lactante vacías. Un dato en un sitio: la lee también el hierro con ácido
-- fólico de los suplementos (EN-096, la migración 20261010120200).
--
-- Qué se llama cada rechazo: los mismos de antes (encounter.constraints.ts);
-- la mujer fuera de la edad, un hombre, o una pregunta del lactante en su
-- fila → `encounter_nutrition_applies` → PROGRAM_BLOCK_NOT_APPLICABLE.
-- Después: pnpm migrations:check && pnpm db:deploy

CREATE OR REPLACE FUNCTION encounter_nutrition_applies()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  years  integer;
  months integer;
  sex    text;
BEGIN
  SELECT e.age_years, e.age_months, p.sex::text INTO years, months, sex
    FROM encounter e JOIN patient p ON p.id = e.patient_id
   WHERE e.id = NEW.encounter_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- EN-260. The woman of 10 to 49: only column 52, her own answer.
  IF sex = 'FEMALE' AND years BETWEEN 10 AND 49 THEN
    IF NEW.exclusive_breastfeeding IS NOT NULL OR NEW.complementary_feeding IS NOT NULL THEN
      RAISE EXCEPTION 'encounter_nutrition_applies: the questions about the infant are not asked to the woman herself'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'encounter_nutrition_applies';
    END IF;
    RETURN NEW;
  END IF;

  IF years IS NULL OR months IS NULL OR years > 0 OR months > 8 THEN
    RAISE EXCEPTION 'encounter_nutrition_applies: the attention is neither of an infant of 8 months or less nor of a woman of 10 to 49'
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

COMMENT ON TABLE "encounter_nutrition" IS
  'EN-092, EN-260. Bloque H del RDACAA (columnas 52 a 54): con la edad congelada '
  'de 8 meses cumplidos o menos, o —sólo la columna 52, su propia lactancia— '
  'de una mujer de 10 a 49 años (trg_encounter_nutrition_applies). Versionada '
  'en record_version (EN-249).';
