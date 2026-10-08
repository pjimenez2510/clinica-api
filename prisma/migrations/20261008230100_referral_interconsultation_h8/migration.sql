-- referral_interconsultation_h8
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- ═══════════════════════════════════════════════════════════════════════════
-- encounter H8: REFERENCIA, CONTRARREFERENCIA, DERIVACIÓN E INTERCONSULTA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Las dos tablas existen desde el núcleo clínico y NINGUNA RUTA LAS ESCRIBÍA:
-- están vacías en toda instalación. Por eso la especialidad puede cambiar de
-- tabla sin rellenar nada.
--
-- Lo que garantiza, contra cualquiera que escriba —la API, una importación, un
-- `psql`—:
--
--  * EN-101. La referencia, la derivación y la referencia inversa dicen a
--    DÓNDE: UNICÓDIGO (sólo dígitos) y nombre del establecimiento.
--  * EN-102. Una contrarreferencia responde a una referencia o derivación del
--    mismo paciente, viva, y como mucho a UNA respuesta viva.
--  * EN-103. Si la atención solicitó o recibió la interconsulta (columna 111).
--  * EN-105. Una atención que sale «referida» tiene su referencia.
--  * EN-107. Nada se borra; se anula con quién, cuándo y por qué, y lo emitido
--    no cambia de contenido.

-- En una transacción: si algo falla a mitad, la base se queda como estaba y
-- la migración se puede volver a aplicar.
BEGIN;

-- La especialidad cambia de tabla SIN rellenar nada: sólo vale si las dos
-- tablas están vacías. Se comprueba en vez de suponerlo.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM referral) OR EXISTS (SELECT 1 FROM interconsultation) THEN
    RAISE EXCEPTION 'referral or interconsultation has rows: this migration assumes both are empty';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1. La especialidad de destino: el catálogo MSP de la clínica (REQ-149)
-- ---------------------------------------------------------------------------
-- `specialty_concept_id` apuntaba a `catalog_concept` y nadie lo escribía ni
-- lo leía. La especialidad de la clínica es `specialty`, precargada con las
-- que reconoce el MSP.

ALTER TABLE "referral" DROP CONSTRAINT "referral_specialty_concept_id_fkey";
ALTER TABLE "referral" DROP COLUMN "specialty_concept_id";
ALTER TABLE "referral" ADD COLUMN "specialty_id" UUID;
ALTER TABLE "referral"
  ADD CONSTRAINT "referral_specialty_id_fkey" FOREIGN KEY ("specialty_id")
  REFERENCES "specialty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "interconsultation" DROP CONSTRAINT "interconsultation_specialty_concept_id_fkey";
ALTER TABLE "interconsultation" DROP COLUMN "specialty_concept_id";
ALTER TABLE "interconsultation" ADD COLUMN "specialty_id" UUID;
ALTER TABLE "interconsultation"
  ADD CONSTRAINT "interconsultation_specialty_id_fkey" FOREIGN KEY ("specialty_id")
  REFERENCES "specialty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. EN-104. La nota del formulario 053 o 007, una por fila
-- ---------------------------------------------------------------------------

ALTER TABLE "referral" ADD COLUMN "clinical_note_id" UUID;
CREATE UNIQUE INDEX "referral_clinical_note_id_key" ON "referral"("clinical_note_id");
ALTER TABLE "referral"
  ADD CONSTRAINT "referral_clinical_note_id_fkey" FOREIGN KEY ("clinical_note_id")
  REFERENCES "clinical_note"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "interconsultation" ADD COLUMN "clinical_note_id" UUID;
CREATE UNIQUE INDEX "interconsultation_clinical_note_id_key" ON "interconsultation"("clinical_note_id");
ALTER TABLE "interconsultation"
  ADD CONSTRAINT "interconsultation_clinical_note_id_fkey" FOREIGN KEY ("clinical_note_id")
  REFERENCES "clinical_note"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. EN-107. La anulación, con quién, cuándo y por qué
-- ---------------------------------------------------------------------------

