-- practitioner_emergency_contact_phone
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- QUÉ GARANTIZA (PR-040, ST-049): que la receta pueda llevar el «número de
-- contacto permanente del prescriptor» del art. 5.e.vi de la Res.
-- ACESS-2023-0030. Ni `app_user` ni `practitioner` tenían teléfono, y
-- `site.phone` no sirve: la norma dice «del prescriptor», y lo que el paciente
-- tiene que hacer a las tres de la mañana ante un signo de alarma es llamar a
-- alguien que conteste.
--
-- Es del PERFIL CLÍNICO y no de la cuenta: una recepcionista tiene cuenta y no
-- receta. NULL es legítimo —un patólogo no receta—, y es la emisión la que lo
-- exige (PRESCRIBER_CONTACT_REQUIRED).
--
-- La forma la comprueba la base además del DTO: un `psql` o una importación no
-- pueden dejar «llamar a la clínica» donde va un número.

ALTER TABLE "practitioner"
  ADD COLUMN IF NOT EXISTS "emergency_contact_phone" VARCHAR(16);

ALTER TABLE "practitioner"
  DROP CONSTRAINT IF EXISTS "practitioner_emergency_contact_phone_format";
ALTER TABLE "practitioner"
  ADD CONSTRAINT "practitioner_emergency_contact_phone_format" CHECK (
    "emergency_contact_phone" IS NULL
    OR "emergency_contact_phone" ~ '^\+?[0-9]{7,15}$'
  );
