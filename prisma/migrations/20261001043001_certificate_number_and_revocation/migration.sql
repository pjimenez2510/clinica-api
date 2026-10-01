-- certificate_number_and_revocation
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
--  · CER-009 (REQ-074): todo certificado médico lleva un número consecutivo
--    POR SEDE, sin huecos, que nadie elige ni cambia. A diferencia de la receta
--    no hay borrador: el certificado nace emitido, así que el número se asigna
--    AL INSERTAR. Mismo contador que la orden y la receta
--    (`document_counter`, kind 'MEDICAL_CERTIFICATE', creado en
--    20261001031348_document_counter_and_order_number).
--  · CER-011 (REQ-074): anular deja constancia de QUIÉN, CUÁNDO y POR QUÉ, los
--    tres juntos o ninguno, y nada se borra. Es la forma de
--    `prescription_discard_states_who_when_and_why`.
--  · CER-029: el formulario 117 no tiene texto libre. `body` era NOT NULL y un
--    párrafo libre es por donde un certificado dice lo que el formulario no
--    permite decir. La columna se elimina.
--
-- POR QUÉ `site_id` EN EL CERTIFICADO. La unicidad del número es por sede
-- (D-074) y un `UNIQUE` necesita la columna. La pone el disparador DESDE LA
-- ATENCIÓN y pisa la que traiga la fila: un certificado archivado bajo otra
-- sede rompería el alcance de todo lo que cuelga de él.

ALTER TABLE "medical_certificate"
  ADD COLUMN IF NOT EXISTS "site_id"       UUID,
  ADD COLUMN IF NOT EXISTS "number"        INTEGER,
  ADD COLUMN IF NOT EXISTS "revoked_by_id" UUID;

UPDATE "medical_certificate" mc
   SET "site_id" = e."site_id"
  FROM "encounter" e
 WHERE e."id" = mc."encounter_id"
   AND mc."site_id" IS NULL;

ALTER TABLE "medical_certificate" ALTER COLUMN "site_id" SET NOT NULL;

ALTER TABLE "medical_certificate" DROP CONSTRAINT IF EXISTS "medical_certificate_site_fk";
ALTER TABLE "medical_certificate"
  ADD CONSTRAINT "medical_certificate_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT;

ALTER TABLE "medical_certificate" DROP CONSTRAINT IF EXISTS "medical_certificate_revoked_by_fk";
ALTER TABLE "medical_certificate"
  ADD CONSTRAINT "medical_certificate_revoked_by_fk"
    FOREIGN KEY ("revoked_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT;

-- Los certificados que ya existen se numeran por sede en el orden en que se
-- emitieron, y el contador arranca detrás del último.
WITH numbered AS (
  SELECT id,
         row_number() OVER (PARTITION BY site_id ORDER BY issued_at, id) AS n
    FROM medical_certificate
)
UPDATE medical_certificate mc
   SET number = numbered.n
  FROM numbered
 WHERE mc.id = numbered.id;

INSERT INTO document_counter (site_id, kind, last_number)
SELECT site_id, 'MEDICAL_CERTIFICATE', max(number)
  FROM medical_certificate
 GROUP BY site_id
ON CONFLICT (site_id, kind) DO UPDATE SET last_number = EXCLUDED.last_number;

-- El valor por defecto sólo existe para que Prisma pueda omitir la columna al
-- crear: el disparador lo pisa siempre.
ALTER TABLE "medical_certificate" ALTER COLUMN "number" SET DEFAULT 0;
ALTER TABLE "medical_certificate" ALTER COLUMN "number" SET NOT NULL;

ALTER TABLE "medical_certificate"
  DROP CONSTRAINT IF EXISTS "medical_certificate_site_number_unique";
ALTER TABLE "medical_certificate"
  ADD CONSTRAINT "medical_certificate_site_number_unique" UNIQUE ("site_id", "number");

-- CER-011. Los tres juntos o ninguno, y el motivo escrito: un motivo en blanco
-- es anular sin decir por qué. Si una fila anulada sin autor existiera, esta
-- sentencia fallaría a propósito: el autor no se inventa.
ALTER TABLE "medical_certificate"
  DROP CONSTRAINT IF EXISTS "medical_certificate_revocation_states_who_when_and_why";
ALTER TABLE "medical_certificate"
  ADD CONSTRAINT "medical_certificate_revocation_states_who_when_and_why" CHECK (
    ("revoked_at" IS NULL AND "revoked_by_id" IS NULL AND "revocation_reason" IS NULL)
    OR ("revoked_at" IS NOT NULL AND "revoked_by_id" IS NOT NULL
        AND "revocation_reason" IS NOT NULL AND btrim("revocation_reason") <> '')
  );

-- CER-029. El 117 no tiene campo de texto libre.
ALTER TABLE "medical_certificate" DROP COLUMN IF EXISTS "body";

-- La sede, desde la atención, y el número, del contador: siempre, pise lo que
-- pise. Un `INSERT` por SQL directo —una importación, un `psql`— recibe el
-- siguiente de su sede como si se emitiera ahora.
CREATE OR REPLACE FUNCTION medical_certificate_assign_number()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT e.site_id INTO NEW.site_id FROM encounter e WHERE e.id = NEW.encounter_id;
  NEW.number := next_document_number(NEW.site_id, 'MEDICAL_CERTIFICATE');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "medical_certificate_number_assigned" ON "medical_certificate";
CREATE TRIGGER "medical_certificate_number_assigned"
  BEFORE INSERT ON "medical_certificate"
  FOR EACH ROW
  EXECUTE FUNCTION medical_certificate_assign_number();

CREATE OR REPLACE FUNCTION medical_certificate_number_is_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.number IS DISTINCT FROM OLD.number
     OR NEW.site_id IS DISTINCT FROM OLD.site_id THEN
    RAISE EXCEPTION
      'medical_certificate_number_immutable: the number and the site of a certificate never change'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'CER-009 (REQ-074). The number is printed on the paper the '
                   'patient hands to an employer; a gap or a change reads as a '
                   'certificate that disappeared.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "medical_certificate_number_immutable" ON "medical_certificate";
CREATE TRIGGER "medical_certificate_number_immutable"
  BEFORE UPDATE ON "medical_certificate"
  FOR EACH ROW
  EXECUTE FUNCTION medical_certificate_number_is_immutable();
