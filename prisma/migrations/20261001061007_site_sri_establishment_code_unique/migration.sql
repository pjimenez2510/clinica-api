-- OR-030. Two sites that invoice under the same RUC cannot share the SRI's
-- establishment code.
--
-- Each site numbers its own emission points (`emission_point_code_unique_per_site`),
-- so two sites with code `001` and a point `001` each would both issue
-- `001-001-000000001` under the same RUC: the SRI refuses the second with
-- error 45 (secuencial registrado) — after the patient already has a RIDE that
-- carries another invoice's number. Review of 2026-10-01.
--
-- The namespace is the establishment and the site's OWN RUC when it has one
-- (OR-008: a site's RUC wins over the establishment's): a site invoicing under
-- another RUC numbers its establishments in that RUC.
--
-- The code is NOT frozen once vouchers exist: a voucher takes its series from
-- its access key and never from the site (SRI-019), so correcting a wrong code
-- changes the invoices issued afterwards and none of the ones already issued.

CREATE UNIQUE INDEX "site_sri_establishment_code_unique_per_ruc"
  ON "site" ("establishment_id", COALESCE("ruc", ''), "sri_establishment_code")
  WHERE "sri_establishment_code" IS NOT NULL;
