-- configuration_specialties_and_durations (C1: CF-001..CF-028)
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio:
-- propone borrar lo que schema.prisma no puede describir. Ver
-- scripts/new-migration.mts.
--
-- QUÉ GARANTIZA:
--   * CF-006: no hay dos especialidades con el mismo código ni el mismo nombre
--     (insensible a mayúsculas y acentos) — índices únicos funcionales con
--     `immutable_unaccent`, la misma función de la búsqueda de pacientes.
--   * CF-005: a lo sumo UNA especialidad principal por profesional — índice
--     único parcial. El «al menos una» lo garantiza el servicio al asignar,
--     porque un CHECK no puede contar filas hermanas.
--   * CF-021/CF-022: duraciones entre 5 y 240 minutos en múltiplos de 5 —
--     CHECK, porque un `psql` a las dos de la mañana esquiva cualquier Zod.
--   * CF-026: no hay dos tipos de atención con el mismo nombre dentro de una
--     especialidad, con la misma insensibilidad.
--   * CF-003/CF-025: borrar una especialidad o un tipo referenciado falla en
--     la base (RESTRICT); el servicio lo traduce a su código estable.

-- ─── Retirada del andamiaje anterior ────────────────────────────────────────
-- `practitioner.specialty_concept_id` apuntaba a CatalogConcept y nada lo usa
-- (comprobado con grep antes de escribir esto). D-008 decidió catálogo propio:
-- dos modelos de especialidad conviviendo es una fuente de datos duplicada.

ALTER TABLE practitioner DROP COLUMN IF EXISTS specialty_concept_id;

-- ─── Especialidades (CF-001, CF-006) ────────────────────────────────────────

CREATE TABLE specialty (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  -- Código estable en inglés (D-008): contrato para RDACAA y facturación.
  code        varchar(64)  NOT NULL,
  name        varchar(160) NOT NULL,
  active      boolean      NOT NULL DEFAULT true,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX specialty_code_unique
  ON specialty (lower(code));

CREATE UNIQUE INDEX specialty_name_unique
  ON specialty (immutable_unaccent(lower(name)));

-- ─── Especialidades por profesional (CF-005) ────────────────────────────────

CREATE TABLE practitioner_specialty (
  practitioner_id uuid    NOT NULL REFERENCES practitioner (id) ON DELETE CASCADE,
  specialty_id    uuid    NOT NULL REFERENCES specialty (id) ON DELETE RESTRICT,
  is_primary      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (practitioner_id, specialty_id)
);

-- A lo sumo una principal. La fila principal es la que la agenda muestra.
CREATE UNIQUE INDEX practitioner_specialty_one_primary
  ON practitioner_specialty (practitioner_id)
  WHERE is_primary;

CREATE INDEX practitioner_specialty_by_specialty
  ON practitioner_specialty (specialty_id);

-- ─── Tipos de atención con duración base (CF-020, CF-021, CF-026) ───────────

CREATE TABLE service_type (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  specialty_id     uuid         NOT NULL REFERENCES specialty (id) ON DELETE RESTRICT,
  name             varchar(120) NOT NULL,
  duration_minutes smallint     NOT NULL,
  active           boolean      NOT NULL DEFAULT true,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),

  -- CF-021: 5..240 en múltiplos de 5. El rango es operativo, no clínico:
  -- menos de 5 no es una cita y más de 4 horas es un bloqueo, no un tipo.
  CONSTRAINT service_type_duration_range
    CHECK (duration_minutes BETWEEN 5 AND 240 AND duration_minutes % 5 = 0)
);

CREATE UNIQUE INDEX service_type_name_unique_per_specialty
  ON service_type (specialty_id, immutable_unaccent(lower(name)));

-- ─── Excepción de duración por médico (CF-022, D-007) ───────────────────────

CREATE TABLE duration_exception (
  practitioner_id  uuid     NOT NULL REFERENCES practitioner (id) ON DELETE CASCADE,
  service_type_id  uuid     NOT NULL REFERENCES service_type (id) ON DELETE CASCADE,
  duration_minutes smallint NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (practitioner_id, service_type_id),

  CONSTRAINT duration_exception_range
    CHECK (duration_minutes BETWEEN 5 AND 240 AND duration_minutes % 5 = 0)
);

-- ─── El tipo de atención QUEDA REGISTRADO EN LA CITA (SP-028, SP-025) ───────
--
-- La columna nació en `20260806022931_clinical_core` como
-- `agenda_entry.service_type_concept_id`, apuntando a `catalog_concept`: el
-- catálogo clínico del MSP. El tipo de atención con su duración es otra cosa
-- —`service_type`, dato maestro propio de la clínica (SP-020, D-010)— y con
-- aquel modelo NI SP-028 NI SP-025 podían cumplirse: la cita no podía dejar
-- registrado el tipo que la agenda resuelve, y la base no tenía forma de
-- rechazar el borrado de un tipo referenciado por una cita.
--
-- Se corrigió MOVIENDO la columna aquí en lugar de apilar un ALTER encima del
-- modelo equivocado: `scripts/database-phase.mjs` declara `development`, no
-- hay ninguna instalación en producción, y el bucle es editar el SQL y
-- `pnpm db:reset`. Aquí y no allí porque `service_type` no existe hasta esta
-- migración: una clave foránea no puede apuntar a una tabla que aún no nació.
--
-- `ON DELETE RESTRICT` es lo que produce SP-025, igual que las de `specialty`
-- producen SP-003. Es la base la que arbitra: dos administradores borrando y
-- reservando en el mismo milisegundo leen ambos «no hay citas».
ALTER TABLE agenda_entry
  ADD COLUMN service_type_id uuid
    REFERENCES service_type (id) ON DELETE RESTRICT;

-- Sin él, cada borrado de un tipo recorre `agenda_entry` entera para saber si
-- alguna cita lo referencia — y es PostgreSQL quien lo recorre, en cada
-- DELETE, mientras recepción espera.
CREATE INDEX agenda_entry_by_service_type
  ON agenda_entry (service_type_id)
  WHERE service_type_id IS NOT NULL;
