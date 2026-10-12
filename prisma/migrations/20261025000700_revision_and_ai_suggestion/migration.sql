-- revision_and_ai_suggestion
--
-- Escrito a mano. feat/ia-a1-procedencia-if-match (PLAN-ASISTENTE-IA.md §7 A1).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. LA REVISIÓN DE UN BORRADOR (EN-283, PR-122, ORD-182)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hasta hoy la última escritura de un borrador de nota, receta u orden pisaba
-- a la otra: dos pestañas, o el asistente escribiendo mientras el médico
-- teclea, perdían texto sin que nadie lo viera. Ahora cada borrador lleva una
-- `revision`, la API exige la que se leyó en `If-Match` y rechaza con 412 la
-- escritura hecha sobre otra (EN-281, PR-121, ORD-181).
--
-- POR QUÉ LA SUBE LA BASE. Un `UPDATE` de `psql`, de una importación o del
-- asistente también tiene que invalidar lo que otra pestaña leyó; si la
-- subiera la aplicación, el que escribe por otro camino no la subiría. El
-- disparador pone la anterior más uno sea cual sea el valor que llegue.
--
-- SÓLO MIENTRAS ES BORRADOR (o vuelve a serlo). Lo firmado o emitido lo
-- congelan sus propios disparadores —`prescription_frozen` compara la fila
-- entera—, y una revisión que cambiara en una anulación los haría saltar.
-- Una columna nueva y no `updated_at`: dos escrituras en el mismo
-- milisegundo tendrían el mismo instante, y `@updatedAt` lo pone Prisma en
-- el cliente. `revision` y no `version`: `clinical_note.version` ya es el
-- número de la enmienda (EN-025).
BEGIN;

ALTER TABLE "clinical_note" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "prescription"  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "service_order" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "clinical_note" ADD CONSTRAINT "clinical_note_revision_positive" CHECK ("revision" >= 1);
ALTER TABLE "prescription"  ADD CONSTRAINT "prescription_revision_positive"  CHECK ("revision" >= 1);
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_revision_positive" CHECK ("revision" >= 1);

CREATE OR REPLACE FUNCTION draft_revision_counts_writes()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status::text = 'DRAFT' OR NEW.status::text = 'DRAFT' THEN
    NEW.revision := OLD.revision + 1;
  ELSE
    NEW.revision := OLD.revision;
  END IF;
  RETURN NEW;
END;
$$;

-- `a_` so it runs before the other BEFORE UPDATE triggers (they fire in name
-- order) and every one of them sees the revision already settled.
CREATE TRIGGER "a_clinical_note_revision_counts_writes"
  BEFORE UPDATE ON "clinical_note"
  FOR EACH ROW EXECUTE FUNCTION draft_revision_counts_writes();
CREATE TRIGGER "a_prescription_revision_counts_writes"
  BEFORE UPDATE ON "prescription"
  FOR EACH ROW EXECUTE FUNCTION draft_revision_counts_writes();
