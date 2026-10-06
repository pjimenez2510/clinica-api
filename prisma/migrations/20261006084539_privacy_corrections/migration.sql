-- privacy_corrections
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- PD-044, PD-046, PD-047 (D-127, D-128.8, D-128.9): LO MAL REGISTRADO EN
-- PRIVACIDAD SE CORRIGE, Y LO ANTERIOR NO SE BORRA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La carga de la prueba es del responsable (D.E. 904 art. 5): nada de lo que
-- prueba un consentimiento o la atención de un derecho se reescribe. Por eso
-- cada corrección es de una forma distinta, según lo que se corrige:
--
--   · PD-044. Un CONSENTIMIENTO mal registrado (medio u otorgante) se corrige
--     con una fila NUEVA que nombra al original (`supersedes_id`). El
--     original queda intacto —`trg_patient_consent_immutable` no cambia— y el
--     vigente es el que nadie sustituye. Un original se sustituye una vez.
--   · PD-046. Una SOLICITUD sin responder se EDITA —derecho, qué pide, fecha
--     de recepción y, con ellas, el vencimiento (D-128.9)— con sello
--     `changed_by` / `changed_at`, y la fila anterior la guarda
--     `record_version` (EN-210). Responder también lleva sello.
--     `data_subject_request_only_answered_once` conserva su nombre y su
--     regla: lo respondido no cambia nunca.
--   · PD-047. Una RESPUESTA dada se rectifica con una fila nueva en
--     `data_subject_answer_correction`, enlazada a la que corrige; la
--     original sigue en la solicitud. Solo inserción.
--
-- NO SE TOCA NINGUNA FILA GUARDADA. `ADD COLUMN` sin defecto no ejecuta un
-- UPDATE ni dispara nada: los consentimientos existentes no sustituyen a
-- nadie y las solicitudes existentes quedan sin sello, que es la verdad.
--
-- ⚠️ El orden de los BEFORE UPDATE es alfabético:
-- `…_only_answered_once` va antes que `…_record_version`, así que lo que se
-- rechaza no llega a archivar nada.


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. patient_consent: la corrección sustituye al original (PD-044)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "patient_consent"
  ADD COLUMN "supersedes_id" UUID;

ALTER TABLE "patient_consent"
  ADD CONSTRAINT "patient_consent_supersedes_id_fkey"
    FOREIGN KEY ("supersedes_id") REFERENCES "patient_consent"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "patient_consent_supersedes_not_self" CHECK (
    "supersedes_id" IS NULL OR "supersedes_id" <> "id"
  );

-- Un original se corrige UNA vez: la corrección de la corrección nombra a la
-- corrección. Es lo que hace que «el vigente» sea exactamente uno.
CREATE UNIQUE INDEX "patient_consent_corrected_once"
  ON "patient_consent" ("supersedes_id");

-- La corrección es del MISMO paciente y sobre el MISMO texto: se corrige cómo
-- se registró (el medio, quién lo otorgó), no qué se consintió ni de quién.
CREATE OR REPLACE FUNCTION patient_consent_correction_matches()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  original RECORD;
BEGIN
  IF NEW."supersedes_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "patient_id", "text_version_id" INTO original
    FROM "patient_consent" WHERE "id" = NEW."supersedes_id";
  IF original IS NULL
     OR original."patient_id" <> NEW."patient_id"
     OR original."text_version_id" <> NEW."text_version_id" THEN
    RAISE EXCEPTION 'patient_consent_correction_matches: a correction keeps the patient and the text of the consent it replaces'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'patient_consent_correction_matches',
            HINT = 'PD-044. Se corrige el medio o el otorgante; otro texto es otro consentimiento.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_patient_consent_correction_matches"
  BEFORE INSERT ON "patient_consent"
  FOR EACH ROW
  EXECUTE FUNCTION patient_consent_correction_matches();


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. data_subject_request: se edita mientras no se responda (PD-046)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "data_subject_request"
  ADD COLUMN "changed_by" UUID,
  ADD COLUMN "changed_at" TIMESTAMPTZ(6);

ALTER TABLE "data_subject_request"
  ADD CONSTRAINT "data_subject_request_changed_by_fkey"
    FOREIGN KEY ("changed_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "data_subject_request_change_stamped" CHECK (
    ("changed_by" IS NULL) = ("changed_at" IS NULL)
  );

