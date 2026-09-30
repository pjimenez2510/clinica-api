-- documents_renders_and_visual_identity
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- D-A-014, D-A-015 · LA REPRESENTACIÓN DEJA DE SER EFÍMERA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS MISSING. Until today the receta, the exam request, the certificate
-- and the RIDE were «printed» from the browser with `@media print`. That
-- produces NO ARTEFACT: nothing to keep, to hash, to sign, to attach to the
-- SRI, to reprint identically or to show an inspector.
--
-- And the law requires one:
--
--   * Ley 67 de Comercio Electrónico, art. 8(b) — the data message is kept
--     «con el formato en el que se haya generado … o con algún formato que sea
--     demostrable que reproduce con exactitud la información generada»; art. 7
--     requires being able to show it «ha conservado la integridad … desde que
--     se generó en su forma definitiva».
--   * Resolución ACESS-2023-0030, art. 9 — prescriptions «deben contar con una
--     copia de respaldo para su archivo; la cual podrá ser solicitada durante
--     el control realizado por parte de la ACESS».
--   * ETSI EN 319 142-1 — a PAdES signature «shall cover the entire file», so
--     signing and regenerating on demand are mutually exclusive.
--
-- This project already freezes the DATA — the diagnosis snapshot, the DCI of a
-- prescription, the frozen age of an attention. What was missing was freezing
-- the REPRESENTATION, which is the only part of an issued document that could
-- still change underneath it.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION CREATES, AND WHY EACH PIECE
-- ---------------------------------------------------------------------------
--
--   1. `document_image` — the logo, the seal and the signature, as RE-ENCODED
--      bytes. PNG or JPEG only; SVG is refused. Insert-only.
--   2. `document_template` — the versioned template with FIXED SLOTS.
--      Insert-only; the current version is the highest one.
--   3. `document_render` — THE ARTEFACT. Insert-only, and that is the central
--      guarantee of the whole module.
--   4. The identity columns that were missing and hurt: the establishment's
--      logo and its four fiscal flags for the RIDE, and the practitioner's
--      seal and signature, which art. 5 demands TWICE (d.iii and e.iv) and for
--      which there was not even a column.
--
-- RETRYABLE ON PURPOSE. Every statement is `IF NOT EXISTS` / `DROP … IF
-- EXISTS` so that re-running it after a partial failure converges instead of
-- needing a hand-repaired database. `pnpm db:reset` is the ordinary loop while
-- `scripts/database-phase.mjs` says `development`, but a migration that can
-- only be applied once is one bad connection away from a manual fix.

-- ---------------------------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------------------------
--
-- `document_kind` has ONE VALUE PER SUBJECT TABLE, which is what lets
-- `document_render_kind_matches_subject` hold the class and the subject in
-- agreement. A free-text «type» column could not.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'document_kind') THEN
    CREATE TYPE "document_kind" AS ENUM (
      'PRESCRIPTION', 'SERVICE_ORDER', 'MEDICAL_CERTIFICATE', 'INVOICE_RIDE'
    );
  END IF;
END
$$;

-- The RIMPE legend of the RIDE (SRI, Ficha Técnica, Anexo 2). `NONE` is the
-- general regime and prints nothing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'rimpe_regime') THEN
    CREATE TYPE "rimpe_regime" AS ENUM ('NONE', 'ENTREPRENEUR', 'POPULAR_BUSINESS');
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. `document_image` — DOC-050 a DOC-058
-- ---------------------------------------------------------------------------
--
-- ONE TABLE FOR THE THREE IMAGES, and that is not premature sharing: the three
-- carry the same six facts and pass through the same hostile-input pipeline —
-- byte cap BEFORE decoding, pixel cap against decompression bombs, re-encode
-- from the decoded pixels, flatten the alpha channel. Repeating six columns
-- three times would be three places to forget one of those steps, and the one
-- nobody would repeat is the alpha flattening, whose absence produces PDFs
-- that look right and do not validate as PDF/A-1b.
--
-- THE BYTES LIVE IN THE DATABASE AND NOT ON A DISK (D-A-015). `pg_dump` and a
-- filesystem copy are NOT a coherent snapshot of each other: restore the
-- database at 03:00 and the disk at 03:15 and you have rows pointing at files
-- that do not exist. In a project whose rule is «lo que la base garantiza se
-- prueba contra la base», splitting the invariant across two stores is a
-- contradiction. A 200 KB logo goes out of line through TOAST and leaves 18
-- bytes in the row, so it is not read by the queries that do not ask for it.

