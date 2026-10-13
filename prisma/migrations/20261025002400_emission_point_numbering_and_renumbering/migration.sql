-- emission_point_numbering_and_renumbering
--
-- Escrito a mano (scripts/new-migration.mts). feat/f06-secuencial-punto-emision,
-- D-262: la factura 19 del autor volvió del SRI con el error 45 («secuencial
-- registrado») porque el SRI ya tenía una 19 de ese RUC, establecimiento y
-- punto, y la base no tenía cómo saber dónde iba la numeración.
--
-- 1. BI-306, BI-307. El «próximo número» de cada punto de emisión y tipo de
--    comprobante (`01` factura, `04` nota de crédito), con el último número
--    del sistema anterior, el motivo y quién. Nunca por debajo del mayor
--    usado: lo comprueba un disparador bajo el bloqueo de fila del punto, el
--    mismo con que se numera. La fila anterior va a `record_version`.
--
-- 2. BI-308. `next_voucher_sequential`: UNA función numera la factura, la nota
--    de crédito y la renumeración, con el mayor entre lo usado más uno y el
--    próximo número fijado.
--
-- 3. SRI-109, SRI-111. `voucher_renumbering`, de sólo inserción: el
--    comprobante devuelto con el 45, su número y su clave, y el número nuevo.
--    Es lo único que deja cambiar el número o la clave de una factura o de una
--    nota de crédito, y dejar un comprobante `SUPERSEDED` y sin documento.
--
-- 4. SRI-111. Hasta hoy el secuencial de una factura no autorizada podía
--    cambiarse por SQL: sólo la autorizada lo congelaba
--    (`trg_invoice_immutable`). Ahora el número y la clave se mueven sólo con
--    su fila de renumeración, en cualquier estado.
BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. El «próximo número» (BI-306, BI-307)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "emission_point_numbering" (
  "id"                   UUID NOT NULL DEFAULT uuidv7(),
  "emission_point_id"    UUID NOT NULL,
  -- `01` factura, `04` nota de crédito: el SRI las numera por separado.
  "document_type"        CHAR(2) NOT NULL,
  "next_sequential"      INTEGER,
  "previous_system_last" INTEGER,
  "reason"               VARCHAR(300) NOT NULL,
  "changed_by"           UUID NOT NULL,
  "changed_at"           TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "emission_point_numbering_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emission_point_numbering_emission_point_fk"
    FOREIGN KEY ("emission_point_id") REFERENCES "emission_point"("id") ON DELETE RESTRICT,
  CONSTRAINT "emission_point_numbering_changed_by_fk"
    FOREIGN KEY ("changed_by") REFERENCES "app_user"("id") ON DELETE RESTRICT,
  CONSTRAINT "emission_point_numbering_one_per_type"
    UNIQUE ("emission_point_id", "document_type"),
  CONSTRAINT "emission_point_numbering_type_is_known"
    CHECK ("document_type" IS NOT NULL AND "document_type" IN ('01', '04')),
  CONSTRAINT "emission_point_numbering_next_in_range"
    CHECK ("next_sequential" IS NULL OR "next_sequential" BETWEEN 1 AND 999999999),
  CONSTRAINT "emission_point_numbering_previous_in_range"
    CHECK ("previous_system_last" IS NULL OR "previous_system_last" BETWEEN 1 AND 999999999),
  CONSTRAINT "emission_point_numbering_reason_given"
    CHECK (length(btrim("reason")) > 0)
);

-- The largest sequential already used in a point for a type. Plain SQL over
-- both tables, read in the CALLER's statement: every caller takes the
-- emission point's row lock first, so what it reads cannot move under it.
CREATE OR REPLACE FUNCTION emission_point_used_sequential(p_point UUID, p_type CHAR(2))
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  used INTEGER;
BEGIN
  IF p_type = '01' THEN
    SELECT coalesce(max("sequential"::INTEGER), 0) INTO used
      FROM "invoice" WHERE "emission_point_id" = p_point;
  ELSIF p_type = '04' THEN
    SELECT coalesce(max("sequential"::INTEGER), 0) INTO used
      FROM "credit_note" WHERE "emission_point_id" = p_point;
  ELSE
    RAISE EXCEPTION 'emission_point_numbering_type_is_known: % is not a voucher type', p_type
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'emission_point_numbering_type_is_known';
  END IF;
  RETURN used;