ALTER TABLE "referral"
  ADD COLUMN "cancelled_at" TIMESTAMPTZ(6),
  ADD COLUMN "cancelled_by_id" UUID,
  ADD COLUMN "cancellation_reason" TEXT;
ALTER TABLE "referral"
  ADD CONSTRAINT "referral_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id")
  REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Anulada ⇔ dice quién, cuándo y por qué, con algo escrito.
ALTER TABLE "referral"
  ADD CONSTRAINT "referral_cancellation_complete" CHECK (
    ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)
    AND ("cancelled_at" IS NULL) = ("cancelled_by_id" IS NULL)
    AND ("cancelled_at" IS NULL) = ("cancellation_reason" IS NULL)
    AND ("cancellation_reason" IS NULL OR btrim("cancellation_reason") <> '')
  );

ALTER TABLE "interconsultation"
  ADD COLUMN "cancelled_at" TIMESTAMPTZ(6),
  ADD COLUMN "cancelled_by_id" UUID,
  ADD COLUMN "cancellation_reason" TEXT;
ALTER TABLE "interconsultation"
  ADD CONSTRAINT "interconsultation_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id")
  REFERENCES "practitioner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- `CANCELLED` ya existía sin autor ni motivo. Ninguna fila lo usa (la tabla
-- está vacía), así que la regla entra entera: anulada ⇔ con su constancia.
ALTER TABLE "interconsultation"
  ADD CONSTRAINT "interconsultation_cancellation_complete" CHECK (
    ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)
    AND ("cancelled_at" IS NULL) = ("cancelled_by_id" IS NULL)
    AND ("cancelled_at" IS NULL) = ("cancellation_reason" IS NULL)
    AND ("cancellation_reason" IS NULL OR btrim("cancellation_reason") <> '')
  );

-- ---------------------------------------------------------------------------
-- 4. EN-101, EN-106. A dónde y por qué
-- ---------------------------------------------------------------------------
-- La contrarreferencia vuelve a quien refirió: su destino ya está en la
-- referencia que responde, y no se pide dos veces.

ALTER TABLE "referral"
  ADD CONSTRAINT "referral_destination_stated" CHECK (
    "direction" = 'COUNTER_REFERRAL'
    OR (
      "destination_msp_unicode" IS NOT NULL
      AND "destination_name" IS NOT NULL
      AND btrim("destination_name") <> ''
    )
  );

-- El instructivo da `05176` (Hospital General de Chone): un código numérico.
ALTER TABLE "referral"
  ADD CONSTRAINT "referral_destination_code_format" CHECK (
    "destination_msp_unicode" IS NULL OR "destination_msp_unicode" ~ '^[0-9]{1,20}$'
  );

ALTER TABLE "referral"
  ADD CONSTRAINT "referral_reason_written" CHECK (btrim("reason") <> '');
ALTER TABLE "interconsultation"
  ADD CONSTRAINT "interconsultation_reason_written" CHECK (btrim("reason") <> '');

-- ---------------------------------------------------------------------------
-- 5. EN-102. Como mucho UNA respuesta viva
-- ---------------------------------------------------------------------------
-- El `@unique` contaba también las anuladas: una contrarreferencia registrada
-- por error y anulada dejaba la referencia sin respuesta posible para siempre.

DROP INDEX "referral_responds_to_id_key";
CREATE UNIQUE INDEX "referral_one_live_response" ON "referral" ("responds_to_id")
  WHERE "responds_to_id" IS NOT NULL AND "status" <> 'CANCELLED';
-- La FK necesita su índice para que borrar o leer «quién responde a ésta» no
-- recorra la tabla; el único parcial no lo cubre para las anuladas.
CREATE INDEX "referral_responds_to_id_idx" ON "referral" ("responds_to_id");

-- ---------------------------------------------------------------------------
-- 6. EN-103. Solicitada o recibida (columna 111)
-- ---------------------------------------------------------------------------
-- La solicitada la pide un profesional de aquí y espera respuesta. La recibida
-- se registra al contestarla: quién la pidió suele venir de otro servicio o de
-- fuera, así que es texto, y nace contestada con quien responde y su respuesta.

