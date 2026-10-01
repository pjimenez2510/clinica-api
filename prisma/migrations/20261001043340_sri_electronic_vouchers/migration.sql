-- ═══════════════════════════════════════════════════════════════════════════
-- THE ELECTRONIC VOUCHER: what turns an ISSUED invoice into a document the SRI
-- authorises (sri/SPEC.md S1–S3, ADR-004).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Five things the schema did not have and the SRI needs:
--
--   1. The SRI's establishment code of each site and the address of the head
--      office (OR-027, OR-028). Without them there is no access key and no
--      `infoTributaria`.
--   2. Which invoice took each charge (BI-169). Deducing the lines from the
--      account gives the second invoice of an account the lines of the first,
--      which is the SRI's error 52.
--   3. `electronic_voucher`: ONE per invoice, forever, with an access key that
--      never changes (SRI-005, SRI-006). Errors 43 and 70 mean «already sent»,
--      and regenerating the key on a retry is what turns a rejection into a
--      permanent one.
--   4. `electronic_voucher_attempt`: every call to the SRI and what it said.
--      Append-only.
--   5. `signing_certificate` and `signing_certificate_opening`: the issuer's
--      .p12, ENCRYPTED, and a row for every time it was opened (REQ-090).

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The issuer's data the SRI asks for
-- ───────────────────────────────────────────────────────────────────────────

-- OR-027, SRI-009. Three digits, and the leading zero is significant. It is the
-- `estab` of the access key — NOT `msp_unicode`, which is another register.
ALTER TABLE "site" ADD COLUMN "sri_establishment_code" CHAR(3);
ALTER TABLE "site"
  ADD CONSTRAINT "site_sri_establishment_code_format"
  CHECK ("sri_establishment_code" IS NULL OR "sri_establishment_code" ~ '^[0-9]{3}$');

-- OR-028, SRI-018. `dirMatriz` is mandatory in the voucher and is not
-- necessarily the address of any site that sees patients.
ALTER TABLE "establishment" ADD COLUMN "head_office_address" VARCHAR(300);
ALTER TABLE "establishment"
  ADD CONSTRAINT "establishment_head_office_address_not_blank"
  CHECK ("head_office_address" IS NULL OR btrim("head_office_address") <> '');

-- ───────────────────────────────────────────────────────────────────────────
-- 2. BI-169 — every billed charge names its invoice
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE "charge_item" ADD COLUMN "invoice_id" UUID;
ALTER TABLE "charge_item"
  ADD CONSTRAINT "charge_item_invoice_fk"
  FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Rows billed before this column existed: the first invoice of the account
-- issued at or after the charge was raised, which is the one that took it. Only
-- development databases hold such rows (database-phase: development).
UPDATE "charge_item" AS c
   SET "invoice_id" = COALESCE(
     (SELECT i."id" FROM "invoice" i
       WHERE i."account_id" = c."account_id" AND i."issued_at" >= c."created_at"
       ORDER BY i."issued_at" ASC LIMIT 1),
     (SELECT i."id" FROM "invoice" i
       WHERE i."account_id" = c."account_id"
       ORDER BY i."issued_at" ASC LIMIT 1))
 WHERE c."status" = 'BILLED';

-- BILLED if and only if it names the invoice that billed it. B3 (void) returns
-- the charges to BILLABLE and clears the column in the same statement.
ALTER TABLE "charge_item"
  ADD CONSTRAINT "charge_item_billed_carries_its_invoice"
  CHECK (("status" = 'BILLED') = ("invoice_id" IS NOT NULL));

CREATE INDEX "charge_item_by_invoice" ON "charge_item" ("invoice_id")
  WHERE "invoice_id" IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. The issuer's signing certificate (REQ-090, SRI-022 to SRI-034)
-- ───────────────────────────────────────────────────────────────────────────
--
-- The .p12 and its password are stored ONLY as AES-256-GCM envelopes
-- (iv ‖ tag ‖ ciphertext) under a key derived by scrypt from a master
-- passphrase that lives in a file outside the database (SRI-024). The salt is
-- per certificate. What is in clear is what anybody may know about a
-- certificate: whose it is, who issued it and until when it is valid.