END;
$$;

-- BI-307. Under the emission point's lock, so an issuance that slips in
-- between reading the maximum and writing the number waits for it.
CREATE OR REPLACE FUNCTION emission_point_numbering_not_below_used()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  used INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'emission_point_numbering_is_kept: a numbering is changed, never deleted'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'emission_point_numbering_is_kept',
            HINT = 'La numeración de un punto se cambia; no se borra.';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."emission_point_id", NEW."document_type")
                          IS DISTINCT FROM (OLD."emission_point_id", OLD."document_type") THEN
    RAISE EXCEPTION 'emission_point_numbering_is_kept: the point and type of a numbering do not change'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'emission_point_numbering_is_kept';
  END IF;

  PERFORM 1 FROM "emission_point" WHERE "id" = NEW."emission_point_id" FOR UPDATE;
  used := emission_point_used_sequential(NEW."emission_point_id", NEW."document_type");
  -- Only a floor that is being SET: one fixed long ago and since overtaken
  -- by the issuances stays as it is, and does not stop changing the rest of
  -- the row (the previous system's last number, the reason).
  IF NEW."next_sequential" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."next_sequential" IS DISTINCT FROM OLD."next_sequential")
     AND NEW."next_sequential" <= used THEN
    RAISE EXCEPTION 'emission_point_numbering_not_below_used: % is not above %', NEW."next_sequential", used
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'emission_point_numbering_not_below_used',
            HINT = 'El próximo número no puede quedar por debajo del mayor ya usado.';
  END IF;
  RETURN NEW;
END;
$$;

-- Fired before the archive (alphabetical order of BEFORE triggers): what is
-- refused does not leave a version behind.
CREATE TRIGGER "trg_emission_point_numbering_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "emission_point_numbering"
  FOR EACH ROW EXECUTE FUNCTION emission_point_numbering_not_below_used();

CREATE TRIGGER "trg_emission_point_numbering_record_version"
  BEFORE UPDATE ON "emission_point_numbering"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_archive('changed_by', 'changed_at', 'id');

-- The text maximum is the numeric maximum only while every sequential has its
-- nine digits; an unpadded «20» would sort above «000000100» and be numbered
-- again. The width is the SRI's, and now the database's (BI-085).
ALTER TABLE "invoice"
  ADD CONSTRAINT "invoice_sequential_has_nine_digits"
    CHECK ("sequential" ~ '^[0-9]{9}$');
ALTER TABLE "credit_note"
  ADD CONSTRAINT "credit_note_sequential_has_nine_digits"
    CHECK ("sequential" ~ '^[0-9]{9}$');

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Una función numera todo (BI-308)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION next_voucher_sequential(p_point UUID, p_type CHAR(2))
RETURNS VARCHAR(9)
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  used  INTEGER;
  fixed INTEGER;
  next  INTEGER;
