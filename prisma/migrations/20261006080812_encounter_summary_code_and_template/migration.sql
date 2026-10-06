-- encounter_summary_code_and_template
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy


-- QUÉ GARANTIZA:
--
-- EN-219. Que toda atención lleve un código ALEATORIO con el que se verifica,
-- sin ningún dato del paciente, el resumen que se imprime de ella (DOC-112).
-- Como el de la orden: lo pone la base al insertar y es único. Un valor por
-- defecto VOLÁTIL en `ADD COLUMN` se evalúa fila a fila al reescribir la tabla,
-- así que cada atención existente recibe el suyo SIN un `UPDATE`: los
-- disparadores que protegen una atención cerrada no se tocan ni se apagan.
--
-- Y que no cambie: un código impreso que cambiara dejaría de verificar el papel
-- que el paciente ya tiene.
--
-- DOC-113. La versión 1 de la plantilla del resumen, copiada de la vigente del
-- certificado: la identidad visual es una sola (D-095.3). Sólo si hay una; sin
-- plantilla publicada no se inventa ninguna (DOC-037), y la clínica la publica
-- con las demás desde Administración → Identidad.

ALTER TABLE "encounter"
  ADD COLUMN IF NOT EXISTS "verification_code" VARCHAR(16) NOT NULL
    DEFAULT upper(substr(md5(gen_random_uuid()::text), 1, 16));

ALTER TABLE "encounter"
  DROP CONSTRAINT IF EXISTS "encounter_verification_code_key";
ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_verification_code_key" UNIQUE ("verification_code");

CREATE OR REPLACE FUNCTION encounter_verification_code_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."verification_code" IS DISTINCT FROM OLD."verification_code" THEN
    RAISE EXCEPTION 'El código de verificación de una atención no cambia (EN-219)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_encounter_verification_code_frozen ON "encounter";
CREATE TRIGGER trg_encounter_verification_code_frozen
  BEFORE UPDATE OF "verification_code" ON "encounter"
  FOR EACH ROW EXECUTE FUNCTION encounter_verification_code_frozen();

INSERT INTO "document_template" (
  "kind", "version", "accent_colour", "footer_text", "header_fields",
  "show_establishment_ruc", "show_establishment_address",
  "show_establishment_phone", "published_by_id"
)
SELECT 'ENCOUNTER_SUMMARY', 1, "accent_colour", "footer_text", "header_fields",
       "show_establishment_ruc", "show_establishment_address",
       "show_establishment_phone", "published_by_id"
  FROM "document_template"
 WHERE "kind" = 'MEDICAL_CERTIFICATE'
   AND NOT EXISTS (
     SELECT 1 FROM "document_template" WHERE "kind" = 'ENCOUNTER_SUMMARY'
   )
 ORDER BY "version" DESC
 LIMIT 1;
