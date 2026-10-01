-- privacy_consent_and_requests
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Después: pnpm migrations:check && pnpm db:deploy

-- QUÉ GARANTIZA: lo que la LOPDP obliga a poder DEMOSTRAR (módulo `privacy`).
--
--   1. PD-001, PD-003, PD-005 · el texto del consentimiento en versiones
--      correlativas que no se reescriben; dos publicaciones a la vez no pueden
--      quedarse con el mismo número.
--   2. PD-010, PD-013, PD-014 · el consentimiento del paciente, ligado a la
--      versión exacta, que tampoco se reescribe: una versión nueva no puede
--      tocar lo ya consentido porque nada puede tocarlo.
--   3. PD-030 a PD-033, PD-038 · la solicitud del titular con su vencimiento,
--      que no se borra y que solo admite un cambio: recibir su respuesta,
--      completa, una vez.
--
-- POR QUÉ LA BASE Y NO EL SERVICIO. Son pruebas ante la autoridad (Reglamento
-- D.E. 904 arts. 5 y 15). Una fila que un UPDATE a mano pudiera reescribir no
-- prueba qué consintió nadie.
--
-- PARA DESHACERLA: `DROP TABLE data_subject_request, patient_consent,
-- consent_text_version`, los cuatro tipos y las tres funciones de abajo.


CREATE TYPE "consent_medium" AS ENUM ('SIGNED_PAPER', 'ON_SCREEN');

-- Quién actúa: el titular o su representante legal. Lo mismo para quien otorga
-- el consentimiento y para quien presenta una solicitud (LOPDP arts. 21 y 24).
CREATE TYPE "data_subject_party" AS ENUM ('HOLDER', 'REPRESENTATIVE');

-- LOPDP arts. 13 a 17 y 19.
CREATE TYPE "data_subject_right" AS ENUM (
  'ACCESS', 'RECTIFICATION', 'ERASURE', 'OBJECTION', 'PORTABILITY', 'SUSPENSION'
);

