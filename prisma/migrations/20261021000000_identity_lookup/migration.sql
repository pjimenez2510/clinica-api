-- IL-007, IL-009, IL-010 (D-206). Proponer los nombres por la cédula.
--
-- CUATRO TABLAS DE DATOS DE TERCEROS O DE SU INTERRUPTOR, y ninguna es
-- historia clínica: no entran en `record_version`. El motivo de cada una está
-- en `src/modules/identity-lookup/SPEC.md` («Por qué se guardan datos de
-- terceros»).

-- IL-010. Un interruptor para toda la clínica, apagado de fábrica.
--
-- FILA ÚNICA: la clave es un booleano que sólo puede ser `true`, así que no
-- cabe una segunda fila. SIN FILA es APAGADO —lo que no se declaró no se
-- enciende—, y por eso la migración no inserta ninguna. Quién lo cambió y
-- desde qué valor lo dice la bitácora de `configuration`, no esta fila.
CREATE TABLE "identity_lookup_setting" (
  "id" BOOLEAN NOT NULL DEFAULT true,
  "external_sources_enabled" BOOLEAN NOT NULL DEFAULT false,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "identity_lookup_setting_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "identity_lookup_setting_single_row" CHECK ("id")
);

-- IL-009. Cada archivo del catastro importado, una vez.
--
-- El SHA-256 del archivo es lo que hace idempotente la importación: el mismo
-- archivo dos veces choca con el índice único y no cambia nada.
CREATE TABLE "sri_ruc_registry_import" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "file_sha256" CHAR(64) NOT NULL,
  "file_name" VARCHAR(255) NOT NULL,
  "rows_imported" INTEGER NOT NULL,
  "imported_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "sri_ruc_registry_import_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sri_ruc_registry_import_sha256_format"
    CHECK ("file_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "sri_ruc_registry_import_rows_non_negative"
    CHECK ("rows_imported" >= 0)
);

CREATE UNIQUE INDEX "sri_ruc_registry_import_file_sha256_key"
  ON "sri_ruc_registry_import" ("file_sha256");

-- IL-009. Sólo personas naturales, y de ellas sólo cédula y nombre.
--
-- El dígito verificador lo comprueba el importador con `Cedula`; la base
-- guarda la forma (diez dígitos) y que el nombre no esté vacío.
CREATE TABLE "sri_ruc_registry_entry" (
  "cedula" CHAR(10) NOT NULL,
  "registry_name" VARCHAR(300) NOT NULL,
  "import_id" UUID NOT NULL,
  CONSTRAINT "sri_ruc_registry_entry_pkey" PRIMARY KEY ("cedula"),
  CONSTRAINT "sri_ruc_registry_entry_cedula_format"
    CHECK ("cedula" ~ '^[0-9]{10}$'),
  CONSTRAINT "sri_ruc_registry_entry_name_not_blank"
    CHECK (btrim("registry_name") <> '')
);

ALTER TABLE "sri_ruc_registry_entry"
  ADD CONSTRAINT "sri_ruc_registry_entry_import_id_fkey"
  FOREIGN KEY ("import_id") REFERENCES "sri_ruc_registry_import"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "sri_ruc_registry_entry_import_id_idx"
  ON "sri_ruc_registry_entry" ("import_id");

-- IL-007. Lo que devolvió el proveedor, 30 días.
--
-- POR DIGESTO Y NO POR CÉDULA: el HMAC con la clave de la aplicación
-- identifica a la persona sin escribir su número. El plazo lo fija la
-- aplicación con su reloj (30 días); la base pone el techo de D-206 (90) y
-- rechaza la entrada que vence antes de guardarse.
CREATE TABLE "identity_lookup_cache" (
  "cedula_digest" CHAR(64) NOT NULL,
  "source" VARCHAR(32) NOT NULL,
  "family_name" VARCHAR(100),
  "second_family_name" VARCHAR(100),
  "given_name" VARCHAR(100),
  "second_given_name" VARCHAR(100),
  "source_name" VARCHAR(300) NOT NULL,
  "birth_date" DATE,
  "fetched_at" TIMESTAMPTZ(6) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "identity_lookup_cache_pkey" PRIMARY KEY ("cedula_digest"),
  CONSTRAINT "identity_lookup_cache_digest_format"
    CHECK ("cedula_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "identity_lookup_cache_source_known"
    CHECK ("source" IN ('PROVIDER')),
  CONSTRAINT "identity_lookup_cache_lifetime"
    CHECK ("expires_at" > "fetched_at"
       AND "expires_at" <= "fetched_at" + INTERVAL '90 days')
);

CREATE INDEX "identity_lookup_cache_expires_at_idx"
  ON "identity_lookup_cache" ("expires_at");