-- PD-038, PD-046. Dos UPDATE posibles, nunca los dos a la vez, y ninguno sobre
-- una respondida:
--   · EDITAR lo que se pidió mientras está abierta: el derecho, qué pide, la
--     recepción y el vencimiento que de ellas sale (D-128.9);
--   · RESPONDER, una vez y entera, sin tocar nada de lo registrado.
-- En los dos: ni el id, ni el paciente, ni quién la presenta, ni quién y
-- cuándo la registró. El sello lo exige `record_version_archive`, después.
CREATE OR REPLACE FUNCTION data_subject_request_only_answered_once()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."outcome" IS NOT NULL THEN
    RAISE EXCEPTION 'data_subject_request % is already answered', OLD."id"
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Una solicitud respondida no se modifica; su respuesta se rectifica (PD-047).';
  END IF;
  IF NEW."id"            IS DISTINCT FROM OLD."id"
     OR NEW."patient_id"    IS DISTINCT FROM OLD."patient_id"
     OR NEW."requested_by"  IS DISTINCT FROM OLD."requested_by"
     OR NEW."registered_at" IS DISTINCT FROM OLD."registered_at"
     OR NEW."registered_by" IS DISTINCT FROM OLD."registered_by" THEN
    RAISE EXCEPTION 'data_subject_request_only_answered_once: a request never changes its patient, who presents it or who registered it'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'PD-038, PD-046.';
  END IF;
  -- Responder: nada de lo registrado se mueve con la respuesta.
  IF NEW."outcome" IS NOT NULL
     AND (NEW."right"          IS DISTINCT FROM OLD."right"
          OR NEW."description" IS DISTINCT FROM OLD."description"
          OR NEW."received_at" IS DISTINCT FROM OLD."received_at"
          OR NEW."due_on"      IS DISTINCT FROM OLD."due_on") THEN
    RAISE EXCEPTION 'data_subject_request admits only its answer'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Lo registrado y su vencimiento no cambian al responder (PD-032, PD-038).';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_data_subject_request_record_version"
  BEFORE UPDATE ON "data_subject_request"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_archive('changed_by', 'changed_at', 'id');


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. data_subject_answer_correction: la respuesta rectificada (PD-047)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "data_subject_answer_correction" (
  "id"          UUID PRIMARY KEY DEFAULT uuidv7(),
  "request_id"  UUID NOT NULL,
  -- La rectificación que ésta sustituye; NULL = sustituye a la respuesta
  -- original, que vive en la solicitud.
  "corrects_id" UUID,
  "outcome"     "data_request_outcome" NOT NULL,
  "response"    TEXT NOT NULL,
  "answered_at" TIMESTAMPTZ(6) NOT NULL,
  "answered_by" UUID NOT NULL,

  CONSTRAINT "data_subject_answer_correction_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "data_subject_request"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "data_subject_answer_correction_corrects_id_fkey"
    FOREIGN KEY ("corrects_id") REFERENCES "data_subject_answer_correction"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "data_subject_answer_correction_answered_by_fkey"
    FOREIGN KEY ("answered_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- La respuesta es contenido, no un motivo (D-128.9): obligatoria, como la
  -- original.
  CONSTRAINT "data_subject_answer_correction_response_valid" CHECK (
    btrim("response") <> '' AND char_length("response") <= 4000
  )
);

-- Una cadena, no un árbol: la respuesta vigente es exactamente una.
CREATE UNIQUE INDEX "data_subject_answer_correction_chain_once"
  ON "data_subject_answer_correction" ("corrects_id");
CREATE UNIQUE INDEX "data_subject_answer_correction_first_once"
  ON "data_subject_answer_correction" ("request_id")
  WHERE "corrects_id" IS NULL;

-- Se rectifica lo respondido, y la rectificación nombra una de SU solicitud.
CREATE OR REPLACE FUNCTION data_subject_answer_correction_follows()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM "data_subject_request"
        WHERE "id" = NEW."request_id" AND "outcome" IS NOT NULL)
     OR (NEW."corrects_id" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "data_subject_answer_correction"
        WHERE "id" = NEW."corrects_id" AND "request_id" = NEW."request_id")) THEN
    RAISE EXCEPTION 'data_subject_answer_correction_follows: only an answered request is rectified, and a rectification names one of the same request'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'data_subject_answer_correction_follows',
            HINT = 'PD-047.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_data_subject_answer_correction_follows"
  BEFORE INSERT ON "data_subject_answer_correction"
  FOR EACH ROW
  EXECUTE FUNCTION data_subject_answer_correction_follows();

CREATE TRIGGER "trg_data_subject_answer_correction_immutable"
  BEFORE UPDATE OR DELETE ON "data_subject_answer_correction"
  FOR EACH ROW EXECUTE FUNCTION privacy_insert_only();
CREATE TRIGGER "trg_data_subject_answer_correction_no_truncate"
  BEFORE TRUNCATE ON "data_subject_answer_correction"
  FOR EACH STATEMENT EXECUTE FUNCTION privacy_insert_only();
