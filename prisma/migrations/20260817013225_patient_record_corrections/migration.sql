-- patient_record_corrections
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- QUÉ TRAE, Y POR QUÉ LAS TRES COSAS VIENEN JUNTAS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La entrega P2 de `patients` abre la primera ruta de ESCRITURA del registro
-- que no es el alta. Hasta hoy un apellido mal tecleado en el mostrador era
-- permanente, y eso hacía imposible el derecho de rectificación (REQ-113).
-- Corregir necesita tres garantías que no existían:
--
--   1. `patient_change_history` — dónde queda «desde qué valor» (PA-031).
--   2. `patient_deceased_after_birth` — un fallecimiento anterior al
--      nacimiento no debe poder existir (PA-008).
--   3. `patient_mother_not_self` — una ficha no es su propia madre (PA-009).
--
-- Las dos últimas son `CHECK` y no validación de servicio por lo mismo que el
-- dígito verificador de la cédula: una importación, una migración de datos o
-- un `INSERT` por `psql` no pasan por el DTO.
--
-- Después: pnpm migrations:check && pnpm db:deploy


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. EL HISTÓRICO DE CORRECCIONES DE LA FICHA (PA-031, D-032, REQ-113)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- POR QUÉ UNA TABLA PROPIA Y NO `access_audit`. La alternativa evidente era
-- ampliar `access_audit_payload_only_for_declared_resources` para admitir
-- `'patient'` y reutilizar las columnas `before`/`after` que D-017 ya añadió.
-- D-032 la descartó el 16-08-2026, y el motivo es exactamente lo que aquella
-- migración dejó escrito: `access_audit` es APPEND-ONLY y NO SE PURGA NUNCA.
-- Un apellido anterior, un documento anterior o una fecha de nacimiento
-- anterior que cayeran ahí no se podrían corregir, minimizar ni eliminar
-- jamás — lo contrario de lo que la LOPDP exige en REQ-113. Y como fallar al
-- registrar no lanza (ver `AccessAuditRecorder.record`), la fila se habría
-- perdido en silencio.
--
-- Cada tabla con su régimen: la bitácora de accesos vigila QUIÉN MIRA y por
-- eso es inmutable; este histórico guarda QUÉ CAMBIÓ y por eso tiene que
-- poder rectificarse. Una corrección escribe en las DOS: una fila de
-- `access_audit` con `action = 'UPDATE'` y sin payload, y una fila aquí por
-- cada campo que cambió.
--
-- ⚠️ ESTA ES LA ÚNICA TABLA DE RASTRO DEL SISTEMA QUE NO LLEVA DISPARADOR DE
-- INMUTABILIDAD, Y ES DELIBERADO. `access_audit`, `patient_merge`,
-- `agenda_entry_status_history` y la cadena de notas firmadas sí lo llevan.
-- Quien copie esta tabla como plantilla para el rastro de otra cosa se estará
-- llevando justo lo contrario de lo que necesita.
--
-- UNA FILA POR CAMPO, no una por corrección con un JSON. Dos razones, y la
-- segunda es la que decide: responder «¿quién cambió el apellido y desde qué
-- valor?» es una consulta y no un recorrido de documentos; y cuando el
-- titular ejerza rectificación o supresión sobre UN dato, lo que hay que
-- borrar es una fila, no editar un JSON dentro de otra fila que también
-- guarda datos de la misma persona que sí hay que conservar.

CREATE TABLE "patient_change_history" (
  "id"           UUID PRIMARY KEY DEFAULT uuidv7(),
  "patient_id"   UUID NOT NULL,

  -- Qué campo cambió, con el nombre del DOMINIO y no el de la columna: es lo
  -- que viaja en el contrato y lo que una pantalla puede traducir. La lista
  -- se repite aquí abajo en un CHECK.
  "field"        VARCHAR(64) NOT NULL,

  -- Los dos valores como texto. Fechas, uuid y enumeraciones caben todas, y
  -- un tipo por campo obligaría a una columna por tipo o a un JSON, que es lo
  -- que esta tabla evita. NULL significa «no tenía valor» / «se dejó vacío»,
  -- que es un cambio real y hay que poder registrarlo.
  "value_before" TEXT,
  "value_after"  TEXT,

  "changed_by"   UUID NOT NULL,
  "changed_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "patient_change_history_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "patient"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  -- RESTRICT y no CASCADE: quien corrigió una ficha no desaparece del rastro
  -- porque su cuenta se borre. Las cuentas se desactivan, no se borran
  -- (AU-024), y esto es lo que lo hace cierto también aquí.
  CONSTRAINT "patient_change_history_changed_by_fkey"
    FOREIGN KEY ("changed_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

-- QUÉ ES CORREGIBLE, dicho por la base y no por una convención.
--
-- El `mrn` NO está y no debe estarlo: PA-002 dice que no cambia nunca, así que
-- una fila que dijera que cambió sería un rastro de algo que el sistema no
-- permite. Tampoco están `is_provisional` ni `merged_into_id`, que no se
-- corrigen: los mueven PA-015 y la fusión, cada uno con su propio rastro.
--
-- La lista se repite en `patient-corrections.ts`. La repetición es la misma
-- que la del subconjunto registrable de grupos prioritarios y la del dígito
-- verificador de la cédula: el servicio explica qué corregir mientras el
-- paciente sigue delante, la base impide que la fila exista.
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
    'residenceParishConceptId',
    'genderIdentityConceptId',
    'motherPatientId'
  ));

