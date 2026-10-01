-- OR-030, second review of 2026-10-01. Two sites that invoice under the same
-- RUC cannot share the SRI's establishment code — compared on the RUC each
-- site REALLY invoices with: its own if it has one, else the establishment's
-- (`site.ruc ?? establishment.ruc`, as the voucher composes it).
--
-- The index of 20261001061007 compared `COALESCE(site.ruc, '')`: a site with
-- no RUC (inheriting the establishment's X) and another that writes X in its
-- own field both passed with code 001, and both numbered 001-001-000000001
-- under X — error 45 for the second, whose key can never change. An index
-- cannot read the establishment's row, so the rule moves to a trigger, under
-- an advisory lock on (effective RUC, code) so two concurrent saves cannot
-- both read «free». The error keeps the constraint's name, which
-- `organization` maps to SRI_ESTABLISHMENT_CODE_DUPLICATE.

DROP INDEX "site_sri_establishment_code_unique_per_ruc";

CREATE OR REPLACE FUNCTION site_effective_ruc(p_site_ruc TEXT, p_establishment_id UUID)
RETURNS TEXT AS $$
  -- Without any RUC the site cannot invoice; it still gets a namespace, its
  -- establishment's, so two such sites cannot pre-load the same code.
  SELECT COALESCE(
    p_site_ruc,
    (SELECT "ruc" FROM "establishment" WHERE "id" = p_establishment_id),
    'establishment:' || COALESCE(p_establishment_id::text, '')
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION trg_site_sri_code_unique_per_effective_ruc()
RETURNS TRIGGER AS $$
DECLARE
  effective TEXT;
BEGIN
  IF NEW."sri_establishment_code" IS NULL THEN
    RETURN NEW;
  END IF;
  effective := site_effective_ruc(NEW."ruc", NEW."establishment_id");
  PERFORM pg_advisory_xact_lock(hashtext('sri-estab:' || effective || ':' || NEW."sri_establishment_code"));
  IF EXISTS (
    SELECT 1 FROM "site" s
     WHERE s."id" <> NEW."id"
       AND s."sri_establishment_code" = NEW."sri_establishment_code"
       AND site_effective_ruc(s."ruc", s."establishment_id") = effective
  ) THEN
    RAISE EXCEPTION 'duplicate key value violates unique constraint "site_sri_establishment_code_unique_per_ruc"'
      USING ERRCODE = '23505',
            CONSTRAINT = 'site_sri_establishment_code_unique_per_ruc',
            HINT = 'Otra sede que factura con el mismo RUC ya tiene ese código de establecimiento SRI.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_site_sri_code_unique_per_effective_ruc
  BEFORE INSERT OR UPDATE OF "sri_establishment_code", "ruc", "establishment_id" ON "site"
  FOR EACH ROW EXECUTE FUNCTION trg_site_sri_code_unique_per_effective_ruc();

-- The establishment's RUC is half of every site's effective RUC: changing it
-- cannot make two of its sites collide either.
CREATE OR REPLACE FUNCTION trg_establishment_ruc_keeps_sri_codes_unique()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "site" a
      JOIN "site" b
        ON b."id" <> a."id"
       AND b."sri_establishment_code" = a."sri_establishment_code"
     WHERE a."establishment_id" = NEW."id"
       AND a."sri_establishment_code" IS NOT NULL
       AND site_effective_ruc(a."ruc", a."establishment_id")
         = site_effective_ruc(b."ruc", b."establishment_id")
  ) THEN
    RAISE EXCEPTION 'duplicate key value violates unique constraint "site_sri_establishment_code_unique_per_ruc"'
      USING ERRCODE = '23505',
            CONSTRAINT = 'site_sri_establishment_code_unique_per_ruc';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_establishment_ruc_keeps_sri_codes_unique
  AFTER UPDATE OF "ruc" ON "establishment"
  FOR EACH ROW EXECUTE FUNCTION trg_establishment_ruc_keeps_sri_codes_unique();