CREATE TABLE "signing_certificate" (
  "id" UUID NOT NULL DEFAULT uuidv7(),

  "subject"       VARCHAR(500) NOT NULL,
  "issuer"        VARCHAR(500) NOT NULL,
  "serial_number" VARCHAR(128) NOT NULL,
  "not_before"    TIMESTAMPTZ(6) NOT NULL,
  "not_after"     TIMESTAMPTZ(6) NOT NULL,

  "encrypted_pkcs12"   BYTEA NOT NULL,
  "encrypted_password" BYTEA NOT NULL,
  "kdf_salt"           BYTEA NOT NULL,

  "active"         BOOLEAN NOT NULL DEFAULT true,
  "deactivated_at" TIMESTAMPTZ(6),

  "uploaded_by_id" UUID NOT NULL,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "signing_certificate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "signing_certificate_uploaded_by_fk"
    FOREIGN KEY ("uploaded_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT,
  CONSTRAINT "signing_certificate_validity_is_ordered"
    CHECK ("not_after" > "not_before"),
  -- iv (12) + tag (16) + at least one byte. A shorter value is not an
  -- envelope, and a clear-text .p12 would be much longer but start with 0x30:
  -- the length check is the floor, the format is the adapter's job.
  CONSTRAINT "signing_certificate_envelopes_have_a_shape"
    CHECK (octet_length("encrypted_pkcs12") > 28
       AND octet_length("encrypted_password") > 28
       AND octet_length("kdf_salt") >= 16),
  CONSTRAINT "signing_certificate_deactivation_is_coherent"
    CHECK ("active" = ("deactivated_at" IS NULL))
);

-- SRI-027. One active certificate per installation.
CREATE UNIQUE INDEX "signing_certificate_one_active"
  ON "signing_certificate" ((true)) WHERE "active";

-- SRI-034. A replaced certificate is kept: archived signatures are verified
-- with the certificate that made them. The only change admitted is going
-- inactive, once.
CREATE OR REPLACE FUNCTION trg_signing_certificate_is_kept()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'signing_certificate_is_never_deleted'
      USING HINT = 'Un certificado sustituido se conserva inactivo.';
  END IF;

  IF NEW."subject"            IS DISTINCT FROM OLD."subject"
  OR NEW."issuer"             IS DISTINCT FROM OLD."issuer"
  OR NEW."serial_number"      IS DISTINCT FROM OLD."serial_number"
  OR NEW."not_before"         IS DISTINCT FROM OLD."not_before"
  OR NEW."not_after"          IS DISTINCT FROM OLD."not_after"
  OR NEW."encrypted_pkcs12"   IS DISTINCT FROM OLD."encrypted_pkcs12"
  OR NEW."encrypted_password" IS DISTINCT FROM OLD."encrypted_password"
  OR NEW."kdf_salt"           IS DISTINCT FROM OLD."kdf_salt"
  OR NEW."uploaded_by_id"     IS DISTINCT FROM OLD."uploaded_by_id"
  OR NEW."created_at"         IS DISTINCT FROM OLD."created_at"
  OR (NOT OLD."active" AND NEW."active")
  THEN
    RAISE EXCEPTION 'signing_certificate_is_immutable'
      USING HINT = 'Un certificado no se modifica: se carga otro.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_signing_certificate_kept
  BEFORE UPDATE OR DELETE ON "signing_certificate"
  FOR EACH ROW EXECUTE FUNCTION trg_signing_certificate_is_kept();

-- ───────────────────────────────────────────────────────────────────────────
-- 4. The voucher (SRI-001 to SRI-008, SRI-031, SRI-047)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE "electronic_voucher" (
  "id" UUID NOT NULL DEFAULT uuidv7(),

  "invoice_id" UUID NOT NULL,
  "site_id"    UUID NOT NULL,

  -- SRI table 3. Only the invoice is built today.
  "document_type" CHAR(2) NOT NULL DEFAULT '01',

  -- SRI-001 to SRI-003. The key, and the two parts of it chosen here.
  "access_key"     VARCHAR(49) NOT NULL,
  "numeric_code"   CHAR(8) NOT NULL,
  "environment"    CHAR(1) NOT NULL,
  "schema_version" VARCHAR(8) NOT NULL,

  -- PREPARED (key and XML, not signed), SIGNED, RECEIVED, AUTHORISED,
  -- RETURNED (DEVUELTA other than 43/70) or NOT_AUTHORISED.
  "status" VARCHAR(16) NOT NULL DEFAULT 'PREPARED',
  -- Why a PREPARED voucher is not moving: a local reason, never the SRI's.
  "blocked_reason" VARCHAR(48),

  "unsigned_xml" TEXT NOT NULL,
  -- SRI-031. Stored exactly as signed and sent byte for byte on every attempt.
  "signed_xml"             TEXT,
  "signing_certificate_id" UUID,
  "signed_at"              TIMESTAMPTZ(6),

  -- The SRI's last word, for the monitor (SRI-061). The full trail is in
  -- `electronic_voucher_attempt`.
  "last_messages" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "attempt_count"   INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(6),

  -- SRI-047, SRI-073.
  "authorisation_number" VARCHAR(49),
  "authorised_at"        TIMESTAMPTZ(6),
  "authorised_xml"       TEXT,

  -- SRI-072 to SRI-076. NULL until there is something to deliver.
  "delivery_status" VARCHAR(16),
  "delivered_at"    TIMESTAMPTZ(6),

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "electronic_voucher_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "electronic_voucher_invoice_fk"
    FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT,
  CONSTRAINT "electronic_voucher_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT,
  CONSTRAINT "electronic_voucher_certificate_fk"
    FOREIGN KEY ("signing_certificate_id") REFERENCES "signing_certificate"("id") ON DELETE RESTRICT,

  -- SRI-006.
  CONSTRAINT "electronic_voucher_one_per_invoice" UNIQUE ("invoice_id"),
  CONSTRAINT "electronic_voucher_access_key_unique" UNIQUE ("access_key"),
  -- Targets of the composite keys below: the invoice and the attempts can only
  -- name THIS voucher's key.
  CONSTRAINT "electronic_voucher_invoice_key_pair" UNIQUE ("invoice_id", "access_key"),
  CONSTRAINT "electronic_voucher_id_key_pair" UNIQUE ("id", "access_key"),

  CONSTRAINT "electronic_voucher_document_type_is_known"
    CHECK ("document_type" IN ('01')),
  CONSTRAINT "electronic_voucher_access_key_format"
    CHECK ("access_key" ~ '^[0-9]{49}$'),
  CONSTRAINT "electronic_voucher_numeric_code_format"
    CHECK ("numeric_code" ~ '^[0-9]{8}$'),
  CONSTRAINT "electronic_voucher_environment_is_known"
    CHECK ("environment" IN ('1', '2')),
  -- The key IS its parts: positions 9–10 type, 24 environment, 40–47 numeric
  -- code, 48 emission type (always 1, offline).
  CONSTRAINT "electronic_voucher_key_matches_its_parts"
    CHECK (substr("access_key", 9, 2) = "document_type"
       AND substr("access_key", 24, 1) = "environment"
       AND substr("access_key", 40, 8) = "numeric_code"
       AND substr("access_key", 48, 1) = '1'),
  CONSTRAINT "electronic_voucher_status_is_known"
    CHECK ("status" IN ('PREPARED', 'SIGNED', 'RECEIVED', 'AUTHORISED', 'RETURNED', 'NOT_AUTHORISED')),
  -- Past PREPARED, a voucher has been signed.
  CONSTRAINT "electronic_voucher_signed_beyond_prepared"
    CHECK ("status" = 'PREPARED'
       OR ("signed_xml" IS NOT NULL AND "signing_certificate_id" IS NOT NULL AND "signed_at" IS NOT NULL)),
  CONSTRAINT "electronic_voucher_blocked_only_when_prepared"
    CHECK ("blocked_reason" IS NULL OR "status" = 'PREPARED'),
  CONSTRAINT "electronic_voucher_authorised_carries_its_proof"
    CHECK (("status" = 'AUTHORISED') =
           ("authorisation_number" IS NOT NULL AND "authorised_at" IS NOT NULL AND "authorised_xml" IS NOT NULL)),
  CONSTRAINT "electronic_voucher_attempts_are_counted"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "electronic_voucher_delivery_status_is_known"
    CHECK ("delivery_status" IS NULL OR "delivery_status" IN ('PENDING', 'SENT', 'NO_EMAIL', 'FAILED')),
  CONSTRAINT "electronic_voucher_delivery_only_once_authorised"
    CHECK ("delivery_status" IS NULL OR "status" = 'AUTHORISED'),
  CONSTRAINT "electronic_voucher_messages_are_a_list"
    CHECK (jsonb_typeof("last_messages") = 'array')
);

CREATE INDEX "electronic_voucher_by_site_status"
  ON "electronic_voucher" ("site_id", "status");

-- SRI-005, SRI-006, SRI-047. The key and what it is made of never move; an
-- authorised voucher never moves except to record that its e-mail left; and
-- nothing is ever deleted.
CREATE OR REPLACE FUNCTION trg_electronic_voucher_is_permanent()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'electronic_voucher_is_never_deleted'
      USING HINT = 'Un comprobante electronico no se elimina.';
  END IF;

  IF NEW."access_key"     IS DISTINCT FROM OLD."access_key"
  OR NEW."numeric_code"   IS DISTINCT FROM OLD."numeric_code"
  OR NEW."environment"    IS DISTINCT FROM OLD."environment"
  OR NEW."document_type"  IS DISTINCT FROM OLD."document_type"
  OR NEW."invoice_id"     IS DISTINCT FROM OLD."invoice_id"
  OR NEW."site_id"        IS DISTINCT FROM OLD."site_id"
  THEN
    RAISE EXCEPTION 'electronic_voucher_access_key_is_permanent'
      USING HINT = 'La clave de acceso no se regenera: los errores 43 y 70 significan ya enviado.';
  END IF;

  IF OLD."status" = 'AUTHORISED' AND (
       NEW."status"               IS DISTINCT FROM OLD."status"
    OR NEW."signed_xml"           IS DISTINCT FROM OLD."signed_xml"
    OR NEW."unsigned_xml"         IS DISTINCT FROM OLD."unsigned_xml"
    OR NEW."authorisation_number" IS DISTINCT FROM OLD."authorisation_number"
    OR NEW."authorised_at"        IS DISTINCT FROM OLD."authorised_at"
    OR NEW."authorised_xml"       IS DISTINCT FROM OLD."authorised_xml")
  THEN
    RAISE EXCEPTION 'electronic_voucher_authorised_is_immutable'
      USING HINT = 'Un comprobante autorizado por el SRI no se modifica.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_electronic_voucher_permanent
  BEFORE UPDATE OR DELETE ON "electronic_voucher"
  FOR EACH ROW EXECUTE FUNCTION trg_electronic_voucher_is_permanent();

-- SRI-007. The invoice can only carry the key of ITS voucher: a composite key
-- onto (invoice_id, access_key). NULL — an invoice whose voucher is not yet
-- prepared — is allowed by MATCH SIMPLE.
--
-- Rows written before this migration with a hand-made key (development only)
-- would block the constraint; they are cleared, since no voucher backs them.
UPDATE "invoice" SET "access_key" = NULL
 WHERE "access_key" IS NOT NULL AND "status" NOT IN ('AUTHORISED', 'VOIDED');

ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_access_key_is_its_vouchers"
  FOREIGN KEY ("id", "access_key")
  REFERENCES "electronic_voucher"("invoice_id", "access_key")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- SRI-005. Once written, the invoice's key does not change, whatever its
-- status. `trg_invoice_immutable` only freezes it from AUTHORISED on.
CREATE OR REPLACE FUNCTION trg_invoice_access_key_is_permanent()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."access_key" IS NOT NULL
     AND NEW."access_key" IS DISTINCT FROM OLD."access_key" THEN
    RAISE EXCEPTION 'invoice_access_key_is_permanent'
      USING HINT = 'La clave de acceso no se regenera: los errores 43 y 70 significan ya enviado.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_invoice_access_key_permanent
  BEFORE UPDATE OF "access_key" ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION trg_invoice_access_key_is_permanent();

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Every call to the SRI (SRI-051, SC-071)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE "electronic_voucher_attempt" (
  "id" UUID NOT NULL DEFAULT uuidv7(),

  "voucher_id" UUID NOT NULL,
  -- SC-071, made impossible to break: the composite key below only accepts
  -- THIS voucher's key.
  "access_key" VARCHAR(49) NOT NULL,

  "operation" VARCHAR(16) NOT NULL,
  "started_at"  TIMESTAMPTZ(6) NOT NULL,
  "duration_ms" INTEGER NOT NULL,
  -- What the SRI answered, or that it did not.
  "outcome"  VARCHAR(24) NOT NULL,
  "messages" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "transport_error" VARCHAR(500),

  CONSTRAINT "electronic_voucher_attempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "electronic_voucher_attempt_voucher_fk"
    FOREIGN KEY ("voucher_id", "access_key")
    REFERENCES "electronic_voucher"("id", "access_key") ON DELETE RESTRICT,
  CONSTRAINT "electronic_voucher_attempt_operation_is_known"
    CHECK ("operation" IN ('RECEPTION', 'AUTHORISATION')),
  CONSTRAINT "electronic_voucher_attempt_outcome_is_known"
    CHECK ("outcome" IN ('RECIBIDA', 'DEVUELTA', 'AUTORIZADO', 'NO AUTORIZADO', 'PENDING', 'TRANSPORT_FAILURE')),
  CONSTRAINT "electronic_voucher_attempt_transport_failure_says_why"
    CHECK (("outcome" = 'TRANSPORT_FAILURE') = ("transport_error" IS NOT NULL)),
  CONSTRAINT "electronic_voucher_attempt_duration_is_not_negative"
    CHECK ("duration_ms" >= 0),
  CONSTRAINT "electronic_voucher_attempt_messages_are_a_list"
    CHECK (jsonb_typeof("messages") = 'array')
);

CREATE INDEX "electronic_voucher_attempt_by_voucher"
  ON "electronic_voucher_attempt" ("voucher_id", "started_at");

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Every time the certificate was opened (SRI-026)
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE "signing_certificate_opening" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "certificate_id" UUID NOT NULL,
  "voucher_id"     UUID NOT NULL,
  "opened_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "signing_certificate_opening_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "signing_certificate_opening_certificate_fk"
    FOREIGN KEY ("certificate_id") REFERENCES "signing_certificate"("id") ON DELETE RESTRICT,
  CONSTRAINT "signing_certificate_opening_voucher_fk"
    FOREIGN KEY ("voucher_id") REFERENCES "electronic_voucher"("id") ON DELETE RESTRICT
);

CREATE INDEX "signing_certificate_opening_by_certificate"
  ON "signing_certificate_opening" ("certificate_id", "opened_at");

-- Both trails are append-only.
CREATE OR REPLACE FUNCTION trg_sri_trail_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '%_is_append_only', TG_TABLE_NAME
    USING HINT = 'El rastro del SRI y de la firma solo se añade.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_electronic_voucher_attempt_append_only
  BEFORE UPDATE OR DELETE ON "electronic_voucher_attempt"
  FOR EACH ROW EXECUTE FUNCTION trg_sri_trail_is_append_only();

CREATE TRIGGER trg_signing_certificate_opening_append_only
  BEFORE UPDATE OR DELETE ON "signing_certificate_opening"
  FOR EACH ROW EXECUTE FUNCTION trg_sri_trail_is_append_only();