CREATE TYPE "interconsultation_role" AS ENUM ('REQUESTED', 'RECEIVED');

ALTER TABLE "interconsultation" ADD COLUMN "role" "interconsultation_role";
UPDATE "interconsultation" SET "role" = 'REQUESTED';
ALTER TABLE "interconsultation" ALTER COLUMN "role" SET NOT NULL;

ALTER TABLE "interconsultation" ADD COLUMN "requested_by_name" VARCHAR(240);
ALTER TABLE "interconsultation" ALTER COLUMN "requested_by_id" DROP NOT NULL;

ALTER TABLE "interconsultation"
  ADD CONSTRAINT "interconsultation_role_shape" CHECK (
    CASE "role"
      WHEN 'REQUESTED' THEN
        "requested_by_id" IS NOT NULL AND "requested_by_name" IS NULL
      WHEN 'RECEIVED' THEN
        "requested_by_id" IS NULL
        AND "requested_by_name" IS NOT NULL AND btrim("requested_by_name") <> ''
        AND "responded_by_id" IS NOT NULL AND "responded_at" IS NOT NULL
        AND "opinion" IS NOT NULL AND btrim("opinion") <> ''
        AND "status" IN ('ANSWERED', 'CANCELLED')
    END
  );

-- ---------------------------------------------------------------------------
-- 7. EN-100, EN-102, EN-105, EN-107. La guarda de la referencia
-- ---------------------------------------------------------------------------
-- Un solo disparador, para que «qué puede hacerse con una referencia» se lea
-- en un sitio. Cada rechazo lleva el nombre que `encounter.constraints.ts`
-- traduce, como prefijo de su mensaje.