BEGIN
  PERFORM 1 FROM "emission_point" WHERE "id" = p_point FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'next_voucher_sequential: emission point % does not exist', p_point
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  used := emission_point_used_sequential(p_point, p_type);
  SELECT "next_sequential" INTO fixed
    FROM "emission_point_numbering"
   WHERE "emission_point_id" = p_point AND "document_type" = p_type;

  next := greatest(used + 1, coalesce(fixed, 0));
  IF next > 999999999 THEN
    -- Reaching it means the clinic opens a new point; truncating would
    -- collide with the number issued a billion documents ago.
    RAISE EXCEPTION 'emission_point_sequential_exhausted'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'emission_point_sequential_exhausted';
  END IF;
  RETURN lpad(next::TEXT, 9, '0');
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. La renumeración (SRI-109, SRI-111)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "voucher_renumbering" (
  "id"                    UUID NOT NULL DEFAULT uuidv7(),
  -- The voucher the SRI returned with the 45. Its key is the one it carried:
  -- the pair is a foreign key, so neither can be invented.
  "superseded_voucher_id" UUID NOT NULL,
  "previous_access_key"   VARCHAR(49) NOT NULL,
  "invoice_id"            UUID,
  "credit_note_id"        UUID,
  "emission_point_id"     UUID NOT NULL,
  "previous_sequential"   VARCHAR(9) NOT NULL,
  "new_sequential"        VARCHAR(9) NOT NULL,
  -- What the SRI said, as it said it: the reason the number is a hole.
  "sri_message"           VARCHAR(1000) NOT NULL,
  "renumbered_by"         UUID NOT NULL,
  "renumbered_at"         TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "voucher_renumbering_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "voucher_renumbering_voucher_fk"
    FOREIGN KEY ("superseded_voucher_id", "previous_access_key")
    REFERENCES "electronic_voucher"("id", "access_key") ON DELETE RESTRICT,
  CONSTRAINT "voucher_renumbering_invoice_fk"
    FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT,
  CONSTRAINT "voucher_renumbering_credit_note_fk"
    FOREIGN KEY ("credit_note_id") REFERENCES "credit_note"("id") ON DELETE RESTRICT,
  CONSTRAINT "voucher_renumbering_emission_point_fk"
    FOREIGN KEY ("emission_point_id") REFERENCES "emission_point"("id") ON DELETE RESTRICT,
  CONSTRAINT "voucher_renumbering_renumbered_by_fk"
    FOREIGN KEY ("renumbered_by") REFERENCES "app_user"("id") ON DELETE RESTRICT,
  -- A voucher is replaced once: the next 45 is the NEW voucher's.
  CONSTRAINT "voucher_renumbering_once_per_voucher" UNIQUE ("superseded_voucher_id"),
  CONSTRAINT "voucher_renumbering_one_document"
    CHECK (num_nonnulls("invoice_id", "credit_note_id") = 1),
  -- The new number is always the next free one, so it is above the old.
  CONSTRAINT "voucher_renumbering_number_moves_up"
    CHECK ("new_sequential" > "previous_sequential"),
  CONSTRAINT "voucher_renumbering_sequentials_have_nine_digits"
    CHECK ("previous_sequential" ~ '^[0-9]{9}$' AND "new_sequential" ~ '^[0-9]{9}$'),
  CONSTRAINT "voucher_renumbering_message_given"
    CHECK (length(btrim("sri_message")) > 0)
);

CREATE INDEX "voucher_renumbering_by_invoice"
  ON "voucher_renumbering" ("invoice_id") WHERE "invoice_id" IS NOT NULL;
CREATE INDEX "voucher_renumbering_by_credit_note"
  ON "voucher_renumbering" ("credit_note_id") WHERE "credit_note_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION voucher_renumbering_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'voucher_renumbering_append_only: a renumbering is never changed or deleted'
    USING ERRCODE = 'check_violation',
          CONSTRAINT = 'voucher_renumbering_append_only',
          HINT = 'El rastro de una renumeración no se modifica.';
END;
$$;

CREATE TRIGGER "trg_voucher_renumbering_append_only"
  BEFORE UPDATE OR DELETE ON "voucher_renumbering"
  FOR EACH ROW EXECUTE FUNCTION voucher_renumbering_append_only();

-- SRI-111. A renumbering is only written for what the application would
-- renumber: the voucher RETURNED and never authorised, of the document it
-- names; the document REJECTED and still carrying the old number on that
-- point; and the new number not below the next free one (the floor of
-- `next_voucher_sequential`). Whether the SRI's answer was the 45 is the
-- application's to read — the database keeps the rest, so a hand-written row
-- cannot move a number into a hole the SRI already holds.
CREATE OR REPLACE FUNCTION voucher_renumbering_is_due()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  voucher RECORD;
  document RECORD;
  voucher_type CHAR(2);
  floor INTEGER;
