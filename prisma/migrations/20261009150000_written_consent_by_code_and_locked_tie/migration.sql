-- written_consent_by_code_and_locked_tie
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio. Ver scripts/new-migration.mts.
--
-- Revisión clínica de `feat/f04-consentimiento-024` sobre
-- `20261009140000_procedure_written_consent`:
--
-- 1. LA MARCA SE BUSCA POR EL CÓDIGO DEL TARIFARIO, NO POR EL ID DEL CONCEPTO
--    (EN-152, D-159.5). Reimportar el tarifario retira los conceptos y crea
--    otros con ids nuevos: comparar por id apagaba en silencio todas las
--    marcas el día de la reimportación, con la ficha diciendo que seguían
--    puestas. Un procedimiento exige el 024 si alguna prestación marcada ata
--    un concepto del MISMO catálogo y el MISMO código, de la edición que sea.
--
-- 2. LA ATADURA DE UNA PRESTACIÓN MARCADA NO SE MUEVE NI SE BORRA (BI-256,
--    D-199.1). Re-atarla a otro concepto o borrarla, con `billing:price-manage`,
--    movía o quitaba la marca que sólo la dirección médica pone. Primero se
--    desmarca; después se cambia.
--
-- 3. UNA PRESTACIÓN POR CONCEPTO (BI-257). Con dos atadas al mismo concepto,
--    caja proponía en silencio la primera por nombre.
--
-- Nota sobre la migración anterior: su cabecera dice que el procedimiento y
-- su consentimiento se escriben «en cualquier orden». No: el consentimiento
-- va DESPUÉS del procedimiento (`trg_procedure_consent_admits` exige que
-- exista); lo que es diferido es la comprobación del procedimiento.

-- ── 1 ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION procedure_requires_written_consent(p_concept_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM catalog_concept target
      JOIN catalog_concept bound
        ON bound.system_id = target.system_id
       AND bound.code = target.code
      JOIN billable_service s ON s.procedure_concept_id = bound.id
     WHERE target.id = p_concept_id
       AND s.requires_written_consent
  );
$$;

-- ── 2 ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION billable_service_written_consent_tie_locked()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.requires_written_consent
     AND (TG_OP = 'DELETE'
          OR (NEW.requires_written_consent
              AND NEW.procedure_concept_id IS DISTINCT FROM OLD.procedure_concept_id)) THEN
    RAISE EXCEPTION
      'billable_service_written_consent_tie_locked: a service that demands the form 024 keeps its procedure; unmark it first'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'BI-256, D-199.1.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER "billable_service_written_consent_tie_locked"
  BEFORE UPDATE OF "procedure_concept_id" OR DELETE ON "billable_service"
  FOR EACH ROW
  EXECUTE FUNCTION billable_service_written_consent_tie_locked();

-- ── 3 ───────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "billable_service_one_per_procedure"
  ON "billable_service"("procedure_concept_id")
  WHERE "procedure_concept_id" IS NOT NULL;
