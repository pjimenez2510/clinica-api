-- clinical_note_signature_method
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- ═══════════════════════════════════════════════════════════════════════════
-- EN-156: CÓMO SE FIRMÓ LA NOTA, GUARDADO CON LA NOTA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La constancia de que una firma NO lleva certificado electrónico tiene que
-- viajar con la nota —a su PDF, a la exportación, a la inspección—, no vivir
-- en un texto que pinta la pantalla. Es una columna, la escribe la firma y no
-- se cambia después.
--
-- Hoy el sistema no custodia ningún certificado (D-177.1), así que toda firma
-- es `CREDENTIAL`. Las notas firmadas antes de esta columna se quedan en NULL:
-- no se rellenan, porque son inmutables y porque NULL dice la verdad —se
-- firmaron cuando no existía otra forma que la credencial—; quien las lee
-- (pantalla y resumen) trata NULL como «sin certificado».

CREATE TYPE "signature_method" AS ENUM ('CREDENTIAL', 'CERTIFICATE');

ALTER TABLE "clinical_note" ADD COLUMN "signature_method" "signature_method";

-- Un borrador no está firmado: no puede decir cómo se firmó.
ALTER TABLE "clinical_note"
  ADD CONSTRAINT "clinical_note_method_only_when_signed"
  CHECK ("signature_method" IS NULL OR "signed_at" IS NOT NULL);

-- Toda firma NUEVA dice cómo se firmó, y la escribe la base: el único camino
-- de firma que existe es la credencial, así que una firma que no declara otro
-- método ES con credencial. No se exige al llamador por dos razones: los tres
-- caminos que firman (firmar, enmendar, interrumpir) y cada prueba que siembra
-- una nota firmada tendrían que repetirlo, y el día que exista la custodia
-- (D-177.1) el camino del certificado escribirá `CERTIFICATE` explícitamente.
-- Si lo olvidara, la nota diría «sin certificado»: el error queda del lado que
-- afirma MENOS, nunca del que inventa un certificado.
--
-- Sólo en el acto de firmar —nacer firmada (la enmienda) o pasar de borrador a
-- firmada—: una nota antigua (NULL) que pasa a SUPERSEDED o ENTERED_IN_ERROR no
-- se toca, y la inmutabilidad de abajo lo vigila.
CREATE OR REPLACE FUNCTION clinical_note_signature_states_its_method()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."signed_at" IS NOT NULL
     AND NEW."signature_method" IS NULL
     AND (TG_OP = 'INSERT' OR OLD."signed_at" IS NULL) THEN
    NEW."signature_method" := 'CREDENTIAL';
  END IF;
  RETURN NEW;
END;
$$;

-- `a_` para correr ANTES que `trg_clinical_note_immutable` (orden alfabético):
-- la inmutabilidad compara la fila ya completa.
CREATE TRIGGER a_clinical_note_signature_states_its_method
  BEFORE INSERT OR UPDATE ON "clinical_note"
  FOR EACH ROW EXECUTE FUNCTION clinical_note_signature_states_its_method();

-- La constancia se congela con el resto de la firma. Misma función que
-- `20260806022956_clinical_core_constraints`, con `signature_method` en las
-- dos transiciones que una nota firmada admite.
CREATE OR REPLACE FUNCTION clinical_note_immutable_when_signed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'clinical notes are never deleted (note %)', OLD.id
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Retract with status = ENTERED_IN_ERROR, or amend with a new version.';
  END IF;

  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;                                  -- a draft is mutable
  END IF;

  -- Only permitted transition on an already-signed note: SIGNED -> SUPERSEDED
  -- with the content untouched.
  IF OLD.status = 'SIGNED'
     AND NEW.content          IS NOT DISTINCT FROM OLD.content
     AND NEW.content_hash     IS NOT DISTINCT FROM OLD.content_hash
     AND NEW.signed_at        IS NOT DISTINCT FROM OLD.signed_at
     AND NEW.signed_by_id     IS NOT DISTINCT FROM OLD.signed_by_id
     AND NEW.signature_method IS NOT DISTINCT FROM OLD.signature_method
     AND NEW.status = 'SUPERSEDED'
  THEN
    RETURN NEW;
  END IF;

  -- Retraction with no replacement.
  IF NEW.status = 'ENTERED_IN_ERROR'
     AND OLD.status = 'SIGNED'
     AND NEW.content          IS NOT DISTINCT FROM OLD.content
     AND NEW.signature_method IS NOT DISTINCT FROM OLD.signature_method
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'clinical note % is signed and cannot be modified', OLD.id
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Create a new version with supersedes_id and amendment_reason.';
END;
$$;
