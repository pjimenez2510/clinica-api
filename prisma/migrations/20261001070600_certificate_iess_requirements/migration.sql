-- certificate_iess_requirements
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy


-- QUÉ GARANTIZA (D-075, resuelta por el autor el 30-09-2026):
--
--  · CER-034: el tipo de contingencia del reposo —enfermedad general,
--    accidente de trabajo, enfermedad profesional, maternidad—. Un enum y no
--    un texto: la lista sale del IESS y un valor fuera de ella es un
--    certificado que el IESS devuelve. Un certificado de asistencia NO la
--    lleva (`medical_certificate_contingency_only_on_rest`). Que el reposo la
--    lleve SIEMPRE lo garantiza el servicio y no la base: los reposos que ya
--    existan se emitieron sin ella, y rellenarla sería inventar un dato
--    clínico-administrativo.
--  · CER-035: con maternidad, las fechas de ingreso, parto y alta, las tres
--    juntas exactamente cuando la contingencia es MATERNITY.
--  · CER-030: el motivo de un reposo que empieza antes del día clínico de la
--    atención. Cuándo se exige no lo puede decir un CHECK sin leer la
--    atención, así que lo exige el servicio; la base sólo impide guardarlo en
--    blanco.

DO $$
BEGIN
  CREATE TYPE "certificate_contingency_type" AS ENUM (
    'GENERAL_ILLNESS', 'WORK_ACCIDENT', 'OCCUPATIONAL_DISEASE', 'MATERNITY'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "medical_certificate"
  ADD COLUMN IF NOT EXISTS "contingency_type"       "certificate_contingency_type",
  ADD COLUMN IF NOT EXISTS "maternity_admission_on" DATE,
  ADD COLUMN IF NOT EXISTS "birth_on"               DATE,
  ADD COLUMN IF NOT EXISTS "maternity_discharge_on" DATE,
  ADD COLUMN IF NOT EXISTS "rest_backdating_reason" TEXT;

ALTER TABLE "medical_certificate"
  DROP CONSTRAINT IF EXISTS "medical_certificate_contingency_only_on_rest";
ALTER TABLE "medical_certificate"
  ADD CONSTRAINT "medical_certificate_contingency_only_on_rest" CHECK (
    "type" = 'MEDICAL_REST' OR "contingency_type" IS NULL
  );

ALTER TABLE "medical_certificate"
  DROP CONSTRAINT IF EXISTS "medical_certificate_maternity_dates_together";
ALTER TABLE "medical_certificate"
  ADD CONSTRAINT "medical_certificate_maternity_dates_together" CHECK (
    ("contingency_type" IS NOT DISTINCT FROM 'MATERNITY') = (
      "maternity_admission_on" IS NOT NULL
      AND "birth_on" IS NOT NULL
      AND "maternity_discharge_on" IS NOT NULL
    )
    AND ("maternity_admission_on" IS NULL) = ("birth_on" IS NULL)
    AND ("birth_on" IS NULL) = ("maternity_discharge_on" IS NULL)
  );

ALTER TABLE "medical_certificate"
  DROP CONSTRAINT IF EXISTS "medical_certificate_backdating_reason_not_blank";
ALTER TABLE "medical_certificate"
  ADD CONSTRAINT "medical_certificate_backdating_reason_not_blank" CHECK (
    "rest_backdating_reason" IS NULL OR btrim("rest_backdating_reason") <> ''
  );