CREATE TRIGGER "a_service_order_revision_counts_writes"
  BEFORE UPDATE ON "service_order"
  FOR EACH ROW EXECUTE FUNCTION draft_revision_counts_writes();

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. LA PROCEDENCIA DE CADA PROPUESTA (AS-020 a AS-024)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Ninguna tabla clínica dice de dónde salió un dato (PLAN-ASISTENTE-IA.md §4).
-- En vez de una columna en cada una, la propuesta guarda su estado y el id de
-- lo que se guardó: un FK por destino, para que la base garantice que el
-- registro existe —un par tipo+id no podría— y que es de la MISMA atención.
--
-- Una decisión es definitiva y lo propuesto no se reescribe ni se borra: lo
-- que el médico hizo con lo que se le propuso es la traza de P1 («propone, no
-- actúa»). Al decidir, `record_version` archiva la fila propuesta entera; no
-- guarda secretos —ni claves ni texto seudonimizado—, sólo lo que se mostró.
CREATE TABLE "ai_suggestion" (
  "id"                     UUID           NOT NULL DEFAULT uuidv7(),
  "encounter_id"           UUID           NOT NULL,
  "ai_run_id"              UUID           NOT NULL,
  "kind"                   VARCHAR(24)    NOT NULL,
  "proposal"               JSONB          NOT NULL,
  "sources"                JSONB          NOT NULL,
  "status"                 VARCHAR(24)    NOT NULL DEFAULT 'PROPOSED',
  "distance"               DECIMAL(5,4),
  "clinical_note_id"       UUID,
  "encounter_diagnosis_id" UUID,
  "prescription_id"        UUID,
  "service_order_id"       UUID,
  "proposed_at"            TIMESTAMPTZ(6) NOT NULL,
  "decided_by"             UUID,
  "decided_at"             TIMESTAMPTZ(6),

  CONSTRAINT "ai_suggestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_suggestion_encounter_id_fkey" FOREIGN KEY ("encounter_id")
    REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_suggestion_ai_run_id_fkey" FOREIGN KEY ("ai_run_id")
    REFERENCES "ai_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_suggestion_clinical_note_id_fkey" FOREIGN KEY ("clinical_note_id")
    REFERENCES "clinical_note"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_suggestion_encounter_diagnosis_id_fkey" FOREIGN KEY ("encounter_diagnosis_id")
    REFERENCES "encounter_diagnosis"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_suggestion_prescription_id_fkey" FOREIGN KEY ("prescription_id")
    REFERENCES "prescription"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_suggestion_service_order_id_fkey" FOREIGN KEY ("service_order_id")
    REFERENCES "service_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_suggestion_decided_by_fkey" FOREIGN KEY ("decided_by")
    REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE,

  -- AS-020. The `IS NOT NULL` is not redundant: `NULL IN (...)` is NULL, and a
  -- CHECK that yields NULL lets the row through.
  CONSTRAINT "ai_suggestion_kind_known" CHECK ("kind" IS NOT NULL AND "kind" IN (
    'note-section', 'diagnosis', 'prescription-item', 'order-item')),
  CONSTRAINT "ai_suggestion_status_known" CHECK ("status" IS NOT NULL AND "status" IN (
    'PROPOSED', 'ACCEPTED', 'ACCEPTED_WITH_CHANGES', 'DISCARDED')),
  CONSTRAINT "ai_suggestion_proposal_is_object"
    CHECK (jsonb_typeof("proposal") = 'object'),
  CONSTRAINT "ai_suggestion_sources_are_a_list"
    CHECK (jsonb_typeof("sources") = 'array'),

  -- AS-021. Who and when: both exactly when decided.
  CONSTRAINT "ai_suggestion_decision_states_who_and_when" CHECK (
    ("status" = 'PROPOSED' AND "decided_by" IS NULL AND "decided_at" IS NULL)
    OR ("status" <> 'PROPOSED' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)),

  -- AS-021. Accepted ⇔ exactly one record, and the one its kind names.
  CONSTRAINT "ai_suggestion_accepted_links_its_record" CHECK (
    CASE WHEN "status" IN ('ACCEPTED', 'ACCEPTED_WITH_CHANGES') THEN
      num_nonnulls("clinical_note_id", "encounter_diagnosis_id",
                   "prescription_id", "service_order_id") = 1
      AND CASE "kind"
        WHEN 'note-section'      THEN "clinical_note_id" IS NOT NULL
        WHEN 'diagnosis'         THEN "encounter_diagnosis_id" IS NOT NULL
        WHEN 'prescription-item' THEN "prescription_id" IS NOT NULL
        WHEN 'order-item'        THEN "service_order_id" IS NOT NULL
        ELSE false
      END
    ELSE
      num_nonnulls("clinical_note_id", "encounter_diagnosis_id",
                   "prescription_id", "service_order_id") = 0
    END),

  -- AS-022. 0 unchanged, (0, 1] changed, nothing undecided or discarded.
  CONSTRAINT "ai_suggestion_distance_matches_status" CHECK (
    CASE "status"
      WHEN 'ACCEPTED'              THEN "distance" IS NOT NULL AND "distance" = 0
      WHEN 'ACCEPTED_WITH_CHANGES' THEN "distance" IS NOT NULL AND "distance" > 0 AND "distance" <= 1
      ELSE "distance" IS NULL
    END)
);

