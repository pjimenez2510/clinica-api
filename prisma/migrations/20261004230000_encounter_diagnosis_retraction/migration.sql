-- EN-180 a EN-183. Un diagnóstico mal puesto se quita CON RASTRO: se archiva
-- entero en `encounter_diagnosis_retraction` y después se borra de la atención.
--
-- Archivar y retirar, y no una columna «anulado», porque así
-- `encounter_diagnosis` sigue diciendo sólo lo que cuenta y ninguno de sus
-- lectores —el principal único, la receta, la orden, los disparadores de
-- maternidad de D-109 y D-110, el resumen, la exportación— tiene que acordarse
-- de filtrar.

CREATE TABLE "encounter_diagnosis_retraction" (
  "id"              UUID NOT NULL,
  "encounter_id"    UUID NOT NULL,
  "concept_id"      UUID NOT NULL,
  "cie10_code"      VARCHAR(10) NOT NULL,
  "cie10_display"   VARCHAR(512) NOT NULL,
  "certainty"       "diagnosis_certainty" NOT NULL,
  "occurrence"      "diagnosis_occurrence" NOT NULL,
  "rank"            SMALLINT NOT NULL,
  "notifiable"      BOOLEAN NOT NULL,
  "note"            TEXT,
  "recorded_at"     TIMESTAMPTZ(6) NOT NULL,
  "retracted_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "retracted_by_id" UUID NOT NULL,
  "reason"          VARCHAR(500),

  CONSTRAINT "encounter_diagnosis_retraction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "encounter_diagnosis_retraction_encounter_id_idx"
  ON "encounter_diagnosis_retraction"("encounter_id");

ALTER TABLE "encounter_diagnosis_retraction"
  ADD CONSTRAINT "encounter_diagnosis_retraction_encounter_id_fkey"
  FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "encounter_diagnosis_retraction"
  ADD CONSTRAINT "encounter_diagnosis_retraction_concept_id_fkey"
  FOREIGN KEY ("concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "encounter_diagnosis_retraction"
  ADD CONSTRAINT "encounter_diagnosis_retraction_retracted_by_id_fkey"
  FOREIGN KEY ("retracted_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Un motivo vacío o de espacios no es un motivo.
ALTER TABLE "encounter_diagnosis_retraction"
  ADD CONSTRAINT "encounter_diagnosis_retraction_reason_not_blank"
  CHECK ("reason" IS NULL OR btrim("reason") <> '');

-- ═════════════════════════════════════════════════════════════════════════════
-- EN-182. ¿Hay en la atención un papel que lee sus diagnósticos?
-- ═════════════════════════════════════════════════════════════════════════════
--
-- La receta emitida (en cualquier estado: la anulada también se muestra) y la
-- orden (nace numerada) componen el diagnóstico de la atención al mostrarse;
-- el certificado no, lo congela al emitirse (CER-011), y por eso no está.

CREATE OR REPLACE FUNCTION encounter_has_document_citing_diagnoses(p_encounter_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM prescription p
                  WHERE p.encounter_id = p_encounter_id AND p.issued_at IS NOT NULL)
      OR EXISTS (SELECT 1 FROM service_order o
                  WHERE o.encounter_id = p_encounter_id);
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- EN-180, EN-181, EN-182. Lo que se archiva.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- El archivo tiene que ser la fila que se quita, tal cual: se compara con la
-- viva columna a columna, para que nadie archive una versión arreglada.

CREATE OR REPLACE FUNCTION encounter_diagnosis_retraction_admits()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  live encounter_diagnosis%ROWTYPE;
BEGIN
  SELECT * INTO live FROM encounter_diagnosis WHERE id = NEW.id;
  IF NOT FOUND
     OR live.encounter_id IS DISTINCT FROM NEW.encounter_id
     OR live.concept_id IS DISTINCT FROM NEW.concept_id
     OR live.cie10_code IS DISTINCT FROM NEW.cie10_code
     OR live.cie10_display IS DISTINCT FROM NEW.cie10_display
     OR live.certainty IS DISTINCT FROM NEW.certainty
     OR live.occurrence IS DISTINCT FROM NEW.occurrence
     OR live.rank IS DISTINCT FROM NEW.rank
     OR live.notifiable IS DISTINCT FROM NEW.notifiable
     OR live.note IS DISTINCT FROM NEW.note
     OR live.recorded_at IS DISTINCT FROM NEW.recorded_at THEN
    RAISE EXCEPTION
      'encounter_diagnosis_retraction_matches: the archive must be the diagnosis being removed, as it is'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-180.';
  END IF;

  IF NEW.reason IS NULL AND EXISTS (
       SELECT 1 FROM clinical_note n
        WHERE n.encounter_id = NEW.encounter_id AND n.signed_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_retraction_reason: the note is signed, so removing a diagnosis states why'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-181.';
  END IF;

  IF encounter_has_document_citing_diagnoses(NEW.encounter_id) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_cited: an issued receta or an order reads these diagnoses'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-182. Cancel the document first.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_diagnosis_retraction_admits"
  BEFORE INSERT ON "encounter_diagnosis_retraction"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_diagnosis_retraction_admits();

-- El archivo no se edita, no se borra y no se vacía.
CREATE OR REPLACE FUNCTION encounter_diagnosis_retraction_is_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'encounter_diagnosis_retraction_frozen: the archive of removed diagnoses never changes'
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'EN-180.';
END;
$$;

CREATE TRIGGER "encounter_diagnosis_retraction_frozen"
  BEFORE UPDATE OR DELETE ON "encounter_diagnosis_retraction"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_diagnosis_retraction_is_append_only();

CREATE TRIGGER "encounter_diagnosis_retraction_never_truncated"
  BEFORE TRUNCATE ON "encounter_diagnosis_retraction"
  FOR EACH STATEMENT
  EXECUTE FUNCTION encounter_diagnosis_retraction_is_append_only();

-- ═════════════════════════════════════════════════════════════════════════════
-- EN-180. Sin archivo, no hay borrado. Tampoco desde psql.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION encounter_diagnosis_delete_requires_archive()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM encounter_diagnosis_retraction r WHERE r.id = OLD.id) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_archived: a diagnosis is removed only after it is archived'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-180. Insert it into encounter_diagnosis_retraction first.';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "trg_encounter_diagnosis_delete_archived"
  BEFORE DELETE ON "encounter_diagnosis"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_diagnosis_delete_requires_archive();

CREATE TRIGGER "encounter_diagnosis_never_truncated"
  BEFORE TRUNCATE ON "encounter_diagnosis"
  FOR EACH STATEMENT
  EXECUTE FUNCTION encounter_diagnosis_retraction_is_append_only();

-- ═════════════════════════════════════════════════════════════════════════════
-- EN-182, EN-183. Cambiar el principal reordena lo que la receta y la orden
-- imprimen primero: con uno de esos papeles fuera, no se mueve.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION encounter_diagnosis_rank_frozen_when_cited()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.rank IS DISTINCT FROM OLD.rank
     AND encounter_has_document_citing_diagnoses(OLD.encounter_id) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_cited: an issued receta or an order reads these diagnoses'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-182. Cancel the document first.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_diagnosis_rank_frozen_when_cited"
  BEFORE UPDATE OF "rank" ON "encounter_diagnosis"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_diagnosis_rank_frozen_when_cited();