BEGIN
  SELECT "status", "authorisation_number", "invoice_id", "credit_note_id"
    INTO voucher
    FROM "electronic_voucher" WHERE "id" = NEW."superseded_voucher_id" FOR UPDATE;
  IF NOT FOUND
     OR voucher."status" <> 'RETURNED'
     OR voucher."authorisation_number" IS NOT NULL
     OR voucher."invoice_id" IS DISTINCT FROM NEW."invoice_id"
     OR voucher."credit_note_id" IS DISTINCT FROM NEW."credit_note_id" THEN
    RAISE EXCEPTION 'voucher_renumbering_is_due: only a returned, never authorised voucher of that document is renumbered'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'voucher_renumbering_is_due';
  END IF;

  IF NEW."invoice_id" IS NOT NULL THEN
    voucher_type := '01';
    SELECT "status", "sequential", "emission_point_id" INTO document
      FROM "invoice" WHERE "id" = NEW."invoice_id" FOR UPDATE;
  ELSE
    voucher_type := '04';
    SELECT "status", "sequential", "emission_point_id" INTO document
      FROM "credit_note" WHERE "id" = NEW."credit_note_id" FOR UPDATE;
  END IF;
  IF document."status" <> 'REJECTED'
     OR document."sequential" <> NEW."previous_sequential"
     OR document."emission_point_id" <> NEW."emission_point_id" THEN
    RAISE EXCEPTION 'voucher_renumbering_is_due: the document is not returned with that number on that point'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'voucher_renumbering_is_due';
  END IF;

  PERFORM 1 FROM "emission_point" WHERE "id" = NEW."emission_point_id" FOR UPDATE;
  SELECT greatest(
           emission_point_used_sequential(NEW."emission_point_id", voucher_type) + 1,
           coalesce((SELECT "next_sequential" FROM "emission_point_numbering"
                      WHERE "emission_point_id" = NEW."emission_point_id"
                        AND "document_type" = voucher_type), 0))
    INTO floor;
  IF NEW."new_sequential"::INTEGER < floor THEN
    RAISE EXCEPTION 'voucher_renumbering_is_due: % is below the next free number %', NEW."new_sequential", floor
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'voucher_renumbering_is_due';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_voucher_renumbering_is_due"
  BEFORE INSERT ON "voucher_renumbering"
  FOR EACH ROW EXECUTE FUNCTION voucher_renumbering_is_due();

-- ── 3.1 El comprobante reemplazado ─────────────────────────────────────────

ALTER TABLE "electronic_voucher"
  DROP CONSTRAINT "electronic_voucher_status_is_known",
  ADD CONSTRAINT "electronic_voucher_status_is_known"
    CHECK ("status" IN ('PREPARED', 'SIGNED', 'RECEIVED', 'AUTHORISED', 'RETURNED',
                        'NOT_AUTHORISED', 'SUPERSEDED')),
  -- A SUPERSEDED voucher names no document: its invoice or credit note has a
  -- new voucher now, and `voucher_renumbering` says whose it was.
  DROP CONSTRAINT "electronic_voucher_one_document",
  ADD CONSTRAINT "electronic_voucher_one_document"
    CHECK (CASE WHEN "status" = 'SUPERSEDED'
                THEN num_nonnulls("invoice_id", "credit_note_id") = 0
                ELSE num_nonnulls("invoice_id", "credit_note_id") = 1 END),
  DROP CONSTRAINT "electronic_voucher_type_matches_its_document",
  ADD CONSTRAINT "electronic_voucher_type_matches_its_document"
    CHECK ("status" = 'SUPERSEDED'
           OR (("document_type" = '01') = ("invoice_id" IS NOT NULL)));

-- SRI-111. SUPERSEDED is reached, never written at birth.
CREATE OR REPLACE FUNCTION electronic_voucher_not_born_superseded()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'electronic_voucher_superseded_only_renumbered: a voucher is not created replaced'
    USING ERRCODE = 'check_violation',
          CONSTRAINT = 'electronic_voucher_superseded_only_renumbered';
END;
$$;

CREATE TRIGGER "trg_electronic_voucher_not_born_superseded"
  BEFORE INSERT ON "electronic_voucher"
  FOR EACH ROW WHEN (NEW."status" = 'SUPERSEDED')
  EXECUTE FUNCTION electronic_voucher_not_born_superseded();