CREATE INDEX "ai_suggestion_encounter_id_idx" ON "ai_suggestion"("encounter_id");
CREATE INDEX "ai_suggestion_ai_run_id_idx" ON "ai_suggestion"("ai_run_id");

-- AS-021. The linked record belongs to the suggestion's attention.
CREATE OR REPLACE FUNCTION ai_suggestion_record_in_its_encounter()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  record_encounter UUID;
BEGIN
  IF NEW."clinical_note_id" IS NOT NULL THEN
    SELECT "encounter_id" INTO record_encounter FROM "clinical_note" WHERE "id" = NEW."clinical_note_id";
  ELSIF NEW."encounter_diagnosis_id" IS NOT NULL THEN
    SELECT "encounter_id" INTO record_encounter FROM "encounter_diagnosis" WHERE "id" = NEW."encounter_diagnosis_id";
  ELSIF NEW."prescription_id" IS NOT NULL THEN
    SELECT "encounter_id" INTO record_encounter FROM "prescription" WHERE "id" = NEW."prescription_id";
  ELSIF NEW."service_order_id" IS NOT NULL THEN
    SELECT "encounter_id" INTO record_encounter FROM "service_order" WHERE "id" = NEW."service_order_id";
  ELSE
    RETURN NEW;
  END IF;

  IF record_encounter IS DISTINCT FROM NEW."encounter_id" THEN
    RAISE EXCEPTION 'ai_suggestion_record_in_its_encounter: the accepted record belongs to another attention'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'ai_suggestion_record_in_its_encounter',
            HINT = 'AS-021. Una propuesta enlaza a lo que se guardó en su propia atención.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ai_suggestion_record_in_its_encounter"
  BEFORE INSERT OR UPDATE ON "ai_suggestion"
  FOR EACH ROW EXECUTE FUNCTION ai_suggestion_record_in_its_encounter();

-- AS-023. Decided once; what was proposed is never rewritten; never deleted.
CREATE OR REPLACE FUNCTION ai_suggestion_decided_once()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ai_suggestion_is_kept: a suggestion is never deleted'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'AS-023. Lo que se hizo con una propuesta es la traza; el plazo es D-243 §2.';
  END IF;

  IF OLD."status" <> 'PROPOSED'
     OR NEW."encounter_id" IS DISTINCT FROM OLD."encounter_id"
     OR NEW."ai_run_id"    IS DISTINCT FROM OLD."ai_run_id"
     OR NEW."kind"         IS DISTINCT FROM OLD."kind"
     OR NEW."proposal"     IS DISTINCT FROM OLD."proposal"
     OR NEW."sources"      IS DISTINCT FROM OLD."sources"
     OR NEW."proposed_at"  IS DISTINCT FROM OLD."proposed_at" THEN
    RAISE EXCEPTION 'ai_suggestion_decided_once: a suggestion is decided once and what it proposed is not rewritten'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'ai_suggestion_decided_once',
            HINT = 'AS-023.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ai_suggestion_decided_once"
  BEFORE UPDATE OR DELETE ON "ai_suggestion"
  FOR EACH ROW EXECUTE FUNCTION ai_suggestion_decided_once();

CREATE TRIGGER "ai_suggestion_never_truncated"
  BEFORE TRUNCATE ON "ai_suggestion"
  FOR EACH STATEMENT EXECUTE FUNCTION record_version_insert_only();

-- AS-024. The proposed row, archived whole when it is decided.
CREATE TRIGGER "trg_ai_suggestion_record_version"
  BEFORE UPDATE ON "ai_suggestion"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_archive('decided_by', 'decided_at', 'id');

COMMIT;
