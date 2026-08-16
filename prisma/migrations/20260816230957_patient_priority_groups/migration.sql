-- patient_priority_groups
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- QUÉ GARANTIZA, Y POR QUÉ AQUÍ Y NO SÓLO EN LA APLICACIÓN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Los grupos de atención prioritaria del artículo 35 de la Constitución
-- (REQ-024, PA-033 a PA-039, D-026, D-027). Cada `CHECK` de abajo también lo
-- comprueba el dominio en `priority-groups.ts`, y la repetición es deliberada
-- por lo mismo que la del dígito verificador de la cédula: una importación,
-- una migración de datos o un `INSERT` por `psql` no pasan por el servicio, y
-- estos datos son de salud de categoría especial bajo la LOPDP. La aplicación
-- explica QUÉ corregir mientras el paciente sigue delante; la base es la que
-- impide que la fila exista.
--
-- Después: pnpm migrations:check && pnpm db:deploy

-- Origen del registro (PA-038): lo declaró el paciente, o consta en un
-- documento. Enumeración nativa porque son dos valores que no dependen de
-- ningún catálogo del ministerio.
CREATE TYPE "priority_group_origin" AS ENUM ('SELF_DECLARED', 'ACCREDITED');

CREATE TABLE "patient_priority_group" (
  "id"                UUID PRIMARY KEY DEFAULT uuidv7(),
  "patient_id"        UUID NOT NULL,
  "group_code"        VARCHAR(48) NOT NULL,
  "starts_on"         DATE NOT NULL,
  "ends_on"           DATE,
  "origin"            "priority_group_origin" NOT NULL,
  "evidence_document" VARCHAR(160),
  "recorded_by"       UUID NOT NULL,
  "recorded_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "closed_by"         UUID,
  "closed_at"         TIMESTAMPTZ(6),

  CONSTRAINT "patient_priority_group_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "patient"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  -- RESTRICT y no CASCADE: quien registró un grupo prioritario no desaparece
  -- del rastro porque su cuenta se borre. Las cuentas se desactivan, no se
  -- borran (AU-024), y esto es lo que lo hace cierto también aquí.
  CONSTRAINT "patient_priority_group_recorded_by_fkey"
    FOREIGN KEY ("recorded_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "patient_priority_group_closed_by_fkey"
    FOREIGN KEY ("closed_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

-- PA-035. LA EDAD NO SE GUARDA. `OLDER_ADULT` y `CHILD_OR_ADOLESCENT` se
-- derivan de `patient.birth_date` en la fecha clínica de America/Guayaquil, y
-- guardarlos sería un dato que caduca cada cumpleaños: al día siguiente de
-- cumplir 65 la ficha diría que no. Esta lista es la de grupos REGISTRABLES —
-- ocho de los diez— y por eso la columna no es un `enum` nativo: un enum
-- tendría que contener los diez y entonces permitiría escribir los derivados.
--
-- Los cuatro últimos son los de la SEGUNDA frase del artículo 35 (D-027), que
-- reciben «la misma atención prioritaria» y cuentan igual para el orden. Lo
-- que cambia es quién puede leerlos, y eso es autorización, no esquema.
ALTER TABLE "patient_priority_group"
  ADD CONSTRAINT "patient_priority_group_recordable"
  CHECK ("group_code" IN (
    'PREGNANT',
    'DISABILITY',
    'DEPRIVED_OF_LIBERTY',
    'CATASTROPHIC_ILLNESS',
    'AT_RISK',
    'DOMESTIC_OR_SEXUAL_VIOLENCE_VICTIM',
    'CHILD_ABUSE_VICTIM',
    'DISASTER_VICTIM'
  ));

-- Un periodo que termina antes de empezar no es un periodo. Inclusivo por los
-- dos lados: «hasta el 15» cubre el 15, y PA-036 dice que deja de contar
-- MIENTRAS la fecha esté EN EL PASADO.
ALTER TABLE "patient_priority_group"
  ADD CONSTRAINT "patient_priority_group_period_valid"
  CHECK ("ends_on" IS NULL OR "ends_on" >= "starts_on");

-- PA-036. EL EMBARAZO CADUCA SOLO, y para eso tiene que tener fin. Sin fecha
-- probable de parto ni fecha de fin, la fila ordenaría la lista de espera para
-- siempre — que es exactamente la columna booleana `embarazada` que este
-- diseño existe para no tener. HL7 FHIR lo modela como `Observation`, una
-- valoración fechada, y advierte de que no se capture como `Condition`.
ALTER TABLE "patient_priority_group"
  ADD CONSTRAINT "patient_priority_group_pregnancy_has_end"
  CHECK ("group_code" <> 'PREGNANT' OR "ends_on" IS NOT NULL);

-- PA-038. «Acreditado» sin decir con qué documento no es acreditado: es una
-- declaración con otro nombre. El `btrim` es lo que impide que un espacio en
-- blanco satisfaga la exigencia.
ALTER TABLE "patient_priority_group"
  ADD CONSTRAINT "patient_priority_group_evidence_required"
  CHECK (
    "origin" <> 'ACCREDITED'
    OR ("evidence_document" IS NOT NULL AND length(btrim("evidence_document")) > 0)
  );

-- PA-039 aplicado al cierre: quién y cuándo van juntos o no van. Una fila con
-- `closed_at` y sin `closed_by` diría que se cerró sin decir quién, que es
-- justo lo que el requisito impide.
ALTER TABLE "patient_priority_group"
  ADD CONSTRAINT "patient_priority_group_closure_complete"
  CHECK (("closed_by" IS NULL) = ("closed_at" IS NULL));

-- La consulta que se hace en cada listado: los grupos de ESTE paciente, y de
-- ahí se filtra el periodo.
CREATE INDEX "patient_priority_group_patient_id_starts_on_idx"
  ON "patient_priority_group" ("patient_id", "starts_on");
