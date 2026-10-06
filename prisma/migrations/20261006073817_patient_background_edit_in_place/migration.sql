-- patient_background_edit_in_place
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-224, EN-225, EN-226 (D-126, D-127): ALERGIAS, ANTECEDENTES Y «SIN
-- ALERGIAS CONOCIDAS» SE CORRIGEN EN EL SITIO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hasta aquí una alergia o un antecedente mal escritos se REFUTABAN con un
-- motivo escrito y se registraban otra vez; lo refutado por error no volvía,
-- y un «sin alergias conocidas» afirmado por error sólo caía registrando una
-- alergia. D-127 lo sustituye:
--
--   · EN-225: la sustancia, la reacción y la criticidad de una alergia, y la
--     descripción, el tipo y el parentesco de un antecedente, se EDITAN. La
--     fila anterior la guarda `record_version` en la misma sentencia
--     (`record_version_archive`, EN-210), con el sello nuevo `changed_by` /
--     `changed_at`.
--   · EN-224: refutar ya no exige motivo (D-126.2), y lo refutado se
--     REACTIVA. Refutar y reactivar son también UPDATE sellados: la fila
--     refutada —con quién, cuándo y por qué— queda como versión.
--   · EN-226: «sin alergias conocidas» se RETIRA, con quién y cuándo
--     (`retracted_by`, `retracted_at`), y también queda su versión.
--
-- LO QUE SIGUE IGUAL, Y LO GARANTIZA LA BASE:
--   · Nada se borra: DELETE y TRUNCATE siguen rechazados en las tres tablas.
--   · Una fila no cambia de paciente, ni de quien la registró ni de cuándo.
--   · Refutar es una vez, y la fila refutada no se edita: se reactiva.
--   · Todo UPDATE lleva sello nuevo (`record_version_change_is_stamped`).
--
-- NO SE TOCA NINGUNA FILA GUARDADA. `ADD COLUMN` sin defecto no ejecuta un
-- UPDATE ni dispara nada: las filas que existan quedan con el sello vacío,
-- que es la verdad («nadie la ha cambiado desde esta migración»). Los CHECK
-- nuevos se validan contra ellas; el ensayo sobre la copia de la base del
-- autor lo confirmó antes de aplicarla.
--
-- ⚠️ El orden de los BEFORE UPDATE es alfabético: `…_guard` /
-- `…_append_only` / `…_immutable` van antes que `…_record_version`, así que
-- lo que se rechaza no llega a archivar nada.


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. patient_allergy
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "patient_allergy"
  ADD COLUMN "changed_by" UUID,
  ADD COLUMN "changed_at" TIMESTAMPTZ(6);

