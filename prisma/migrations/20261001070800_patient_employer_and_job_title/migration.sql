-- patient_employer_and_job_title
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy


-- QUÉ GARANTIZA: PA-061 y CER-038 (D-075). El certificado de reposo que se
-- presenta al IESS lleva la empresa y el puesto de trabajo del paciente, y se
-- leen de su ficha. Son dos datos de la ficha y no del certificado: se
-- corrigen por la ruta de corrección de `patients`, con su fila en
-- `patient_change_history`, y el siguiente certificado los vuelve a leer.
--
-- Anulables: el alta no los pide y una ficha sin ellos es válida. Quien los
-- exige es la emisión del reposo (CERTIFICATE_PATIENT_DATA_REQUIRED).
--
-- `patient_change_history_field_known` se recrea COMPLETA con los dos campos
-- nuevos al final: la lista de la última migración que la define es la que
-- `patient-corrections.spec.ts` compara con CORRECTABLE_PATIENT_FIELDS.

ALTER TABLE "patient"
  ADD COLUMN IF NOT EXISTS "employer_name" VARCHAR(160),
  ADD COLUMN IF NOT EXISTS "job_title"     VARCHAR(120);

ALTER TABLE "patient_change_history"
  DROP CONSTRAINT IF EXISTS "patient_change_history_field_known";

ALTER TABLE "patient_change_history"
  ADD CONSTRAINT "patient_change_history_field_known"
  CHECK ("field" IN (
    'familyName',
    'secondFamilyName',
    'givenName',
    'secondGivenName',
    'sex',
    'birthDate',
    'birthDateEstimated',
    'deceasedAt',
    'phone',
    'email',
    'residenceAddressLine',
    'bloodType',
    'ethnicityConceptId',
    'nationalityConceptId',
    'peopleConceptId',
    'sexualOrientationConceptId',
    'residenceParishConceptId',
    'genderIdentityConceptId',
    'countryOfNationalityCode',
    'motherPatientId',
    'employerName',
    'jobTitle'
  ));
