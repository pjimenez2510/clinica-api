-- procedure_written_consent
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-152 A EN-154, BI-256 (D-159): EL CONSENTIMIENTO INFORMADO ESCRITO (024)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. LA MARCA POR PRESTACIÓN (BI-256, D-159.1 y .5). La clínica marca las
--    prestaciones que exigen el 024; apagada por defecto, con quién y cuándo.
--    Sólo una prestación atada a un procedimiento del tarifario la lleva.
--
-- 2. EL 024 ATADO AL PROCEDIMIENTO (EN-152, D-159.2 y .3). Una fila por
--    papel firmado o por excepción, nombrando el concepto que cubre. Un
--    disparador DIFERIDO, al final de la transacción, rechaza el
--    procedimiento que lo exige sin él: el procedimiento y su consentimiento
--    se escriben en la misma transacción, en cualquier orden.
--
-- 3. LA NEGATIVA (EN-153, D-159.4). Otra clase de la misma fila, sin
--    procedimiento: quién se negó, o el testigo externo si nadie firma.
--
-- 4. LA REVOCACIÓN (EN-154, D-159.4). Fila aparte, una por consentimiento
--    firmado. Nada de esto se edita ni se borra.
--
-- Los instantes los pone la aplicación (los recorridos mueven su reloj):
-- ningún `now()` aquí. No se toca ninguna fila guardada: la marca nace
-- apagada en todas las prestaciones.

-- ── 1. La marca ─────────────────────────────────────────────────────────
ALTER TABLE "billable_service"
  ADD COLUMN "requires_written_consent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "written_consent_set_at" TIMESTAMPTZ(6),
  ADD COLUMN "written_consent_set_by_id" UUID;

