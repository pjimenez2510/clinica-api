-- billable_service_tariff_code_from_procedure
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio. Ver scripts/new-migration.mts.
--
-- BI-257, D-179 («un dato, un sitio»). Una prestación atada a un
-- procedimiento del tarifario lleva COMO código del tarifario el de ese
-- procedimiento: la ficha decía «Código del tarifario nacional —» y, debajo,
-- «Cobra el procedimiento 11100». Atar escribe el código; con la atadura
-- puesta, el código no se escribe aparte.
--
-- Las prestaciones ya atadas (sólo datos de desarrollo) toman el código de
-- su procedimiento antes de crear la garantía.

UPDATE "billable_service" s
   SET "tariff_code" = c."code"
  FROM "catalog_concept" c
 WHERE c."id" = s."procedure_concept_id"
   AND s."tariff_code" IS DISTINCT FROM c."code";

CREATE OR REPLACE FUNCTION billable_service_tariff_code_is_its_procedure()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.procedure_concept_id IS NOT NULL
     AND NEW.tariff_code IS DISTINCT FROM
         (SELECT c.code FROM catalog_concept c WHERE c.id = NEW.procedure_concept_id) THEN
    RAISE EXCEPTION
      'billable_service_tariff_code_is_its_procedure: a service tied to a procedure carries that procedure''s tariff code'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'BI-257, D-179.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "billable_service_tariff_code_is_its_procedure"
  BEFORE INSERT OR UPDATE OF "procedure_concept_id", "tariff_code" ON "billable_service"
  FOR EACH ROW
  EXECUTE FUNCTION billable_service_tariff_code_is_its_procedure();
