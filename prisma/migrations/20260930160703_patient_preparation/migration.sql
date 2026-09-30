-- patient_preparation
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Después: pnpm migrations:check && pnpm db:deploy

-- QUÉ GARANTIZA: lo que F-03 —la preparación de enfermería— necesita que
-- exista y que la base, no la pantalla, haga cumplir.
--
--   1. EN-064 · cómo se tomó la talla, de pie o acostado.
--   2. EN-065 · hemoglobina y hemoglobina corregida por altitud, con rango.
--   3. EN-163 · el motivo en las palabras del paciente, tomado con los signos.
--   4. EN-143 · el autor de la toma de signos, EN EL DATO (D-048).
--   5. EN-086 · el autor de la alergia y el de su refutación.
--   6. EN-085 · los antecedentes personales y familiares, por paciente, que se
--      refutan y no se borran.
--
-- LAS RESTRICCIONES SOBRE FILAS YA ESCRITAS VAN `NOT VALID`, por la misma
-- razón que `20260930124150_encounter_vitals_ranges_per_measure`: se comprueban
-- en todo INSERT y UPDATE desde ahora —que es lo que protege— y no obligan a
-- que las filas anteriores las cumplan. Una talla de ayer no tiene posición y
-- una alergia de ayer no tiene autor, y NADIE puede inventárselos: exigírselo a
-- esas filas sería o impedir el despliegue o rellenarlas con un dato falso.
--
-- PARA DESHACERLA: `DROP TABLE patient_history`, `DROP TYPE
-- patient_history_kind`, `DROP TYPE height_position` tras quitar las columnas
-- nuevas de `encounter_vitals` y `patient_allergy` (las restricciones caen con
-- ellas), y `DROP FUNCTION patient_history_append_only()`.


-- ═══════════════════════════════════════════════════════════════════════════
-- 1-4. encounter_vitals
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE "height_position" AS ENUM ('STANDING', 'LYING');