ALTER TABLE "patient_allergy"
  ADD CONSTRAINT "patient_allergy_changed_by_fkey"
    FOREIGN KEY ("changed_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  -- Quién y cuándo, juntos o ninguno.
  ADD CONSTRAINT "patient_allergy_change_stamped" CHECK (
    ("changed_by" IS NULL) = ("changed_at" IS NULL)
  ),

  -- EN-224. El motivo es opcional, pero sólo existe en una alergia refutada,
  -- y uno en blanco no es un motivo. Quién la refutó lo sigue exigiendo
  -- `patient_allergy_refutation_names_its_author` (NOT VALID: las refutadas
  -- antes de la columna no tienen a quién nombrar).
  ADD CONSTRAINT "patient_allergy_refutation_is_coherent" CHECK (
    ("refuted_at" IS NOT NULL OR ("refuted_notes" IS NULL AND "refuted_by" IS NULL))
    AND ("refuted_notes" IS NULL OR btrim("refuted_notes") <> '')
  );

-- EN-086, EN-224, EN-225. El autor se exige al nacer, como antes. Después,
-- cada UPDATE es UNO de tres actos, nunca dos a la vez:
--   · refutar una vigente, sin tocar lo que la alergia dice;
--   · reactivar una refutada, vaciando la refutación, sin tocar lo que dice;
--   · editar lo que dice (sustancia, reacción, criticidad) de una vigente.
-- Y en los tres: ni el id, ni el paciente, ni quién ni cuándo la registró.
-- El sello lo exige `record_version_archive`, que va después.
CREATE OR REPLACE FUNCTION patient_allergy_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  same_content BOOLEAN;
  same_refutation BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."recorded_by" IS NULL THEN
      RAISE EXCEPTION 'patient_allergy must name its author'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'patient_allergy_names_its_author';
    END IF;
    RETURN NEW;
  END IF;

  -- Nested and not one `AND`: a statement-level TRUNCATE has no OLD row.
  IF TG_OP = 'UPDATE' THEN
   IF NEW."id" = OLD."id"
     AND NEW."patient_id" = OLD."patient_id"
     AND NEW."recorded_at" = OLD."recorded_at"
     AND NEW."recorded_by" IS NOT DISTINCT FROM OLD."recorded_by"
   THEN
    same_content :=
          NEW."substance_concept_id" IS NOT DISTINCT FROM OLD."substance_concept_id"
      AND NEW."substance_text" = OLD."substance_text"
      AND NEW."reaction" IS NOT DISTINCT FROM OLD."reaction"
      AND NEW."criticality" = OLD."criticality";
    same_refutation :=
          NEW."refuted_at" IS NOT DISTINCT FROM OLD."refuted_at"
      AND NEW."refuted_notes" IS NOT DISTINCT FROM OLD."refuted_notes"
      AND NEW."refuted_by" IS NOT DISTINCT FROM OLD."refuted_by";

    -- Refutar una vigente.
    IF OLD."refuted_at" IS NULL AND NEW."refuted_at" IS NOT NULL
       AND same_content THEN
      RETURN NEW;
    END IF;
    -- Reactivar una refutada (el CHECK exige vaciar motivo y autor).
    IF OLD."refuted_at" IS NOT NULL AND NEW."refuted_at" IS NULL
       AND same_content THEN
      RETURN NEW;
    END IF;
    -- Editar lo que dice una vigente.
    IF OLD."refuted_at" IS NULL AND same_refutation THEN
      RETURN NEW;
    END IF;
   END IF;

    RAISE EXCEPTION 'patient_allergy cannot be modified this way: an allergy is edited while active, refuted once or reactivated, and never changes its patient or who recorded it'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'EN-224, EN-225. La versión anterior la guarda record_version.';
  END IF;

  RAISE EXCEPTION 'patient_allergy is never deleted: operation % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Una alergia no se borra: se refuta, y si fue por error se reactiva.';
END;
$$;

CREATE TRIGGER "trg_patient_allergy_record_version"
  BEFORE UPDATE ON "patient_allergy"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_archive('changed_by', 'changed_at', 'id');


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. patient_history
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "patient_history"
  ADD COLUMN "changed_by" UUID,
  ADD COLUMN "changed_at" TIMESTAMPTZ(6);

ALTER TABLE "patient_history"
  ADD CONSTRAINT "patient_history_changed_by_fkey"
    FOREIGN KEY ("changed_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patient_history_change_stamped" CHECK (
    ("changed_by" IS NULL) = ("changed_at" IS NULL)
  );

-- EN-224 (D-126.2). Refutar sigue siendo un acto con cuándo y quién, juntos;
-- el motivo pasa a opcional, sólo en un antecedente refutado y nunca en
-- blanco. El MISMO nombre: es el que el contrato ya conoce.
ALTER TABLE "patient_history"
  DROP CONSTRAINT "patient_history_refutation_is_whole";
ALTER TABLE "patient_history"
  ADD CONSTRAINT "patient_history_refutation_is_whole" CHECK (
    ("refuted_at" IS NULL) = ("refuted_by" IS NULL)
    AND ("refuted_at" IS NOT NULL OR "refuted_notes" IS NULL)
    AND ("refuted_notes" IS NULL OR btrim("refuted_notes") <> '')
  );

-- Los tres actos de la alergia, sobre lo que un antecedente dice: el tipo,
-- la descripción y el parentesco (que `patient_history_family_names_relative`
-- sigue atando al tipo).
CREATE OR REPLACE FUNCTION patient_history_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  same_content BOOLEAN;
  same_refutation BOOLEAN;
BEGIN
  -- Nested and not one `AND`: a statement-level TRUNCATE has no OLD row.
  IF TG_OP = 'UPDATE' THEN
   IF NEW."id" = OLD."id"
     AND NEW."patient_id" = OLD."patient_id"
     AND NEW."recorded_by" = OLD."recorded_by"
     AND NEW."recorded_at" = OLD."recorded_at"
   THEN
    same_content :=
          NEW."kind" = OLD."kind"
      AND NEW."description" = OLD."description"
      AND NEW."relative" IS NOT DISTINCT FROM OLD."relative";
    same_refutation :=
          NEW."refuted_at" IS NOT DISTINCT FROM OLD."refuted_at"
      AND NEW."refuted_notes" IS NOT DISTINCT FROM OLD."refuted_notes"
      AND NEW."refuted_by" IS NOT DISTINCT FROM OLD."refuted_by";

    IF OLD."refuted_at" IS NULL AND NEW."refuted_at" IS NOT NULL
       AND same_content THEN
      RETURN NEW;
    END IF;
    IF OLD."refuted_at" IS NOT NULL AND NEW."refuted_at" IS NULL
       AND same_content THEN
      RETURN NEW;
    END IF;
    IF OLD."refuted_at" IS NULL AND same_refutation THEN
      RETURN NEW;
    END IF;
   END IF;

    RAISE EXCEPTION 'patient_history cannot be modified this way: an entry is edited while active, refuted once or reactivated, and never changes its patient or who recorded it'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'EN-224, EN-225. La versión anterior la guarda record_version.';
  END IF;

  RAISE EXCEPTION 'patient_history is never deleted: operation % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Un antecedente no se borra: se refuta, y si fue por error se reactiva.';
END;
$$;

CREATE TRIGGER "trg_patient_history_record_version"
  BEFORE UPDATE ON "patient_history"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_archive('changed_by', 'changed_at', 'id');


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. patient_allergy_absence
-- ═══════════════════════════════════════════════════════════════════════════
--
-- EN-226. «Sin alergias conocidas» afirmado por error se RETIRA: la fila se
-- queda —quién lo afirmó y cuándo no cambian nunca— y gana quién lo retiró y
-- cuándo. Una vez. La lectura deja de servirla (la última afirmación de la
-- ficha, si está retirada, no dice nada: la ficha vuelve a «no se preguntó»).

ALTER TABLE "patient_allergy_absence"
  ADD COLUMN "retracted_by" UUID,
  ADD COLUMN "retracted_at" TIMESTAMPTZ(6);

ALTER TABLE "patient_allergy_absence"
  ADD CONSTRAINT "patient_allergy_absence_retracted_by_fkey"
    FOREIGN KEY ("retracted_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patient_allergy_absence_retraction_is_whole" CHECK (
    ("retracted_by" IS NULL) = ("retracted_at" IS NULL)
  );

CREATE OR REPLACE FUNCTION patient_allergy_absence_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Nested and not one `AND`: a statement-level TRUNCATE has no OLD row.
  IF TG_OP = 'UPDATE' THEN
    IF OLD."retracted_at" IS NULL
       AND NEW."retracted_at" IS NOT NULL
       AND NEW."id" = OLD."id"
       AND NEW."patient_id" = OLD."patient_id"
       AND NEW."asserted_by" = OLD."asserted_by"
       AND NEW."asserted_at" = OLD."asserted_at"
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'patient_allergy_absence cannot be modified: an assertion is only retracted, once'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'EN-226. Quién lo afirmó y cuándo no cambian; se retira, una vez.';
  END IF;

  RAISE EXCEPTION
    'patient_allergy_absence is never deleted: operation % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Una afirmación clínica no se borra: se retira.';
END;
$$;

CREATE TRIGGER "trg_patient_allergy_absence_record_version"
  BEFORE UPDATE ON "patient_allergy_absence"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_archive('retracted_by', 'retracted_at', 'id');