CREATE OR REPLACE FUNCTION trg_electronic_voucher_is_permanent()
RETURNS TRIGGER AS $$
DECLARE
  superseded_now BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'electronic_voucher_is_never_deleted'
      USING HINT = 'Un comprobante electronico no se elimina.';
  END IF;

  -- SRI-111. Replaced only from RETURNED, never authorised, and only with the
  -- renumbering that names it.
  superseded_now := NEW."status" = 'SUPERSEDED' AND OLD."status" IS DISTINCT FROM 'SUPERSEDED';
  IF superseded_now AND NOT (
       OLD."status" = 'RETURNED'
       AND OLD."authorisation_number" IS NULL
       AND NEW."invoice_id" IS NULL AND NEW."credit_note_id" IS NULL
       AND EXISTS (SELECT 1 FROM "voucher_renumbering" r
                    WHERE r."superseded_voucher_id" = OLD."id"
                      AND r."previous_access_key" = OLD."access_key"
                      AND r."invoice_id" IS NOT DISTINCT FROM OLD."invoice_id"
                      AND r."credit_note_id" IS NOT DISTINCT FROM OLD."credit_note_id"))
  THEN
    RAISE EXCEPTION 'electronic_voucher_superseded_only_renumbered: only a voucher returned with a renumbering is replaced'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'electronic_voucher_superseded_only_renumbered',
            HINT = 'Sólo se reemplaza el comprobante devuelto y nunca autorizado que una renumeración nombra.';
  END IF;

  IF OLD."status" = 'SUPERSEDED' THEN
    RAISE EXCEPTION 'electronic_voucher_superseded_is_final: a replaced voucher does not change'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'electronic_voucher_superseded_is_final',
            HINT = 'Un comprobante reemplazado por una renumeración no cambia.';
  END IF;

  IF NEW."access_key"     IS DISTINCT FROM OLD."access_key"
  OR NEW."numeric_code"   IS DISTINCT FROM OLD."numeric_code"
  OR NEW."environment"    IS DISTINCT FROM OLD."environment"
  OR NEW."document_type"  IS DISTINCT FROM OLD."document_type"
  OR NEW."site_id"        IS DISTINCT FROM OLD."site_id"
  OR (NOT superseded_now AND (
        NEW."invoice_id"     IS DISTINCT FROM OLD."invoice_id"
     OR NEW."credit_note_id" IS DISTINCT FROM OLD."credit_note_id"))
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

-- ── 3.2 El número y la clave de la factura ─────────────────────────────────
--
-- Replaces `trg_invoice_access_key_permanent`, which froze only the key: the
-- sequential, the point and the key now move together, and only renumbered.

DROP TRIGGER "trg_invoice_access_key_permanent" ON "invoice";
DROP FUNCTION trg_invoice_access_key_is_permanent();

CREATE OR REPLACE FUNCTION invoice_number_moves_only_renumbered()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."sequential" IS DISTINCT FROM OLD."sequential"
  OR NEW."emission_point_id" IS DISTINCT FROM OLD."emission_point_id"
  OR (OLD."access_key" IS NOT NULL AND NEW."access_key" IS DISTINCT FROM OLD."access_key")
  THEN
    IF NOT (
         OLD."status" = 'REJECTED'
         AND NEW."emission_point_id" = OLD."emission_point_id"
         AND NEW."access_key" IS NULL
         AND EXISTS (SELECT 1 FROM "voucher_renumbering" r
                      WHERE r."invoice_id" = OLD."id"
                        AND r."previous_access_key" = OLD."access_key"
                        AND r."previous_sequential" = OLD."sequential"
                        AND r."new_sequential" = NEW."sequential"
                        AND r."emission_point_id" = OLD."emission_point_id"))
    THEN
      -- The key keeps the name SRI-005 gave its refusal.
      IF OLD."access_key" IS NOT NULL AND NEW."access_key" IS DISTINCT FROM OLD."access_key" THEN
        RAISE EXCEPTION 'invoice_access_key_is_permanent: the key of an invoice only changes renumbered'
          USING ERRCODE = 'check_violation',
                CONSTRAINT = 'invoice_number_is_permanent',
                HINT = 'La clave de acceso no se regenera: los errores 43 y 70 significan ya enviado. Sólo una factura devuelta con el error 45 se renumera.';
      END IF;
      RAISE EXCEPTION 'invoice_number_is_permanent: the number of an invoice only changes renumbered'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'invoice_number_is_permanent',
              HINT = 'El número de una factura no cambia. Sólo una factura devuelta con el error 45 se renumera.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_invoice_number_permanent"
  BEFORE UPDATE OF "sequential", "emission_point_id", "access_key" ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION invoice_number_moves_only_renumbered();