ALTER TABLE "encounter_vitals"
  ADD COLUMN "height_position" "height_position",
  ADD COLUMN "hemoglobin_g_dl" DECIMAL(4,1),
  ADD COLUMN "hemoglobin_corrected_g_dl" DECIMAL(4,1),
  ADD COLUMN "presenting_complaint" VARCHAR(500),
  ADD COLUMN "recorded_by" UUID,
  ADD COLUMN "corrected_by" UUID,
  ADD COLUMN "corrected_at" TIMESTAMPTZ(6),

  ADD CONSTRAINT "encounter_vitals_corrected_by_fkey"
    FOREIGN KEY ("corrected_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Una corrección dice quién y cuándo, o no hay corrección.
  ADD CONSTRAINT "encounter_vitals_correction_is_whole" CHECK (
    ("corrected_by" IS NULL) = ("corrected_at" IS NULL)
  ),

  ADD CONSTRAINT "encounter_vitals_recorded_by_fkey"
    FOREIGN KEY ("recorded_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  -- EN-065. El criterio de D-058: amplio, caza el 115 tecleado por 11,5 y no
  -- discute de fisiología. Una por medida, con el prefijo de las demás, para
  -- que el 422 `VITALS_OUT_OF_RANGE` señale la casilla por el nombre.
  -- Columnas nuevas: no hay filas que incumplan, así que van validadas.
  ADD CONSTRAINT "encounter_vitals_ranges_hemoglobin_g_dl" CHECK (
    "hemoglobin_g_dl" IS NULL OR "hemoglobin_g_dl" BETWEEN 1 AND 25
  ),
  ADD CONSTRAINT "encounter_vitals_ranges_hemoglobin_corrected_g_dl" CHECK (
    "hemoglobin_corrected_g_dl" IS NULL
    OR "hemoglobin_corrected_g_dl" BETWEEN 1 AND 25
  ),
  -- No hay valor corregido sin el valor que se corrigió.
  ADD CONSTRAINT "encounter_vitals_corrected_needs_hemoglobin" CHECK (
    "hemoglobin_corrected_g_dl" IS NULL OR "hemoglobin_g_dl" IS NOT NULL
  ),
  -- EN-163. Un motivo en blanco no es un motivo: o dice algo o no está.
  ADD CONSTRAINT "encounter_vitals_presenting_complaint_not_blank" CHECK (
    "presenting_complaint" IS NULL OR btrim("presenting_complaint") <> ''
  ),
  -- EN-064. Talla y posición van juntas: una sin la otra mezcla dos escalas.
  -- NOT VALID: las tallas ya guardadas no tienen posición.
  ADD CONSTRAINT "encounter_vitals_height_needs_position" CHECK (
    ("height_cm" IS NULL) = ("height_position" IS NULL)
  ) NOT VALID,
  -- EN-143. Toda toma escrita desde hoy nombra a quien la tomó.
  -- Una toma anterior a la columna no tiene autor y nadie se lo inventa: si se
  -- corrige, la nombra quien la corrigió.
  ADD CONSTRAINT "encounter_vitals_names_its_author" CHECK (
    "recorded_by" IS NOT NULL OR "corrected_by" IS NOT NULL
  ) NOT VALID;

-- EN-143, D-048: QUIEN TOMÓ LOS SIGNOS NO CAMBIA AL CORREGIRLOS. Una corrección
-- posterior —el médico que rehace la temperatura— no convierte al que corrige
-- en autor del peso que tomó enfermería: queda en `corrected_by` y
-- `corrected_at`. Sin esto, «Tomados por» nombraría a quien no midió nada.
-- La autoría POR MEDIDA es una decisión abierta (D-062); esto es lo mínimo que
-- no miente mientras se decide.
CREATE OR REPLACE FUNCTION encounter_vitals_keeps_its_author()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."recorded_by" IS NOT NULL
     AND NEW."recorded_by" IS DISTINCT FROM OLD."recorded_by" THEN
    RAISE EXCEPTION 'encounter_vitals.recorded_by cannot change once written'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Quien corrige la toma queda en corrected_by.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_encounter_vitals_keeps_its_author
  BEFORE UPDATE ON "encounter_vitals"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_vitals_keeps_its_author();


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. patient_allergy
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "patient_allergy"
  ADD COLUMN "recorded_by" UUID,
  ADD COLUMN "refuted_by" UUID,

  ADD CONSTRAINT "patient_allergy_recorded_by_fkey"
    FOREIGN KEY ("recorded_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patient_allergy_refuted_by_fkey"
    FOREIGN KEY ("refuted_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  -- EN-086. «¿Quién la descartó?», en cuanto se descarta. NOT VALID: las
  -- refutadas antes de la columna no tienen a quién nombrar.
  ADD CONSTRAINT "patient_allergy_refutation_names_its_author" CHECK (
    "refuted_at" IS NULL OR "refuted_by" IS NOT NULL
  ) NOT VALID;

-- EN-086, EN-082. EL AUTOR SE EXIGE AL NACER, NO EN CADA UPDATE, y la alergia
-- sólo admite UNA escritura posterior: refutarla.
--
-- ⚠️ NO ES UN CHECK `NOT VALID` SOBRE `recorded_by`, y fue el primer intento: un
-- CHECK se evalúa en todo UPDATE sobre la fila nueva, así que una alergia de
-- antes de la columna —sin autor— dejaba de poder refutarse, y con ella de poder
-- afirmarse «sin alergias conocidas» sobre esa ficha (revisión clínica,
-- 30-09-2026). El autor se exige al INSERT; el UPDATE sólo puede refutar.
--
-- Y SE REFUTAN, NO SE REESCRIBEN NI SE BORRAN, igual que `patient_history`: sin
-- esto cualquier UPDATE podía cambiar la sustancia, la criticidad o el autor
-- que EN-086 dice guardar.
CREATE OR REPLACE FUNCTION patient_allergy_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."recorded_by" IS NULL THEN
      RAISE EXCEPTION 'patient_allergy must name its author'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'patient_allergy_names_its_author';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."refuted_at" IS NULL
     AND NEW."refuted_at" IS NOT NULL
     AND NEW."id" = OLD."id"
     AND NEW."patient_id" = OLD."patient_id"
     AND NEW."substance_concept_id" IS NOT DISTINCT FROM OLD."substance_concept_id"
     AND NEW."substance_text" = OLD."substance_text"
     AND NEW."reaction" IS NOT DISTINCT FROM OLD."reaction"
     AND NEW."criticality" = OLD."criticality"
     AND NEW."recorded_at" = OLD."recorded_at"
     AND NEW."recorded_by" IS NOT DISTINCT FROM OLD."recorded_by"
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'patient_allergy is append-only: operation % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Una alergia no se borra ni se reescribe: se refuta, una vez, '
                 'con su motivo; y si hace falta otra, se registra.';
END;
$$;

CREATE TRIGGER trg_patient_allergy_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "patient_allergy"
  FOR EACH ROW
  EXECUTE FUNCTION patient_allergy_guard();

CREATE TRIGGER trg_patient_allergy_no_truncate
  BEFORE TRUNCATE ON "patient_allergy"
  FOR EACH STATEMENT
  EXECUTE FUNCTION patient_allergy_guard();


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. patient_history
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hermana de `patient_allergy`. `ON DELETE RESTRICT` hacia la ficha y no
-- `CASCADE` como la alergia: una ficha no se borra —se fusiona (D-031)—, y
-- borrarla en cascada sería el único camino que esquivaría el disparador de
-- abajo.

CREATE TYPE "patient_history_kind" AS ENUM ('PERSONAL', 'FAMILY');

CREATE TABLE "patient_history" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "patient_id" UUID NOT NULL,
  "kind" "patient_history_kind" NOT NULL,
  "description" VARCHAR(500) NOT NULL,
  "relative" VARCHAR(80),
  "recorded_by" UUID NOT NULL,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "refuted_at" TIMESTAMPTZ(6),
  "refuted_notes" TEXT,
  "refuted_by" UUID,

  CONSTRAINT "patient_history_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "patient_history_description_not_blank" CHECK (
    btrim("description") <> ''
  ),
  -- Un antecedente familiar sin parentesco no dice de quién es: la diabetes
  -- de la madre y la del primo no pesan lo mismo. Y uno personal no tiene
  -- pariente.
  CONSTRAINT "patient_history_family_names_relative" CHECK (
    ("kind" = 'FAMILY') = ("relative" IS NOT NULL AND btrim("relative") <> '')
  ),
  -- Refutar es un acto entero: cuándo, por qué y quién, o nada.
  CONSTRAINT "patient_history_refutation_is_whole" CHECK (
    ("refuted_at" IS NULL AND "refuted_notes" IS NULL AND "refuted_by" IS NULL)
    OR ("refuted_at" IS NOT NULL AND "refuted_by" IS NOT NULL
        AND "refuted_notes" IS NOT NULL AND btrim("refuted_notes") <> '')
  )
);

CREATE INDEX "patient_history_patient_id_refuted_at_idx"
  ON "patient_history"("patient_id", "refuted_at");

ALTER TABLE "patient_history"
  ADD CONSTRAINT "patient_history_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "patient"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patient_history_recorded_by_fkey"
    FOREIGN KEY ("recorded_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patient_history_refuted_by_fkey"
    FOREIGN KEY ("refuted_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- SE REFUTAN, NO SE BORRAN (EN-085, el régimen de EN-082). Saber que un
-- antecedente se descartó es información clínica por derecho propio, y uno
-- reescrito en silencio dice algo que nadie afirmó. La única escritura
-- posterior al INSERT es refutar una fila vigente, una vez, sin tocar nada más.
--
-- Disparador y no `REVOKE`: la aplicación conecta como propietaria de la tabla
-- y un propietario conserva sus privilegios aunque se le revoquen.
CREATE OR REPLACE FUNCTION patient_history_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."refuted_at" IS NULL
     AND NEW."refuted_at" IS NOT NULL
     AND NEW."id" = OLD."id"
     AND NEW."patient_id" = OLD."patient_id"
     AND NEW."kind" = OLD."kind"
     AND NEW."description" = OLD."description"
     AND NEW."relative" IS NOT DISTINCT FROM OLD."relative"
     AND NEW."recorded_by" = OLD."recorded_by"
     AND NEW."recorded_at" = OLD."recorded_at"
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'patient_history is append-only: operation % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Un antecedente no se borra ni se reescribe: se refuta, una '
                 'vez, con su motivo; y si hace falta otro, se registra.';
END;
$$;

CREATE TRIGGER trg_patient_history_append_only
  BEFORE UPDATE OR DELETE ON "patient_history"
  FOR EACH ROW
  EXECUTE FUNCTION patient_history_append_only();

-- `TRUNCATE` no dispara los `FOR EACH ROW`: necesita el suyo.
CREATE TRIGGER trg_patient_history_no_truncate
  BEFORE TRUNCATE ON "patient_history"
  FOR EACH STATEMENT
  EXECUTE FUNCTION patient_history_append_only();