CREATE OR REPLACE FUNCTION referral_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attention RECORD;
  answered RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'referral % is never deleted: annul it with its reason (EN-107)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT e.patient_id, e.status::text AS status
      INTO attention
      FROM encounter e
     WHERE e.id = NEW.encounter_id;

    -- La fila es del paciente de su atención: la ficha unificada sigue
    -- leyéndola por el enlace (D-031), nunca se le reasigna.
    IF attention.patient_id IS DISTINCT FROM NEW.patient_id THEN
      RAISE EXCEPTION 'referral_patient_matches_encounter: the referral is not of the attention''s patient'
        USING ERRCODE = 'check_violation';
    END IF;

    -- EN-130. Contenido nuevo sólo en una atención viva.
    IF attention.status NOT IN ('OPEN', 'ON_HOLD') THEN
      RAISE EXCEPTION 'referral_needs_live_encounter: the attention no longer accepts new content'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.status::text <> 'ISSUED' THEN
      RAISE EXCEPTION 'referral_born_issued: a referral is born issued'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- EN-107. Lo emitido no cambia de contenido: sólo su estado, el cierre
    -- y la constancia de la anulación.
    IF NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
       OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
       OR NEW.issued_by_id IS DISTINCT FROM OLD.issued_by_id
       OR NEW.direction IS DISTINCT FROM OLD.direction
       OR NEW.destination_msp_unicode IS DISTINCT FROM OLD.destination_msp_unicode
       OR NEW.destination_name IS DISTINCT FROM OLD.destination_name
       OR NEW.specialty_id IS DISTINCT FROM OLD.specialty_id
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.summary IS DISTINCT FROM OLD.summary
       OR NEW.priority IS DISTINCT FROM OLD.priority
       OR NEW.responds_to_id IS DISTINCT FROM OLD.responds_to_id
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR (OLD.clinical_note_id IS NOT NULL
           AND NEW.clinical_note_id IS DISTINCT FROM OLD.clinical_note_id)
    THEN
      RAISE EXCEPTION 'referral % cannot be modified once issued: annul it and issue another (EN-107)', OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Anulada es para siempre.
    IF OLD.status::text = 'CANCELLED' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'referral % cannot be modified once annulled (EN-107)', OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NEW.status::text = 'CANCELLED' AND OLD.status::text <> 'CANCELLED' THEN
      -- EN-102. Lo respondido se anula después de su respuesta, no antes.
      IF EXISTS (
        SELECT 1 FROM referral r
         WHERE r.responds_to_id = NEW.id AND r.status::text <> 'CANCELLED'
      ) THEN
        RAISE EXCEPTION 'referral_answered_cannot_be_cancelled: annul its counter-referral first'
          USING ERRCODE = 'check_violation';
      END IF;

      -- EN-105. La atención que salió «referida» no se queda sin referencia.
      IF NEW.direction::text <> 'COUNTER_REFERRAL'
         AND EXISTS (
           SELECT 1 FROM encounter e
            WHERE e.id = NEW.encounter_id AND e."dischargeCondition" = 'REFERRED'
         )
         AND NOT EXISTS (
           SELECT 1 FROM referral r
            WHERE r.encounter_id = NEW.encounter_id
              AND r.id <> NEW.id
              AND r.direction::text <> 'COUNTER_REFERRAL'
              AND r.status::text <> 'CANCELLED'
         )
      THEN
        RAISE EXCEPTION 'encounter_referred_needs_referral: the attention was discharged as referred'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- EN-102. Lo que una contrarreferencia responde.
  IF TG_OP = 'INSERT' AND NEW.responds_to_id IS NOT NULL THEN
    SELECT r.direction::text AS direction, r.status::text AS status,
           r.patient_id, p.merged_into_id AS answered_merged_into,
           q.merged_into_id AS answering_merged_into
      INTO answered
      FROM referral r
      JOIN patient p ON p.id = r.patient_id
      JOIN patient q ON q.id = NEW.patient_id
     WHERE r.id = NEW.responds_to_id
      -- Choca con el UPDATE que la anula: una anulación en vuelo se espera
      -- y se relee confirmada, y la anulación que llegue después ve esta
      -- respuesta (READ COMMITTED no las serializaba por sí solo).
       FOR SHARE OF r;

    -- `IS DISTINCT FROM` y `COALESCE`: una ficha sin fusión tiene NULL, y un
    -- NULL en un `OR` dejaría pasar la fila en vez de rechazarla.
    IF answered.direction IS DISTINCT FROM 'REFERRAL'
         AND answered.direction IS DISTINCT FROM 'DERIVATION'
       OR answered.status IS NOT DISTINCT FROM 'CANCELLED'
       -- PA-055: la misma persona, aunque una de las dos fichas se unificara
       -- con la otra. Un nivel: las cadenas de fusión no existen (PA-046).
       OR NOT COALESCE(
         answered.patient_id = NEW.patient_id
         OR answered.answered_merged_into IS NOT DISTINCT FROM NEW.patient_id
         OR answered.answering_merged_into IS NOT DISTINCT FROM answered.patient_id,
         false
       )
    THEN
      RAISE EXCEPTION 'referral_thread_coherence: a counter-referral answers a live referral or derivation of the same patient'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- BEFORE para que un rechazo llegue antes que `referral_one_live_response`
-- y diga la razón de fondo.
CREATE TRIGGER trg_referral_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "referral"
  FOR EACH ROW EXECUTE FUNCTION referral_guard();

CREATE OR REPLACE FUNCTION referral_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'referral and interconsultation rows are never deleted (EN-107)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER trg_referral_no_truncate
  BEFORE TRUNCATE ON "referral"
  FOR EACH STATEMENT EXECUTE FUNCTION referral_no_truncate();

-- ---------------------------------------------------------------------------
-- 8. EN-103, EN-107. La guarda de la interconsulta
-- ---------------------------------------------------------------------------
-- La solicitada puede contestarse más adelante (escribir la respuesta y quién
-- la dio); lo pedido no cambia, y anulada es para siempre.