-- ── 3.3 El número y la clave de la nota de crédito ─────────────────────────

CREATE OR REPLACE FUNCTION credit_note_is_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  reason_moves BOOLEAN;
  withdrawn_now BOOLEAN;
  renumbered BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credit_note_immutable: a credit note is never deleted'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'credit_note_immutable',
            HINT = 'Una nota de crédito no se elimina.';
  END IF;

  reason_moves := (OLD."reason_code", OLD."reason")
                  IS DISTINCT FROM (NEW."reason_code", NEW."reason");
  withdrawn_now := OLD."status" = 'REJECTED' AND NEW."status" = 'WITHDRAWN';
  -- SRI-111. Returned with the 45: another number, no key until the new
  -- voucher is prepared, and back to ISSUED.
  renumbered := OLD."status" = 'REJECTED' AND NEW."status" = 'ISSUED'
                AND NEW."access_key" IS NULL
                AND EXISTS (SELECT 1 FROM "voucher_renumbering" r
                             WHERE r."credit_note_id" = OLD."id"
                               AND r."previous_access_key" = OLD."access_key"
                               AND r."previous_sequential" = OLD."sequential"
                               AND r."new_sequential" = NEW."sequential"
                               AND r."emission_point_id" = OLD."emission_point_id");

  IF (OLD."invoice_id", OLD."site_id", OLD."emission_point_id",
      OLD."amount", OLD."subtotal_taxed",
      OLD."subtotal_untaxed", OLD."discount_total", OLD."tax_total",
      OLD."buyer_identification_type", OLD."buyer_identification",
      OLD."buyer_name", OLD."buyer_email", OLD."issued_by_id", OLD."issued_at")
     IS DISTINCT FROM
     (NEW."invoice_id", NEW."site_id", NEW."emission_point_id",
      NEW."amount", NEW."subtotal_taxed",
      NEW."subtotal_untaxed", NEW."discount_total", NEW."tax_total",
      NEW."buyer_identification_type", NEW."buyer_identification",
      NEW."buyer_name", NEW."buyer_email", NEW."issued_by_id", NEW."issued_at")
     OR (NEW."sequential" IS DISTINCT FROM OLD."sequential" AND NOT renumbered)
     OR (OLD."access_key" IS NOT NULL AND NEW."access_key" IS DISTINCT FROM OLD."access_key"
         AND NOT renumbered)
     -- BI-303. Only a returned note's reason, staying returned, and never
     -- across «servicio no prestado» or «datos del receptor».
     OR (reason_moves AND NOT (
           OLD."status" = 'REJECTED' AND NEW."status" = 'REJECTED'
           AND (OLD."reason_code" = 'SERVICE_NOT_PROVIDED')
             = (NEW."reason_code" = 'SERVICE_NOT_PROVIDED')
           AND (OLD."reason_code" = 'RECEIVER_DATA')
             = (NEW."reason_code" = 'RECEIVER_DATA')))
     OR (NEW."withdrawal_reason" IS DISTINCT FROM OLD."withdrawal_reason"
         AND NOT withdrawn_now)
     -- Who corrected or withdrew moves only with what they did.
     OR ((NEW."changed_by", NEW."changed_at") IS DISTINCT FROM (OLD."changed_by", OLD."changed_at")
         AND NOT (reason_moves OR withdrawn_now))
     OR (OLD."status" IN ('AUTHORISED', 'WITHDRAWN') AND NEW."status" <> OLD."status")
     OR (NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
           (OLD."status" = 'ISSUED' AND NEW."status" IN ('AUTHORISED', 'REJECTED'))
        OR (OLD."status" = 'REJECTED' AND NEW."status" IN ('ISSUED', 'AUTHORISED', 'WITHDRAWN'))))
  THEN
    RAISE EXCEPTION 'credit_note_immutable: an issued credit note only records what the SRI says'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'credit_note_immutable',
            HINT = 'Una nota de crédito emitida no se modifica: sólo se corrige el motivo de una devuelta, se desiste de ella o se renumera la devuelta con el error 45.';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