CREATE TABLE IF NOT EXISTS "document_image" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "mime_type" VARCHAR(32) NOT NULL,
    "bytes" BYTEA NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by_id" UUID NOT NULL,

    CONSTRAINT "document_image_pkey" PRIMARY KEY ("id")
);

-- DOC-050, DOC-051. THE ALLOWLIST IS IN THE DATABASE and not only in the
-- service. An SVG DOES execute scripts when it is navigated to directly —
-- «sólo lo pintamos en un `img`» holds until somebody opens the image in a new
-- tab — and there are real CVEs of credential theft through exactly that path.
-- Stripe, with an unlimited security budget, accepts «JPG or PNG, less than
-- 512kb» and no SVG. Two commonly repeated beliefs are false and worth writing
-- down: SVGO is a MINIFIER and not a sanitiser (it has its own entity-expansion
-- CVE), and OWASP has NO guidance on SVG — whoever cites it cites something
-- that does not exist.
ALTER TABLE "document_image" DROP CONSTRAINT IF EXISTS "document_image_mime_type_allowed";
ALTER TABLE "document_image"
  ADD CONSTRAINT "document_image_mime_type_allowed"
  CHECK ("mime_type" IN ('image/png', 'image/jpeg'));

-- DOC-052, DOC-053, DOC-056. The three shapes that make the stored metadata
-- trustworthy. `byte_size` exists so a listing can show the size without
-- dragging the image out of TOAST, and a derived column that may lie is worse
-- than no column.
ALTER TABLE "document_image" DROP CONSTRAINT IF EXISTS "document_image_byte_size_is_consistent";
ALTER TABLE "document_image"
  ADD CONSTRAINT "document_image_byte_size_is_consistent"
  CHECK ("byte_size" = octet_length("bytes") AND "byte_size" > 0 AND "byte_size" <= 524288);

ALTER TABLE "document_image" DROP CONSTRAINT IF EXISTS "document_image_sha256_format";
ALTER TABLE "document_image"
  ADD CONSTRAINT "document_image_sha256_format"
  CHECK ("sha256" ~ '^[0-9a-f]{64}$');

-- A byte cap does NOT protect against a decompression bomb: a 40 KB PNG can
-- declare 30 000 × 30 000 pixels and ask for several gigabytes when decoded.
-- The two caps measure different things and both are needed. Forty million
-- pixels is roughly a 6300 × 6300 image — far beyond any logo, far below what
-- hurts.
ALTER TABLE "document_image" DROP CONSTRAINT IF EXISTS "document_image_pixels_bounded";
ALTER TABLE "document_image"
  ADD CONSTRAINT "document_image_pixels_bounded"
  CHECK ("width" > 0 AND "height" > 0 AND "width"::bigint * "height"::bigint <= 40000000);