CREATE OR REPLACE FUNCTION interconsultation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attention_status TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'interconsultation % is never deleted: annul it with its reason (EN-107)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT e.status::text INTO attention_status
      FROM encounter e WHERE e.id = NEW.encounter_id;
    IF attention_status NOT IN ('OPEN', 'ON_HOLD') THEN
      RAISE EXCEPTION 'interconsultation_needs_live_encounter: the attention no longer accepts new content'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.requested_by_id IS DISTINCT FROM OLD.requested_by_id
     OR NEW.requested_by_name IS DISTINCT FROM OLD.requested_by_name
     OR NEW.specialty_id IS DISTINCT FROM OLD.specialty_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.findings IS DISTINCT FROM OLD.findings
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     -- La respuesta se escribe una vez —de vacía a contestada— y no cambia:
     -- en una recibida es el único registro de lo contestado.
     OR ((OLD.opinion IS NOT NULL OR OLD.responded_by_id IS NOT NULL OR OLD.responded_at IS NOT NULL)
         AND (NEW.opinion IS DISTINCT FROM OLD.opinion
              OR NEW.responded_by_id IS DISTINCT FROM OLD.responded_by_id
              OR NEW.responded_at IS DISTINCT FROM OLD.responded_at))
     OR (OLD.clinical_note_id IS NOT NULL
         AND NEW.clinical_note_id IS DISTINCT FROM OLD.clinical_note_id)
     OR (OLD.status = 'CANCELLED' AND NEW IS DISTINCT FROM OLD)
  THEN
    RAISE EXCEPTION 'interconsultation % cannot be modified once requested: annul it (EN-107)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_interconsultation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "interconsultation"
  FOR EACH ROW EXECUTE FUNCTION interconsultation_guard();

CREATE TRIGGER trg_interconsultation_no_truncate
  BEFORE TRUNCATE ON "interconsultation"
  FOR EACH STATEMENT EXECUTE FUNCTION referral_no_truncate();

-- ---------------------------------------------------------------------------
-- 8 bis. EN-104, EN-107. El 053 o el 007 sigue a su acto
-- ---------------------------------------------------------------------------
-- La nota de un acto sólo sale del expediente cuando su acto se anula: si se
-- retirara sola, la referencia viva se quedaría sin su papel.

CREATE OR REPLACE FUNCTION clinical_note_act_form_follows_its_act()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM referral r WHERE r.clinical_note_id = NEW.id AND r.status::text = 'CANCELLED')
     AND NOT EXISTS (SELECT 1 FROM interconsultation i WHERE i.clinical_note_id = NEW.id AND i.status::text = 'CANCELLED')
  THEN
    RAISE EXCEPTION 'clinical_note_act_form_follows_its_act: annul the referral or interconsultation instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_clinical_note_act_form_follows_its_act
  BEFORE UPDATE OF status ON "clinical_note"
  FOR EACH ROW
  WHEN (NEW.form_code IN ('053', '007')
        AND NEW.status = 'ENTERED_IN_ERROR'
        AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION clinical_note_act_form_follows_its_act();

-- ---------------------------------------------------------------------------
-- 9. EN-105. Salir «referido» exige la referencia
-- ---------------------------------------------------------------------------
-- DIFERIDO a COMMIT: la firma escribe la referencia y el alta en la misma
-- transacción, en el orden que quiera. La firma lo dice antes, bajo el
-- candado, con su frase; esto es para lo que llegue por otra vía.

CREATE OR REPLACE FUNCTION encounter_referred_needs_referral()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."dischargeCondition" = 'REFERRED'
     AND NOT EXISTS (
       SELECT 1 FROM referral r
        WHERE r.encounter_id = NEW.id
          AND r.direction::text <> 'COUNTER_REFERRAL'
          AND r.status::text <> 'CANCELLED'
     )
  THEN
    RAISE EXCEPTION 'encounter_referred_needs_referral: an attention discharged as referred needs its referral'
      USING ERRCODE = 'check_violation',
            HINT = 'EN-105.';
  END IF;
  RETURN NULL;
END;
$$;

-- La columna se llama `"dischargeCondition"`: es de las cuatro del núcleo
-- clínico que nacieron sin `@map`.
CREATE CONSTRAINT TRIGGER trg_encounter_referred_needs_referral
  AFTER INSERT OR UPDATE OF "dischargeCondition" ON "encounter"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."dischargeCondition" = 'REFERRED')
  EXECUTE FUNCTION encounter_referred_needs_referral();

COMMIT;
