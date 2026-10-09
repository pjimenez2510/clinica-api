-- procedure_tie_keeps_exams_and_invoices
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio. Ver scripts/new-migration.mts.
--
-- Revisión de `20261009160000_billable_service_tariff_code_from_procedure`
-- (BI-257, D-179, ORD-163):
--
-- 1. LA PRESTACIÓN DE UN EXAMEN NO SE ATA A UN PROCEDIMIENTO, NI UN EXAMEN
--    SE ENLAZA A UNA PRESTACIÓN ATADA. El código del tarifario sería a la vez
--    del examen y del procedimiento, y ninguna de las dos pantallas podría
--    corregirlo.
--
-- 2. ATAR O DESATAR NO CAMBIA EL CÓDIGO QUE YA SALIÓ EN UNA FACTURA. La
--    representación impresa lee el código del tarifario de la prestación, no
--    lo congela el cargo: atar una prestación ya facturada reescribiría lo
--    que dicen sus facturas al reimprimirlas. Mientras el cargo no lo
--    congele, atar o desatar con cambio de código se rechaza si algún cargo
--    de la prestación ya está facturado.

CREATE OR REPLACE FUNCTION exam_definition_service_not_tied()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.billable_service_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM billable_service s
                  WHERE s.id = NEW.billable_service_id
                    AND s.procedure_concept_id IS NOT NULL) THEN
    RAISE EXCEPTION
      'exam_definition_service_not_tied: an exam is charged by a service of its own, never by one that charges a procedure'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'ORD-163, BI-257.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "exam_definition_service_not_tied"
  BEFORE INSERT OR UPDATE OF "billable_service_id" ON "exam_definition"
  FOR EACH ROW
  EXECUTE FUNCTION exam_definition_service_not_tied();

CREATE OR REPLACE FUNCTION billable_service_procedure_tie_admits()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.procedure_concept_id IS NOT NULL
     AND NEW.procedure_concept_id IS DISTINCT FROM OLD.procedure_concept_id
     AND EXISTS (SELECT 1 FROM exam_definition e WHERE e.billable_service_id = NEW.id) THEN
    RAISE EXCEPTION
      'billable_service_exam_not_tied: the service of an exam does not charge a procedure'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'ORD-163, BI-257.';
  END IF;
  IF NEW.procedure_concept_id IS DISTINCT FROM OLD.procedure_concept_id
     AND NEW.tariff_code IS DISTINCT FROM OLD.tariff_code
     AND EXISTS (SELECT 1 FROM charge_item c
                  WHERE c.billable_service_id = NEW.id
                    AND c.invoice_id IS NOT NULL) THEN
    RAISE EXCEPTION
      'billable_service_tariff_code_invoiced: the tariff code its invoices printed does not change by tying or untying'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'BI-257, D-179.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billable_service_procedure_tie_admits"
  BEFORE UPDATE OF "procedure_concept_id" ON "billable_service"
  FOR EACH ROW
  EXECUTE FUNCTION billable_service_procedure_tie_admits();