-- Una fila que dice que algo cambió y enseña el mismo valor a los dos lados no
-- es un rastro: es ruido que hace más difícil encontrar el cambio que se
-- busca. `IS DISTINCT FROM` y no `<>` porque uno de los dos lados puede ser
-- NULL, y `NULL <> 'x'` es NULL, que un CHECK acepta.
ALTER TABLE "patient_change_history"
  ADD CONSTRAINT "patient_change_history_value_changed"
  CHECK ("value_before" IS DISTINCT FROM "value_after");

-- La pregunta que esta tabla existe para responder es siempre «¿qué le pasó a
-- ESTA ficha?», y la respuesta se lee de lo más reciente a lo más antiguo.
CREATE INDEX "patient_change_history_patient_changed_idx"
  ON "patient_change_history" ("patient_id", "changed_at" DESC);

COMMENT ON TABLE "patient_change_history" IS
  'PA-031, D-032. Qué cambió en una ficha, desde qué valor, quién y cuándo. '
  'RECTIFICABLE A PROPÓSITO: no lleva disparador de inmutabilidad porque '
  'guarda contenido de la ficha y REQ-113 obliga a poder corregirlo y '
  'eliminarlo. La bitácora de accesos (access_audit) es la inmutable, y por '
  'eso no admite este contenido.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. UN FALLECIMIENTO NO PUEDE SER ANTERIOR AL NACIMIENTO (PA-008)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `patient.deceased_at` existe desde la primera migración y hasta P2 ninguna
-- ruta lo escribía: era siempre NULL, así que nada podía contradecirlo. Con
-- ruta de escritura, un año mal tecleado —2016 por 2026— produce una ficha
-- que dice que la persona murió diez años antes de nacer, y con ella una edad
-- negativa en el reporte al ministerio.
--
-- LA CONVERSIÓN DE HUSO NO ES ADORNO. `deceased_at` es `timestamptz` y
-- `birth_date` es `date`. Comparar los dos obliga a decidir en qué día cae el
-- instante, y `::date` a secas usa el huso de la SESIÓN: a las 21:00 de
-- Guayaquil ya es el día siguiente en UTC. Sobre un neonato que nace y muere
-- el mismo día, ese desplazamiento es la diferencia entre aceptar la fila y
-- rechazarla. Es el mismo defecto que
-- 20260806040611_clinical_date_in_ecuador_timezone corrigió en
-- `encounter_freeze_age`.
--
-- `timezone(text, timestamptz)` es IMMUTABLE —el huso va escrito, no se lee
-- de la sesión—, que es lo que permite usarlo dentro de un CHECK.
ALTER TABLE "patient"
  ADD CONSTRAINT "patient_deceased_after_birth"
  CHECK (
    "deceased_at" IS NULL
    OR ("deceased_at" AT TIME ZONE 'America/Guayaquil')::date >= "birth_date"
  );

COMMENT ON CONSTRAINT "patient_deceased_after_birth" ON "patient" IS
  'PA-008. La fecha de fallecimiento, resuelta en America/Guayaquil, no puede '
  'ser anterior al nacimiento.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. UNA FICHA NO ES SU PROPIA MADRE (PA-009)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `mother_patient_id` existe desde la primera migración con su clave foránea,
-- y una clave foránea a la misma tabla acepta encantada que la fila se apunte
-- a sí misma. P2 abre la ruta que lo escribe, y el vínculo existe para
-- ENCONTRAR al recién nacido a través de su madre: una ficha que es su propia
-- madre convierte esa búsqueda en un ciclo y, peor, hace pasar por vínculo
-- comprobado lo que es un clic en la fila equivocada.
ALTER TABLE "patient"
  ADD CONSTRAINT "patient_mother_not_self"
  CHECK ("mother_patient_id" IS NULL OR "mother_patient_id" <> "id");

COMMENT ON CONSTRAINT "patient_mother_not_self" ON "patient" IS
  'PA-009. Una ficha no puede ser su propia madre.';
