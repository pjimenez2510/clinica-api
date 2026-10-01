-- prescription_number_and_indications
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
--  · PR-020 (Res. ACESS-2023-0030 art. 5.a.i, «numeración secuencial»): toda
--    receta EMITIDA lleva un número consecutivo por sede, sin huecos, que nadie
--    elige ni cambia. Se asigna en la transición DRAFT → emitida y no al
--    componer: un borrador que se descarta nunca salió de la consulta y no
--    puede dejar un hueco en la serie que lee la ACESS.
--  · PR-038 y PR-039 (art. 5.e.iv y 5.e.v): las columnas donde viven los signos
--    de alarma y las recomendaciones no farmacológicas. Son de la RECETA, no de
--    la línea: meterlos en `prescription_item.instructions` los haría
--    irrecuperables. Se exigen al emitir (prescription-content.ts), como el
--    resto del art. 5.
--
-- El contador es el mismo `document_counter` de la orden
-- (20261001070100_document_counter_and_order_number), con kind 'PRESCRIPTION'.
--
-- POR QUÉ `site_id` EN LA RECETA. La unicidad del número es por sede (D-074) y
-- un `UNIQUE` necesita la columna. La pone el disparador DESDE LA ATENCIÓN y
-- pisa la que traiga la fila: una receta archivada bajo otra sede rompería el
-- alcance de todo lo que cuelga de ella.

ALTER TABLE "prescription"
  ADD COLUMN IF NOT EXISTS "site_id"                    UUID,
  ADD COLUMN IF NOT EXISTS "sequence_number"            INTEGER,
  ADD COLUMN IF NOT EXISTS "warning_signs"              TEXT,
  ADD COLUMN IF NOT EXISTS "non_pharmacological_advice" TEXT;

UPDATE "prescription" p
   SET "site_id" = e."site_id"
  FROM "encounter" e
 WHERE e."id" = p."encounter_id"
   AND p."site_id" IS NULL;

ALTER TABLE "prescription" ALTER COLUMN "site_id" SET NOT NULL;

ALTER TABLE "prescription" DROP CONSTRAINT IF EXISTS "prescription_site_fk";
ALTER TABLE "prescription"
  ADD CONSTRAINT "prescription_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT;

-- Las recetas ya emitidas se numeran por sede en el orden en que se emitieron.
WITH numbered AS (
  SELECT id,
         row_number() OVER (PARTITION BY site_id ORDER BY issued_at, id) AS n
    FROM prescription
   WHERE status NOT IN ('DRAFT', 'DISCARDED')
)
UPDATE prescription p
   SET sequence_number = numbered.n
  FROM numbered
 WHERE p.id = numbered.id;

INSERT INTO document_counter (site_id, kind, last_number)
SELECT site_id, 'PRESCRIPTION', max(sequence_number)
  FROM prescription
 WHERE sequence_number IS NOT NULL
 GROUP BY site_id
ON CONFLICT (site_id, kind) DO UPDATE SET last_number = EXCLUDED.last_number;

ALTER TABLE "prescription"
  DROP CONSTRAINT IF EXISTS "prescription_site_number_unique";
ALTER TABLE "prescription"
  ADD CONSTRAINT "prescription_site_number_unique" UNIQUE ("site_id", "sequence_number");

-- Número exactamente cuando hay papel: emitida (o después) con número; borrador
-- o descartada sin él. Es la misma partición que `prescription_issued_coherence`.
ALTER TABLE "prescription"
  DROP CONSTRAINT IF EXISTS "prescription_number_only_when_issued";
ALTER TABLE "prescription"
  ADD CONSTRAINT "prescription_number_only_when_issued" CHECK (
    ("status" IN ('DRAFT', 'DISCARDED')) = ("sequence_number" IS NULL)
  );

-- La sede, desde la atención, siempre.
CREATE OR REPLACE FUNCTION prescription_site_from_encounter()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT e.site_id INTO NEW.site_id FROM encounter e WHERE e.id = NEW.encounter_id;
  -- Ningún número que traiga la fila sobrevive. Un borrador nace sin él; una
  -- receta que se inserta ya emitida —una importación del archivo en papel—
  -- recibe el siguiente de su sede, como si se emitiera ahora.
  IF NEW.status IN ('DRAFT', 'DISCARDED') THEN
    NEW.sequence_number := NULL;
  ELSE
    NEW.sequence_number := next_document_number(NEW.site_id, 'PRESCRIPTION');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "prescription_site_assigned" ON "prescription";
CREATE TRIGGER "prescription_site_assigned"
  BEFORE INSERT ON "prescription"
  FOR EACH ROW
  EXECUTE FUNCTION prescription_site_from_encounter();

-- El número, al emitirse; y después, inmutable igual que la sede.
CREATE OR REPLACE FUNCTION prescription_number_on_issue()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.site_id IS DISTINCT FROM OLD.site_id
     OR (OLD.sequence_number IS NOT NULL
         AND NEW.sequence_number IS DISTINCT FROM OLD.sequence_number)
     OR (OLD.sequence_number IS NULL
         AND NEW.sequence_number IS NOT NULL
         AND NOT (OLD.status = 'DRAFT' AND NEW.status NOT IN ('DRAFT', 'DISCARDED'))) THEN
    RAISE EXCEPTION
      'prescription_number_immutable: the sequential number and the site of a prescription are assigned once, at issue'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'PR-020 (Res. ACESS-2023-0030 art. 5.a.i). The number is what '
                   'the ACESS reads to detect a gap; this trigger assigns it '
                   'when the prescription is issued, and never again.';
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status NOT IN ('DRAFT', 'DISCARDED') THEN
    NEW.sequence_number := next_document_number(NEW.site_id, 'PRESCRIPTION');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "prescription_number_immutable" ON "prescription";
CREATE TRIGGER "prescription_number_immutable"
  BEFORE UPDATE ON "prescription"
  FOR EACH ROW
  EXECUTE FUNCTION prescription_number_on_issue();
