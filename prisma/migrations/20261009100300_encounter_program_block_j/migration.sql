-- encounter_program_block_j
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio:
-- propone borrar las columnas generadas, los índices GIN y BRIN, los índices
-- únicos parciales y los disparadores, porque schema.prisma no puede
-- describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-094, EN-095. EL BLOQUE J DEL RDACAA: LA PRUEBA DE VIH
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Columnas 75 a 82 (instructivo RDACAA 2.0, pp. 59 a 61 del PDF).
--
-- ⚠️ DATO DE ACCESO RESTRINGIDO (REQ-115), CON EL RÉGIMEN DEL TAMIZAJE DE
-- VIOLENCIA, y nada de eso se ve en el SQL: se lee sólo por
-- `GET /encounters/:id/programs/restricted` con `record:protected` en la sede
-- (sin ella, la omisión), con su fila de bitácora en la misma transacción, y
-- ningún listado, error ni log lo lleva. Quien añada esta tabla a otra
-- lectura estará quitando esa puerta sin que nada falle.
--
-- POR ESO SUS VERSIONES NO VAN A `record_version`: la exportación al titular
-- la lee (PD-040), como dijo D-188 §3 del tamizaje. Van a
-- `encounter_hiv_test_version`, que sólo lee la puerta de este bloque.
--
-- Qué se llama cada rechazo (encounter.constraints.ts):
--  · `encounter_hiv_test_confirmation_needs_reactive` — segunda prueba, o vía
--    de transmisión, sin un tamizaje reactivo → CONFIRMATORY_TEST_WITHOUT_SCREENING.
--  · `encounter_hiv_test_confirmation_whole` — dispositivo y resultado de la
--    segunda prueba van juntos → VALIDATION_FAILED en `confirmation`.
--  · `encounter_hiv_test_viral_load_range` / `_cd4_range` → en su campo.
--  · `encounter_hiv_test_change_is_stamped` — una corrección sin sello nuevo.
-- Después: pnpm migrations:check && pnpm db:deploy

CREATE TYPE "hiv_test_reason" AS ENUM (
  'PREGNANT', 'BLOOD_DONATION', 'VOLUNTARY', 'TUBERCULOSIS', 'STI',
  'CLINICAL_SUSPICION', 'OCCUPATIONAL_EXPOSURE', 'DEPRIVED_OF_LIBERTY',
  'SEXUAL_VIOLENCE', 'CAMPAIGN', 'COMMUNITY_OUTREACH', 'PARTNER_OF_PREGNANT'
);
CREATE TYPE "hiv_test_device" AS ENUM (
  'RAPID_THIRD_GENERATION', 'RAPID_FOURTH_GENERATION', 'ELISA', 'CLIA',
  'VIRAL_LOAD', 'IMMUNOFLUORESCENCE', 'NAT'
);
CREATE TYPE "hiv_test_result" AS ENUM ('REACTIVE', 'NON_REACTIVE');
CREATE TYPE "hiv_transmission_route" AS ENUM (
  'SEXUAL', 'BLOOD_OR_TRANSPLANT', 'INJECTED_DRUGS', 'MOTHER_TO_CHILD'
);