CREATE TYPE "data_request_outcome" AS ENUM (
  'GRANTED', 'PARTIALLY_GRANTED', 'DENIED'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. consent_text_version
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "consent_text_version" (
  "id"           UUID         NOT NULL DEFAULT uuidv7(),
  "version"      INTEGER      NOT NULL,
  "body"         TEXT         NOT NULL,
  -- `statement_timestamp()` and not `now()`: `now()` is when the transaction
  -- BEGAN, which can precede the advisory lock that orders publications and
  -- consents (PD-012); the INSERT runs with the lock held.
  "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT statement_timestamp(),
  "published_by" UUID         NOT NULL,

  CONSTRAINT "consent_text_version_pkey" PRIMARY KEY ("id"),
  -- PD-005. Lo que arbitra la carrera entre dos publicaciones.
  CONSTRAINT "consent_text_version_number_unique" UNIQUE ("version"),
  CONSTRAINT "consent_text_version_number_positive" CHECK ("version" >= 1),
  -- PD-004. Un texto en blanco no informa de nada.
  CONSTRAINT "consent_text_version_body_valid" CHECK (
    btrim("body") <> '' AND char_length("body") <= 20000
  ),
  CONSTRAINT "consent_text_version_published_by_fkey"
    FOREIGN KEY ("published_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

-- PD-001. CORRELATIVA: la versión nueva es exactamente la siguiente. Sin esto
-- un cliente podría publicar la 7 tras la 2 y el hueco haría pensar que se
-- perdieron cuatro textos. Dos inserciones simultáneas calculan el mismo
-- número y `consent_text_version_number_unique` deja pasar solo una (PD-005).
CREATE OR REPLACE FUNCTION consent_text_version_is_next()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  expected INTEGER;
BEGIN
  SELECT COALESCE(max("version"), 0) + 1 INTO expected FROM "consent_text_version";
  IF NEW."version" <> expected THEN
    RAISE EXCEPTION 'consent_text_version_is_next: version must be % and not %', expected, NEW."version"
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'consent_text_version_is_next';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_consent_text_version_is_next
  BEFORE INSERT ON "consent_text_version"
  FOR EACH ROW
  EXECUTE FUNCTION consent_text_version_is_next();


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. patient_consent
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "patient_consent" (
  "id"              UUID             NOT NULL DEFAULT uuidv7(),
  "patient_id"      UUID             NOT NULL,
  "text_version_id" UUID             NOT NULL,
  "medium"          "consent_medium" NOT NULL,
  "granted_by"      "data_subject_party" NOT NULL,
  -- PD-011. El instante y el autor son del servidor.
  "recorded_at"     TIMESTAMPTZ(6)   NOT NULL DEFAULT statement_timestamp(),
  "recorded_by"     UUID             NOT NULL,

  CONSTRAINT "patient_consent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "patient_consent_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "patient"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "patient_consent_text_version_id_fkey"
    FOREIGN KEY ("text_version_id") REFERENCES "consent_text_version"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "patient_consent_recorded_by_fkey"
    FOREIGN KEY ("recorded_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "patient_consent_by_patient"
  ON "patient_consent" ("patient_id", "recorded_at" DESC);


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. data_subject_request
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "data_subject_request" (
  "id"            UUID                 NOT NULL DEFAULT uuidv7(),
  "patient_id"    UUID                 NOT NULL,
  "right"         "data_subject_right" NOT NULL,
  "requested_by"  "data_subject_party" NOT NULL,
  "description"   TEXT                 NOT NULL,
  -- Default: the same `now()` as `registered_at`, so «recibida ahora» never
  -- trips the CHECK below because the API's clock runs ahead of the base's.
  "received_at"   TIMESTAMPTZ(6)       NOT NULL DEFAULT now(),
  -- PD-032. Fecha clínica, fijada al registrar y nunca recalculada.
  "due_on"        DATE                 NOT NULL,
  "registered_at" TIMESTAMPTZ(6)       NOT NULL DEFAULT now(),
  "registered_by" UUID                 NOT NULL,
  "outcome"       "data_request_outcome",
  "response"      TEXT,
  "answered_at"   TIMESTAMPTZ(6),
  "answered_by"   UUID,

  CONSTRAINT "data_subject_request_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "data_subject_request_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "patient"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "data_subject_request_registered_by_fkey"
    FOREIGN KEY ("registered_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "data_subject_request_answered_by_fkey"
    FOREIGN KEY ("answered_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "data_subject_request_description_valid" CHECK (
    btrim("description") <> '' AND char_length("description") <= 4000
  ),
  -- PD-031. Una solicitud no se recibe en el futuro.
  CONSTRAINT "data_subject_request_received_not_future" CHECK (
    "received_at" <= "registered_at"
  ),
  -- Un vencimiento anterior a la recepción sería una solicitud vencida al nacer.
  CONSTRAINT "data_subject_request_due_after_receipt" CHECK (
    "due_on" >= ("received_at" AT TIME ZONE 'America/Guayaquil')::date
  ),
  -- PD-033. La respuesta va entera o no va.
  CONSTRAINT "data_subject_request_answer_complete" CHECK (
    ("outcome" IS NULL AND "response" IS NULL
      AND "answered_at" IS NULL AND "answered_by" IS NULL)
    OR ("outcome" IS NOT NULL AND "response" IS NOT NULL
      AND "answered_at" IS NOT NULL AND "answered_by" IS NOT NULL)
  ),
  CONSTRAINT "data_subject_request_response_valid" CHECK (
    "response" IS NULL
    OR (btrim("response") <> '' AND char_length("response") <= 4000)
  )
);

CREATE INDEX "data_subject_request_by_patient"
  ON "data_subject_request" ("patient_id", "received_at" DESC);

-- PD-035. Las abiertas por vencimiento; las respondidas no entran.
CREATE INDEX "data_subject_request_open_by_due"
  ON "data_subject_request" ("due_on")
  WHERE "outcome" IS NULL;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Inmutabilidad (PD-003, PD-014, PD-038)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION privacy_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: operation % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Un texto publicado o un consentimiento registrado es prueba: se registra uno nuevo, no se reescribe.';
END;
$$;

CREATE TRIGGER trg_consent_text_version_immutable
  BEFORE UPDATE OR DELETE ON "consent_text_version"
  FOR EACH ROW EXECUTE FUNCTION privacy_insert_only();
CREATE TRIGGER trg_consent_text_version_no_truncate
  BEFORE TRUNCATE ON "consent_text_version"
  FOR EACH STATEMENT EXECUTE FUNCTION privacy_insert_only();

CREATE TRIGGER trg_patient_consent_immutable
  BEFORE UPDATE OR DELETE ON "patient_consent"
  FOR EACH ROW EXECUTE FUNCTION privacy_insert_only();
CREATE TRIGGER trg_patient_consent_no_truncate
  BEFORE TRUNCATE ON "patient_consent"
  FOR EACH STATEMENT EXECUTE FUNCTION privacy_insert_only();

-- PD-038. La única modificación: de sin responder a respondida, sin tocar nada
-- de lo que se registró. `data_subject_request_answer_complete` ya obliga a que
-- la respuesta llegue entera.
CREATE OR REPLACE FUNCTION data_subject_request_only_answered_once()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."outcome" IS NOT NULL THEN
    RAISE EXCEPTION 'data_subject_request % is already answered', OLD."id"
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Una solicitud respondida no se modifica.';
  END IF;
  IF NEW."outcome" IS NULL
     OR NEW."id"            IS DISTINCT FROM OLD."id"
     OR NEW."patient_id"    IS DISTINCT FROM OLD."patient_id"
     OR NEW."right"         IS DISTINCT FROM OLD."right"
     OR NEW."requested_by"  IS DISTINCT FROM OLD."requested_by"
     OR NEW."description"   IS DISTINCT FROM OLD."description"
     OR NEW."received_at"   IS DISTINCT FROM OLD."received_at"
     OR NEW."due_on"        IS DISTINCT FROM OLD."due_on"
     OR NEW."registered_at" IS DISTINCT FROM OLD."registered_at"
     OR NEW."registered_by" IS DISTINCT FROM OLD."registered_by" THEN
    RAISE EXCEPTION 'data_subject_request admits only its answer'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Lo registrado y su vencimiento no cambian (PD-032, PD-038).';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_data_subject_request_only_answered_once
  BEFORE UPDATE ON "data_subject_request"
  FOR EACH ROW EXECUTE FUNCTION data_subject_request_only_answered_once();
CREATE TRIGGER trg_data_subject_request_no_delete
  BEFORE DELETE ON "data_subject_request"
  FOR EACH ROW EXECUTE FUNCTION privacy_insert_only();
CREATE TRIGGER trg_data_subject_request_no_truncate
  BEFORE TRUNCATE ON "data_subject_request"
  FOR EACH STATEMENT EXECUTE FUNCTION privacy_insert_only();