ALTER TABLE "document_image" DROP CONSTRAINT IF EXISTS "document_image_uploaded_by_fk";
ALTER TABLE "document_image"
  ADD CONSTRAINT "document_image_uploaded_by_fk"
  FOREIGN KEY ("uploaded_by_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

COMMENT ON TABLE "document_image" IS
  'DOC-050 a DOC-058. Logo del establecimiento y sello y firma del prescriptor, '
  'RE-ENCODADOS: nunca los bytes que llegaron. PNG o JPEG; SVG se rechaza. '
  'Insert-only por disparador.';

-- ---------------------------------------------------------------------------
-- 3. `document_template` — DOC-030 a DOC-037
-- ---------------------------------------------------------------------------
--
-- FIXED SLOTS, NOT AN EDITABLE TEMPLATE. The general risk has a name — internal
-- platform effect: making something so configurable that it becomes a
-- badly-made programming language inside your application — but the argument
-- this project owns is stronger: A VERIFIABLE EARS REQUIREMENT CANNOT BE
-- WRITTEN AGAINST A TEMPLATE THE CLINIC REWROTE ON TUESDAY. The chain
-- normativa → REQ → DOC → prueba stops being checkable the moment the
-- structure of the document is tenant data. And «varias clínicas» here means
-- several DEPLOYMENTS: the schema already says «Not a tenant: the whole
-- database belongs to one clinic».
--
-- THERE IS NO `active` COLUMN, AND THAT IS THE DESIGN (DOC-031). The current
-- version is the HIGHEST one. A flag would need an `UPDATE` to move, and an
-- `UPDATE` on a versions table is exactly the change-underneath-your-feet this
-- module exists to prevent.

CREATE TABLE IF NOT EXISTS "document_template" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "kind" "document_kind" NOT NULL,
    "version" INTEGER NOT NULL,
    "accent_colour" CHAR(7) NOT NULL,
    "footer_text" VARCHAR(500),
    "header_fields" JSONB NOT NULL DEFAULT '[]',
    "show_establishment_ruc" BOOLEAN NOT NULL DEFAULT false,
    "show_establishment_address" BOOLEAN NOT NULL DEFAULT false,
    "show_establishment_phone" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_by_id" UUID NOT NULL,

    CONSTRAINT "document_template_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "document_template_kind_version_unique"
  ON "document_template"("kind", "version");

ALTER TABLE "document_template" DROP CONSTRAINT IF EXISTS "document_template_version_is_positive";
ALTER TABLE "document_template"
  ADD CONSTRAINT "document_template_version_is_positive"
  CHECK ("version" >= 1);

-- DOC-035. Lowercase `#rrggbb` and nothing else. Case matters because the value
-- is compared, not only printed: `#AABBCC` and `#aabbcc` would be two rows
-- saying the same colour and neither could be found by the other.
ALTER TABLE "document_template" DROP CONSTRAINT IF EXISTS "document_template_accent_colour_format";
ALTER TABLE "document_template"
  ADD CONSTRAINT "document_template_accent_colour_format"
  CHECK ("accent_colour" ~ '^#[0-9a-f]{6}$');

-- DOC-036. THE CAP IS THE SLOT MADE INTO A RULE. Without it, «unos pocos campos
-- clave-valor» becomes the free-form table this design refuses, one field a
-- week — and then no EARS requirement can describe what the document says.
-- Every entry is an object with exactly `label` and `value`, both non-empty.
--
-- IN A FUNCTION AND NOT INLINE, because PostgreSQL refuses a subquery inside a
-- `CHECK` («cannot use subquery in check constraint») and walking a JSON array
-- needs one. `IMMUTABLE` and `STRICT`: it depends on nothing but its argument,
-- which is what makes it legal in a constraint. Same shape as
-- `is_valid_cedula()`.
CREATE OR REPLACE FUNCTION document_template_header_fields_are_valid(fields jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT jsonb_typeof(fields) = 'array'
     AND jsonb_array_length(fields) <= 6
     AND NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(fields) AS entry
           WHERE jsonb_typeof(entry) <> 'object'
              OR coalesce(entry ->> 'label', '') = ''
              OR coalesce(entry ->> 'value', '') = ''
              OR (SELECT count(*) FROM jsonb_object_keys(entry)) <> 2
         );
$$;

ALTER TABLE "document_template" DROP CONSTRAINT IF EXISTS "document_template_header_fields_bounded";
ALTER TABLE "document_template"
  ADD CONSTRAINT "document_template_header_fields_bounded"
  CHECK (document_template_header_fields_are_valid("header_fields"));

ALTER TABLE "document_template" DROP CONSTRAINT IF EXISTS "document_template_published_by_fk";
ALTER TABLE "document_template"
  ADD CONSTRAINT "document_template_published_by_fk"
  FOREIGN KEY ("published_by_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

COMMENT ON TABLE "document_template" IS
  'DOC-030 a DOC-037. Plantilla versionada de ranuras fijas. La vigente es la de '
  'mayor version: no hay columna `active` porque moverla exigiria un UPDATE. '
  'Insert-only por disparador.';

-- ---------------------------------------------------------------------------
-- 4. `document_render` — EL ARTEFACTO (DOC-002 a DOC-014)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "document_render" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "kind" "document_kind" NOT NULL,
    "template_id" UUID NOT NULL,
    "template_version" INTEGER NOT NULL,
    "prescription_id" UUID,
    "service_order_id" UUID,
    "certificate_id" UUID,
    "invoice_id" UUID,
    "site_id" UUID NOT NULL,
    "content" BYTEA NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "mime_type" VARCHAR(64) NOT NULL DEFAULT 'application/pdf',
    "pdf_profile" VARCHAR(16) NOT NULL DEFAULT 'PDF/A-1b',
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by_id" UUID NOT NULL,
    "supersedes_id" UUID,
    "supersede_reason" VARCHAR(500),

    CONSTRAINT "document_render_pkey" PRIMARY KEY ("id")
);

-- DOC-003. EXACTLY ONE SUBJECT. Four columns and not a `(type, id)` pair, so
-- there are REAL foreign keys: the archive can never point at a prescription
-- that does not exist. A polymorphic pair has none, and the day a row is
-- removed the archive points at nothing and nothing complains.
ALTER TABLE "document_render" DROP CONSTRAINT IF EXISTS "document_render_one_subject";
ALTER TABLE "document_render"
  ADD CONSTRAINT "document_render_one_subject"
  CHECK (num_nonnulls("prescription_id", "service_order_id", "certificate_id", "invoice_id") = 1);

-- DOC-003. AND THE SUBJECT HAS TO MATCH THE CLASS. Without this, a row can say
-- `INVOICE_RIDE` while pointing at a prescription — every foreign key satisfied
-- and the archive lying about what the file contains.
ALTER TABLE "document_render" DROP CONSTRAINT IF EXISTS "document_render_kind_matches_subject";
ALTER TABLE "document_render"
  ADD CONSTRAINT "document_render_kind_matches_subject"
  CHECK (
    ("kind" = 'PRESCRIPTION'        AND "prescription_id"  IS NOT NULL) OR
    ("kind" = 'SERVICE_ORDER'       AND "service_order_id" IS NOT NULL) OR
    ("kind" = 'MEDICAL_CERTIFICATE' AND "certificate_id"   IS NOT NULL) OR
    ("kind" = 'INVOICE_RIDE'        AND "invoice_id"       IS NOT NULL)
  );

-- DOC-004. The stored size is the real size, and there are bytes. A zero-byte
-- artefact would satisfy every other rule here and be no document at all.
-- The 32 MB ceiling is a sanity bound, not a product limit: an A4 PDF/A of a
-- receta is tens of kilobytes, and anything three orders of magnitude larger
-- is a defect writing into the archive.
ALTER TABLE "document_render" DROP CONSTRAINT IF EXISTS "document_render_content_is_consistent";
ALTER TABLE "document_render"
  ADD CONSTRAINT "document_render_content_is_consistent"
  CHECK ("byte_size" = octet_length("content") AND "byte_size" > 0 AND "byte_size" <= 33554432);

-- DOC-002, SC-061. The hash is the whole point of the row: lowercase hex, 64
-- characters. Uppercase would compare unequal to the same hash computed
-- anywhere else, which is the one thing this column must never do.
ALTER TABLE "document_render" DROP CONSTRAINT IF EXISTS "document_render_sha256_format";
ALTER TABLE "document_render"
  ADD CONSTRAINT "document_render_sha256_format"
  CHECK ("sha256" ~ '^[0-9a-f]{64}$');

ALTER TABLE "document_render" DROP CONSTRAINT IF EXISTS "document_render_template_version_is_positive";
ALTER TABLE "document_render"
  ADD CONSTRAINT "document_render_template_version_is_positive"
  CHECK ("template_version" >= 1);

-- DOC-010. Annulling states WHY, or it is not annulling. Without a reason,
-- superseding is a way of making what was emitted disappear — the same argument
-- that made `prescription_discard_states_who_when_and_why` exist. WHO and WHEN
-- are already `issued_by_id` and `issued_at` of the new row.
ALTER TABLE "document_render" DROP CONSTRAINT IF EXISTS "document_render_supersession_states_why";
ALTER TABLE "document_render"
  ADD CONSTRAINT "document_render_supersession_states_why"
  CHECK (("supersedes_id" IS NULL) = ("supersede_reason" IS NULL));

-- DOC-008. One in, one out. A chain that forks has no «current document», and
-- two people would see two final versions of the same act.
CREATE UNIQUE INDEX IF NOT EXISTS "document_render_supersedes_unique"
  ON "document_render"("supersedes_id");

CREATE INDEX IF NOT EXISTS "document_render_by_prescription"
  ON "document_render"("prescription_id");
CREATE INDEX IF NOT EXISTS "document_render_by_invoice"
  ON "document_render"("invoice_id");
CREATE INDEX IF NOT EXISTS "document_render_by_site"
  ON "document_render"("site_id", "issued_at" DESC);

ALTER TABLE "document_render" DROP CONSTRAINT IF EXISTS "document_render_template_fk";
ALTER TABLE "document_render" ADD CONSTRAINT "document_render_template_fk"
  FOREIGN KEY ("template_id") REFERENCES "document_template"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "document_render" DROP CONSTRAINT IF EXISTS "document_render_prescription_fk";
ALTER TABLE "document_render" ADD CONSTRAINT "document_render_prescription_fk"
  FOREIGN KEY ("prescription_id") REFERENCES "prescription"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "document_render" DROP CONSTRAINT IF EXISTS "document_render_service_order_fk";
ALTER TABLE "document_render" ADD CONSTRAINT "document_render_service_order_fk"
  FOREIGN KEY ("service_order_id") REFERENCES "service_order"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "document_render" DROP CONSTRAINT IF EXISTS "document_render_certificate_fk";
ALTER TABLE "document_render" ADD CONSTRAINT "document_render_certificate_fk"
  FOREIGN KEY ("certificate_id") REFERENCES "medical_certificate"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "document_render" DROP CONSTRAINT IF EXISTS "document_render_invoice_fk";
ALTER TABLE "document_render" ADD CONSTRAINT "document_render_invoice_fk"
  FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "document_render" DROP CONSTRAINT IF EXISTS "document_render_site_fk";
ALTER TABLE "document_render" ADD CONSTRAINT "document_render_site_fk"
  FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "document_render" DROP CONSTRAINT IF EXISTS "document_render_issued_by_fk";
ALTER TABLE "document_render" ADD CONSTRAINT "document_render_issued_by_fk"
  FOREIGN KEY ("issued_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "document_render" DROP CONSTRAINT IF EXISTS "document_render_supersedes_fk";
ALTER TABLE "document_render" ADD CONSTRAINT "document_render_supersedes_fk"
  FOREIGN KEY ("supersedes_id") REFERENCES "document_render"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

COMMENT ON TABLE "document_render" IS
  'DOC-002 a DOC-014, SC-060, SC-061. El artefacto emitido: los bytes, su sha256, '
  'la version de plantilla que lo produjo, cuando y quien. INMUTABLE por '
  'disparador: sin UPDATE, sin DELETE y sin TRUNCATE. Reimprimir es servir estos '
  'bytes; corregir es emitir otro que declare supersedes_id sobre este.';

-- ---------------------------------------------------------------------------
-- 5. INMUTABILIDAD — DOC-005, DOC-032, DOC-058
-- ---------------------------------------------------------------------------
--
-- WHY A TRIGGER AND NOT `REVOKE UPDATE, DELETE`. The same reason `access_audit`
-- and `agenda_status_history` give: the table owner keeps its privileges after
-- a REVOKE, and the application connects as the owner. A REVOKE here would be
-- decoration on top of nothing.
--
-- WHY `TRUNCATE` NEEDS ITS OWN TRIGGER: TRUNCATE fires no FOR EACH ROW trigger
-- at all, so without it the entire archive of the clinic goes in one statement
-- — which is the very failure the other two exist to prevent.
--
-- WHAT IS DELIBERATELY NOT REFUSED: `INSERT`, always — the archive grows, and
-- «append-only» is not «frozen». And a superuser who explicitly disables the
-- trigger, or a session in `session_replication_role = 'replica'`. That is not
-- a hole: it is the same escape hatch every append-only table here has carried
-- since `20260806011045_access_audit_append_only`, it cannot be reached by
-- accident, it needs privileges the application does not have, and it is
-- recorded in the server log. The integration suite uses exactly that door to
-- truncate between tests.
--
-- WHY THREE FUNCTIONS AND NOT ONE SHARED. The message names the table, and a
-- shared function would have to say «this table» to stay honest. Whoever hits
-- this at 11 p.m. reads the message, not the catalog, and a name that says
-- `document_render` sends them to the right section of the SPEC.

CREATE OR REPLACE FUNCTION document_render_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'document_render is insert-only: operation % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'An emitted document is the archived copy the Ley 67 art. 8(b) '
                 'and the ACESS-2023-0030 art. 9 require (DOC-005). To correct '
                 'one, emit a new render with supersedes_id over it. To debug in '
                 'development, disable the trigger explicitly.';
END;
$$;

DROP TRIGGER IF EXISTS "trg_document_render_immutable" ON "document_render";
CREATE TRIGGER "trg_document_render_immutable"
  BEFORE UPDATE OR DELETE ON "document_render"
  FOR EACH ROW
  EXECUTE FUNCTION document_render_insert_only();

DROP TRIGGER IF EXISTS "trg_document_render_no_truncate" ON "document_render";
CREATE TRIGGER "trg_document_render_no_truncate"
  BEFORE TRUNCATE ON "document_render"
  FOR EACH STATEMENT
  EXECUTE FUNCTION document_render_insert_only();

CREATE OR REPLACE FUNCTION document_template_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'document_template is insert-only: operation % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'A template version is what an archived document was produced '
                 'with (DOC-032). Publish a NEW version instead; the current one '
                 'is the highest.';
END;
$$;

DROP TRIGGER IF EXISTS "trg_document_template_immutable" ON "document_template";
CREATE TRIGGER "trg_document_template_immutable"
  BEFORE UPDATE OR DELETE ON "document_template"
  FOR EACH ROW
  EXECUTE FUNCTION document_template_insert_only();

DROP TRIGGER IF EXISTS "trg_document_template_no_truncate" ON "document_template";
CREATE TRIGGER "trg_document_template_no_truncate"
  BEFORE TRUNCATE ON "document_template"
  FOR EACH STATEMENT
  EXECUTE FUNCTION document_template_insert_only();

CREATE OR REPLACE FUNCTION document_image_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'document_image is insert-only: operation % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Replacing a logo, a seal or a signature means inserting a new '
                 'row and repointing the reference (DOC-058): an image that '
                 'changes underneath would change what a seal says with nothing '
                 'recording it.';
END;
$$;

DROP TRIGGER IF EXISTS "trg_document_image_immutable" ON "document_image";
CREATE TRIGGER "trg_document_image_immutable"
  BEFORE UPDATE OR DELETE ON "document_image"
  FOR EACH ROW
  EXECUTE FUNCTION document_image_insert_only();

DROP TRIGGER IF EXISTS "trg_document_image_no_truncate" ON "document_image";
CREATE TRIGGER "trg_document_image_no_truncate"
  BEFORE TRUNCATE ON "document_image"
  FOR EACH STATEMENT
  EXECUTE FUNCTION document_image_insert_only();

-- ---------------------------------------------------------------------------
-- 6. LA SUCESIÓN COHERENTE — DOC-009
-- ---------------------------------------------------------------------------
--
-- A CHECK CANNOT DO THIS: the comparison is BETWEEN ROWS, and a `CHECK` sees
-- only its own. Without it, the RIDE of one invoice can declare that it annuls
-- the prescription of another person — every foreign key satisfied — and the
-- archive stops being able to answer «¿cuál es el documento vigente de esta
-- receta?», which is the question `supersedes_id` exists for.
--
-- `BEFORE INSERT` and not `AFTER`: refusing before the row exists means no
-- sequence, no id and no bytes are spent on a document that is not going to
-- stand.

CREATE OR REPLACE FUNCTION document_render_supersession_is_coherent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  superseded document_render%ROWTYPE;
BEGIN
  IF NEW.supersedes_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO superseded FROM document_render WHERE id = NEW.supersedes_id;

  IF NOT FOUND THEN
    -- The foreign key would catch this too; getting here first produces a
    -- message that says what is wrong instead of a constraint name.
    RAISE EXCEPTION 'document_render_supersession_is_coherent: superseded render % does not exist', NEW.supersedes_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF superseded.kind <> NEW.kind
     OR superseded.prescription_id  IS DISTINCT FROM NEW.prescription_id
     OR superseded.service_order_id IS DISTINCT FROM NEW.service_order_id
     OR superseded.certificate_id   IS DISTINCT FROM NEW.certificate_id
     OR superseded.invoice_id       IS DISTINCT FROM NEW.invoice_id THEN
    RAISE EXCEPTION
      'document_render_supersession_is_coherent: a render may only supersede one of the same kind and subject'
      USING ERRCODE = 'check_violation',
            HINT = 'DOC-009. Annulling is emitting a new document OF THE SAME '
                   'act; superseding across subjects would leave the archive '
                   'unable to say which document is current.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trg_document_render_supersession_is_coherent" ON "document_render";
CREATE TRIGGER "trg_document_render_supersession_is_coherent"
  BEFORE INSERT ON "document_render"
  FOR EACH ROW
  EXECUTE FUNCTION document_render_supersession_is_coherent();

-- ---------------------------------------------------------------------------
-- 7. LA IDENTIDAD VISUAL QUE FALTABA — DOC-057, DOC-077
-- ---------------------------------------------------------------------------
--
-- THE PRACTITIONER'S SEAL is the one that hurt most: art. 5 of the Resolución
-- ACESS-2023-0030 demands it TWICE — `d.iii` on the prescriber block and `e.iv`
-- on the tear-off indications — and there was not even a column. It is PER
-- PRACTITIONER and not per establishment: the seal says who signed, not where.
--
-- THE FISCAL FLAGS are the legends the SRI's Anexo 2 places in the RIDE's
-- issuer header. The two resolution numbers are NULLABLE STRINGS AND NOT
-- BOOLEANS on purpose: the legend reads «Contribuyente Especial Nro. 1234», so
-- a boolean would say the establishment is one and be unable to print which.

ALTER TABLE "establishment" ADD COLUMN IF NOT EXISTS "logo_image_id" UUID;
ALTER TABLE "establishment" ADD COLUMN IF NOT EXISTS "keeps_accounting" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "establishment" ADD COLUMN IF NOT EXISTS "special_taxpayer_resolution" VARCHAR(16);
ALTER TABLE "establishment" ADD COLUMN IF NOT EXISTS "withholding_agent_resolution" VARCHAR(16);
ALTER TABLE "establishment" ADD COLUMN IF NOT EXISTS "rimpe_regime" "rimpe_regime" NOT NULL DEFAULT 'NONE';

ALTER TABLE "establishment" DROP CONSTRAINT IF EXISTS "establishment_logo_image_fk";
ALTER TABLE "establishment" ADD CONSTRAINT "establishment_logo_image_fk"
  FOREIGN KEY ("logo_image_id") REFERENCES "document_image"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- The resolution numbers the SRI issues are numeric strings. Keeping them to
-- digits is what stops «SI» or «N/A» being typed into a field that is printed
-- verbatim on a tax document.
ALTER TABLE "establishment" DROP CONSTRAINT IF EXISTS "establishment_special_taxpayer_format";
ALTER TABLE "establishment" ADD CONSTRAINT "establishment_special_taxpayer_format"
  CHECK ("special_taxpayer_resolution" IS NULL OR "special_taxpayer_resolution" ~ '^[0-9]{1,16}$');

ALTER TABLE "establishment" DROP CONSTRAINT IF EXISTS "establishment_withholding_agent_format";
ALTER TABLE "establishment" ADD CONSTRAINT "establishment_withholding_agent_format"
  CHECK ("withholding_agent_resolution" IS NULL OR "withholding_agent_resolution" ~ '^[0-9]{1,16}$');

COMMENT ON COLUMN "establishment"."logo_image_id" IS
  'DOC-057, DOC-059. Logo impreso en la cabecera y, en el RIDE, en la posicion '
  'que marca el Anexo 2 del SRI. NULL es legitimo: el logo no es campo '
  'obligatorio de ninguno de los cuatro documentos.';

ALTER TABLE "practitioner" ADD COLUMN IF NOT EXISTS "seal_image_id" UUID;
ALTER TABLE "practitioner" ADD COLUMN IF NOT EXISTS "signature_image_id" UUID;

ALTER TABLE "practitioner" DROP CONSTRAINT IF EXISTS "practitioner_seal_image_fk";
ALTER TABLE "practitioner" ADD CONSTRAINT "practitioner_seal_image_fk"
  FOREIGN KEY ("seal_image_id") REFERENCES "document_image"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "practitioner" DROP CONSTRAINT IF EXISTS "practitioner_signature_image_fk";
ALTER TABLE "practitioner" ADD CONSTRAINT "practitioner_signature_image_fk"
  FOREIGN KEY ("signature_image_id") REFERENCES "document_image"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

COMMENT ON COLUMN "practitioner"."seal_image_id" IS
  'DOC-057, DOC-060. El sello del prescriptor, que el art. 5 de la '
  'ACESS-2023-0030 exige DOS veces (d.iii y e.iv). Por profesional, no por '
  'establecimiento. NULL imprime un recuadro vacio rotulado: el sistema no '
  'fabrica un sello, y el art. 5.d.iii es textual — «no se aceptaran rubricas o '
  'trazos por firma».';