CREATE TABLE "encounter_hiv_test" (
  "encounter_id" UUID PRIMARY KEY,

  "reason"              "hiv_test_reason" NOT NULL,
  "screening_device"    "hiv_test_device" NOT NULL,
  "screening_result"    "hiv_test_result" NOT NULL,
  "confirmation_device" "hiv_test_device",
  "confirmation_result" "hiv_test_result",
  "transmission_route"  "hiv_transmission_route",
  -- Copias/mL y células/mm³, resultados que se copian del laboratorio.
  "viral_load"          INTEGER,
  "cd4"                 INTEGER,

  "recorded_by_id" UUID NOT NULL,
  "recorded_at"    TIMESTAMPTZ(6) NOT NULL,
  "edited_by_id"   UUID,
  "edited_at"      TIMESTAMPTZ(6),

  CONSTRAINT "encounter_hiv_test_encounter_id_fkey"
    FOREIGN KEY ("encounter_id") REFERENCES "encounter"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "encounter_hiv_test_recorded_by_id_fkey"
    FOREIGN KEY ("recorded_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "encounter_hiv_test_edited_by_id_fkey"
    FOREIGN KEY ("edited_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  -- «Si el resultado de la primera prueba es reactiva, el usuario debe
  -- realizarse una segunda prueba de confirmación»: sin primera reactiva no
  -- hay segunda, ni vía de transmisión.
  CONSTRAINT "encounter_hiv_test_confirmation_needs_reactive" CHECK (
    "screening_result" = 'REACTIVE'
    OR ("confirmation_device" IS NULL AND "confirmation_result" IS NULL
        AND "transmission_route" IS NULL)
  ),
  CONSTRAINT "encounter_hiv_test_confirmation_whole" CHECK (
    ("confirmation_device" IS NULL) = ("confirmation_result" IS NULL)
  ),
  CONSTRAINT "encounter_hiv_test_viral_load_range"
    CHECK ("viral_load" BETWEEN 0 AND 100000000),
  CONSTRAINT "encounter_hiv_test_cd4_range"
    CHECK ("cd4" BETWEEN 0 AND 5000),
  CONSTRAINT "encounter_hiv_test_edit_stamp_whole"
    CHECK (("edited_by_id" IS NULL) = ("edited_at" IS NULL))
);

COMMENT ON TABLE "encounter_hiv_test" IS
  'EN-094, EN-095. Prueba de VIH, bloque J del RDACAA (columnas 75 a 82). '
  'DATO DE ACCESO RESTRINGIDO: se lee sólo por GET /encounters/:id/programs/restricted '
  'con record:protected, con fila de bitácora; ningún listado ni log lo lleva. '
  'Versiones en encounter_hiv_test_version, fuera de record_version a propósito.';

CREATE TABLE "encounter_hiv_test_version" (
  "id"             UUID NOT NULL DEFAULT uuidv7(),
  "encounter_id"   UUID NOT NULL,
  "version"        INTEGER NOT NULL,
  "data"           JSONB NOT NULL,
  "replaced_by_id" UUID NOT NULL,
  "replaced_at"    TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "encounter_hiv_test_version_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "encounter_hiv_test_version_unique" UNIQUE ("encounter_id", "version"),
  CONSTRAINT "encounter_hiv_test_version_encounter_fkey"
    FOREIGN KEY ("encounter_id") REFERENCES "encounter_hiv_test"("encounter_id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "encounter_hiv_test_version_replaced_by_fkey"
    FOREIGN KEY ("replaced_by_id") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

COMMENT ON TABLE "encounter_hiv_test_version" IS
  'EN-095, EN-249. Pruebas de VIH anteriores, archivadas por '
  'trg_encounter_hiv_test_archive en cada corrección. DATO DE ACCESO RESTRINGIDO.';

-- Las versiones no se reescriben ni se borran.
CREATE FUNCTION encounter_hiv_test_version_insert_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'encounter_hiv_test_version_insert_only: a version is never changed nor deleted'
    USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER "trg_encounter_hiv_test_version_insert_only"
  BEFORE UPDATE OR DELETE ON "encounter_hiv_test_version"
  FOR EACH ROW EXECUTE FUNCTION encounter_hiv_test_version_insert_only();

-- EN-249. Cada corrección trae su sello nuevo y archiva la fila ENTERA que
-- reemplaza. El instante lo pone la aplicación, nunca `now()`: los recorridos
-- mueven el reloj de la API.
CREATE FUNCTION encounter_hiv_test_archive()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.edited_by_id IS NULL OR NEW.edited_at IS NULL
     OR NEW.edited_at IS NOT DISTINCT FROM OLD.edited_at THEN
    RAISE EXCEPTION 'encounter_hiv_test_change_is_stamped: a correction carries a new stamp'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'encounter_hiv_test_change_is_stamped';
  END IF;

  INSERT INTO encounter_hiv_test_version
    (encounter_id, version, data, replaced_by_id, replaced_at)
  SELECT OLD.encounter_id,
         COALESCE(MAX(v.version), 0) + 1,
         to_jsonb(OLD),
         NEW.edited_by_id,
         NEW.edited_at
    FROM encounter_hiv_test_version v
   WHERE v.encounter_id = OLD.encounter_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_hiv_test_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "encounter_hiv_test"
  FOR EACH ROW EXECUTE FUNCTION program_block_guard();

CREATE TRIGGER "trg_encounter_hiv_test_keeps_its_author"
  BEFORE UPDATE ON "encounter_hiv_test"
  FOR EACH ROW EXECUTE FUNCTION program_block_keeps_its_author();

CREATE TRIGGER "trg_encounter_hiv_test_archive"
  BEFORE UPDATE ON "encounter_hiv_test"
  FOR EACH ROW EXECUTE FUNCTION encounter_hiv_test_archive();