ALTER TABLE "billable_service"
  ADD CONSTRAINT "billable_service_written_consent_setter_fk"
  FOREIGN KEY ("written_consent_set_by_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Quién y cuándo, juntos o ninguno; y marcada, siempre con los dos.
ALTER TABLE "billable_service"
  ADD CONSTRAINT "billable_service_written_consent_states_who" CHECK (
    ("written_consent_set_at" IS NULL) = ("written_consent_set_by_id" IS NULL)
    AND (NOT "requires_written_consent" OR "written_consent_set_at" IS NOT NULL)
  );

-- La marca alcanza a un procedimiento por su concepto: sin atadura no hay a
-- qué aplicarla.
ALTER TABLE "billable_service"
  ADD CONSTRAINT "billable_service_written_consent_needs_a_procedure" CHECK (
    NOT "requires_written_consent" OR "procedure_concept_id" IS NOT NULL
  );

-- La pregunta de EN-152, una sola vez para la base y para la pantalla. Toda
-- prestación cuenta, también la desactivada: la barrera se equivoca hacia
-- pedir el papel, nunca hacia saltárselo.
CREATE OR REPLACE FUNCTION procedure_requires_written_consent(p_concept_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM billable_service s
     WHERE s.procedure_concept_id = p_concept_id
       AND s.requires_written_consent
  );
$$;

-- ── 2. El 024 ───────────────────────────────────────────────────────────
CREATE TABLE "procedure_consent" (
  "id"                          UUID NOT NULL DEFAULT uuidv7(),
  "encounter_id"                UUID NOT NULL,
  "concept_id"                  UUID NOT NULL,
  -- No es clave foránea: el procedimiento quitado pasa a su archivo con el
  -- mismo id, y el restaurado es una fila nueva que lo hereda.
  "procedure_id"                UUID,
  "kind"                        VARCHAR(16) NOT NULL,
  "signer"                      VARCHAR(16),
  "representative_name"         VARCHAR(240),
  "representative_relationship" VARCHAR(32),
  "representative_document"     VARCHAR(20),
  "witness_name"                VARCHAR(240),
  "witness_document"            VARCHAR(20),
  "exception_kind"              VARCHAR(32),
  "exception_reason"            VARCHAR(1000),
  "informed_by_id"              UUID,
  "signed_at"                   TIMESTAMPTZ(6),
  "recorded_at"                 TIMESTAMPTZ(6) NOT NULL,
  "recorded_by_id"              UUID NOT NULL,

  CONSTRAINT "procedure_consent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "procedure_consent_kind_known"
    CHECK ("kind" IN ('SIGNED', 'EXCEPTION', 'REFUSED')),
  CONSTRAINT "procedure_consent_signer_known"
    CHECK ("signer" IS NULL OR "signer" IN ('PATIENT', 'REPRESENTATIVE', 'NONE')),
  CONSTRAINT "procedure_consent_exception_kind_known"
    CHECK ("exception_kind" IS NULL
           OR "exception_kind" IN ('EMERGENCY', 'UNEXPECTED_DURING_PROCEDURE')),
  -- El representante, con nombre y parentesco, sólo cuando firma él.
  CONSTRAINT "procedure_consent_representative_states_who" CHECK (
    ("signer" = 'REPRESENTATIVE') = (
      "representative_name" IS NOT NULL AND btrim("representative_name") <> ''
      AND "representative_relationship" IS NOT NULL
    )
    AND ("signer" = 'REPRESENTATIVE' OR "representative_document" IS NULL)
  ),
  -- EN-152. Firmado: atado a un procedimiento, quién firmó, quién informó y
  -- cuándo; nada de excepción ni testigo.
  CONSTRAINT "procedure_consent_signed_states_who" CHECK (
    "kind" <> 'SIGNED' OR (
      "procedure_id" IS NOT NULL
      AND "signer" IN ('PATIENT', 'REPRESENTATIVE')
      AND "informed_by_id" IS NOT NULL AND "signed_at" IS NOT NULL
      AND "exception_kind" IS NULL AND "exception_reason" IS NULL
      AND "witness_name" IS NULL AND "witness_document" IS NULL
    )
  ),
  -- EN-152, D-159.3. La excepción, con su fundamento escrito: nunca vacío.
  CONSTRAINT "procedure_consent_exception_states_why" CHECK (
    "kind" <> 'EXCEPTION' OR (
      "procedure_id" IS NOT NULL
      AND "exception_kind" IS NOT NULL
      AND "exception_reason" IS NOT NULL AND btrim("exception_reason") <> ''
      AND "signer" IS NULL AND "signed_at" IS NULL AND "informed_by_id" IS NULL
      AND "witness_name" IS NULL AND "witness_document" IS NULL
    )
  ),
  -- EN-153. La negativa: sin procedimiento, quién se negó y quién informó, y
  -- el testigo con su documento cuando no firma nadie.
  CONSTRAINT "procedure_consent_refusal_states_who" CHECK (
    "kind" <> 'REFUSED' OR (
      "procedure_id" IS NULL
      AND "signer" IS NOT NULL
      AND "informed_by_id" IS NOT NULL AND "signed_at" IS NOT NULL
      AND "exception_kind" IS NULL AND "exception_reason" IS NULL
      AND ("signer" = 'NONE') = (
        "witness_name" IS NOT NULL AND btrim("witness_name") <> ''
        AND "witness_document" IS NOT NULL AND btrim("witness_document") <> ''
      )
    )
  )
);

CREATE INDEX "procedure_consent_encounter_id_idx" ON "procedure_consent"("encounter_id");
CREATE INDEX "procedure_consent_procedure_id_idx" ON "procedure_consent"("procedure_id");
-- Un consentimiento por procedimiento y concepto.
CREATE UNIQUE INDEX "procedure_consent_one_per_procedure_and_concept"
  ON "procedure_consent"("procedure_id", "concept_id")
  WHERE "procedure_id" IS NOT NULL;

ALTER TABLE "procedure_consent"
  ADD CONSTRAINT "procedure_consent_encounter_id_fkey"
  FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "procedure_consent"
  ADD CONSTRAINT "procedure_consent_concept_id_fkey"
  FOREIGN KEY ("concept_id") REFERENCES "catalog_concept"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "procedure_consent"
  ADD CONSTRAINT "procedure_consent_informed_by_id_fkey"
  FOREIGN KEY ("informed_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "procedure_consent"
  ADD CONSTRAINT "procedure_consent_recorded_by_id_fkey"
  FOREIGN KEY ("recorded_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- El procedimiento que nombra es de esa atención y de ese concepto, y está
-- vivo cuando el papel se registra. La firma no es posterior a la
-- realización (EN-152).
CREATE OR REPLACE FUNCTION procedure_consent_admits()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  live encounter_procedure%ROWTYPE;
BEGIN
  IF NEW.procedure_id IS NOT NULL THEN
    SELECT * INTO live FROM encounter_procedure WHERE id = NEW.procedure_id;
    IF NOT FOUND
       OR live.encounter_id IS DISTINCT FROM NEW.encounter_id
       OR live.concept_id IS DISTINCT FROM NEW.concept_id THEN
      RAISE EXCEPTION
        'procedure_consent_names_its_procedure: a consent covers a live procedure of the same attention and concept'
        USING ERRCODE = 'integrity_constraint_violation',
              HINT = 'EN-152.';
    END IF;
    IF NEW.signed_at IS NOT NULL AND NEW.signed_at > live.performed_at THEN
      RAISE EXCEPTION
        'procedure_consent_signed_before_performed: the form 024 is signed before the procedure is performed'
        USING ERRCODE = 'integrity_constraint_violation',
              HINT = 'EN-152.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_procedure_consent_admits"
  BEFORE INSERT ON "procedure_consent"
  FOR EACH ROW
  EXECUTE FUNCTION procedure_consent_admits();

-- Nada del 024 se edita ni se borra: lo que dejó de valer es una revocación.
CREATE OR REPLACE FUNCTION procedure_consent_frozen()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'procedure_consent_frozen: a recorded consent, refusal or revocation never changes nor goes away'
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'EN-154.';
END;
$$;

CREATE TRIGGER "procedure_consent_frozen"
  BEFORE UPDATE OR DELETE ON "procedure_consent"
  FOR EACH ROW
  EXECUTE FUNCTION procedure_consent_frozen();

CREATE TRIGGER "procedure_consent_never_truncated"
  BEFORE TRUNCATE ON "procedure_consent"
  FOR EACH STATEMENT
  EXECUTE FUNCTION procedure_consent_frozen();

-- ¿Cubre algún 024 firmado, o una excepción, este procedimiento para este
-- concepto? El suyo, o el del procedimiento del que se restauró (EN-246),
-- siguiendo la cadena de restauraciones.
CREATE OR REPLACE FUNCTION procedure_written_consent_covers(p_procedure_id UUID, p_concept_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  WITH RECURSIVE lineage(id) AS (
    SELECT p_procedure_id
    UNION
    SELECT r.id
      FROM encounter_procedure_retraction r
      JOIN lineage l ON r.restored_as_id = l.id
  )
  SELECT EXISTS (
    SELECT 1
      FROM procedure_consent c
      JOIN lineage l ON c.procedure_id = l.id
     WHERE c.concept_id = p_concept_id
       AND c.kind IN ('SIGNED', 'EXCEPTION')
  );
$$;

-- EN-152. Al final de la transacción: el procedimiento cuyo concepto exige el
-- 024 lleva su consentimiento o su excepción. Mira el alta (también la
-- restauración, que es un alta) y el cambio de concepto; la marca puesta
-- después no invalida lo ya registrado.
CREATE OR REPLACE FUNCTION encounter_procedure_consent_required()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.concept_id = NEW.concept_id THEN
    RETURN NULL;
  END IF;
  -- La fila puede haberse quitado o cambiado otra vez en la misma
  -- transacción: se juzga lo que queda.
  IF NOT EXISTS (SELECT 1 FROM encounter_procedure p
                  WHERE p.id = NEW.id AND p.concept_id = NEW.concept_id) THEN
    RETURN NULL;
  END IF;
  IF procedure_requires_written_consent(NEW.concept_id)
     AND NOT procedure_written_consent_covers(NEW.id, NEW.concept_id) THEN
    RAISE EXCEPTION
      'encounter_procedure_consent_required: this procedure needs its signed form 024 or the written ground of an exception'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-152.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "encounter_procedure_consent_required"
  AFTER INSERT OR UPDATE OF "concept_id" ON "encounter_procedure"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION encounter_procedure_consent_required();

-- ── 4. La revocación ────────────────────────────────────────────────────
CREATE TABLE "procedure_consent_revocation" (
  "consent_id"                  UUID NOT NULL,
  "signer"                      VARCHAR(16) NOT NULL,
  "representative_name"         VARCHAR(240),
  "representative_relationship" VARCHAR(32),
  "representative_document"     VARCHAR(20),
  "revoked_at"                  TIMESTAMPTZ(6) NOT NULL,
  "revoked_by_id"               UUID NOT NULL,

  -- Una por consentimiento.
  CONSTRAINT "procedure_consent_revocation_pkey" PRIMARY KEY ("consent_id"),
  CONSTRAINT "procedure_consent_revocation_signer_known"
    CHECK ("signer" IN ('PATIENT', 'REPRESENTATIVE')),
  CONSTRAINT "procedure_consent_revocation_representative_states_who" CHECK (
    ("signer" = 'REPRESENTATIVE') = (
      "representative_name" IS NOT NULL AND btrim("representative_name") <> ''
      AND "representative_relationship" IS NOT NULL
    )
    AND ("signer" = 'REPRESENTATIVE' OR "representative_document" IS NULL)
  )
);

ALTER TABLE "procedure_consent_revocation"
  ADD CONSTRAINT "procedure_consent_revocation_consent_id_fkey"
  FOREIGN KEY ("consent_id") REFERENCES "procedure_consent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "procedure_consent_revocation"
  ADD CONSTRAINT "procedure_consent_revocation_revoked_by_id_fkey"
  FOREIGN KEY ("revoked_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Sólo se revoca lo firmado: una excepción o una negativa no son un permiso
-- que el paciente diera.
CREATE OR REPLACE FUNCTION procedure_consent_revocation_admits()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM procedure_consent c
                  WHERE c.id = NEW.consent_id AND c.kind = 'SIGNED') THEN
    RAISE EXCEPTION
      'procedure_consent_revocation_of_signed: only a signed consent is revoked'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-154.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_procedure_consent_revocation_admits"
  BEFORE INSERT ON "procedure_consent_revocation"
  FOR EACH ROW
  EXECUTE FUNCTION procedure_consent_revocation_admits();

CREATE TRIGGER "procedure_consent_revocation_frozen"
  BEFORE UPDATE OR DELETE ON "procedure_consent_revocation"
  FOR EACH ROW
  EXECUTE FUNCTION procedure_consent_frozen();

CREATE TRIGGER "procedure_consent_revocation_never_truncated"
  BEFORE TRUNCATE ON "procedure_consent_revocation"
  FOR EACH STATEMENT
  EXECUTE FUNCTION procedure_consent_frozen();
