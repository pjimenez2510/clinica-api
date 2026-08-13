-- organization_establishment_and_emission_points (O1 y O2: OR-001..OR-026)
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio:
-- propone borrar las columnas generadas, los índices GIN y BRIN, los índices
-- únicos parciales y los disparadores, porque schema.prisma no puede
-- describirlos. Ver scripts/new-migration.mts.
--
-- QUÉ GARANTIZA:
--   * OR-001/OR-002: existe la entidad ESTABLECIMIENTO con su tipología y su
--     código único del MSP, y ese código no se repite — `NOT NULL` para lo
--     primero y un índice único para lo segundo. Hasta hoy `site` mezclaba
--     establecimiento y sede porque la clínica arranca con una sola; separarlas
--     con una fila cuesta esta migración, y con dos años de historial ya no
--     sería posible (nota de esquema del SPEC).
--   * OR-023/OR-024: los PUNTOS DE EMISIÓN del SRI viven por sede, con su
--     código de tres dígitos, sin repetirse dentro de una sede. El formato es
--     un CHECK y no solo un Zod: la facturación los leerá como dato (OR-025) y
--     un `psql` a las dos de la mañana esquiva cualquier DTO.
--   * OR-021 (AG-105): un consultorio usado en una cita DEBE ser de la sede de
--     esa cita. Hasta hoy la única garantía era un `if` en TypeScript, así que
--     una importación o un script de datos podía ocupar un recurso físico de
--     otra sede y la cita no aparecía en ninguna agenda. Ahora es una clave
--     foránea COMPUESTA `(room_id, site_id) → site_room (id, site_id)`, que
--     necesita el `UNIQUE (id, site_id)` de abajo para poder existir.
--   * OR-008: el RUC guardado tiene la FORMA de un RUC —trece dígitos que
--     terminan en un código de establecimiento— en la base. El dígito
--     verificador de las tres clases de RUC lo comprueba el value object
--     `Ruc`, porque su algoritmo no cabe en un CHECK legible.
--
-- QUÉ NO HACE FALTA AÑADIR, comprobado sobre el esquema antes de escribir esto:
--   `site` YA tiene `name`, `address_line`, `phone`, `parish_concept_id`,
--   `ruc` y `active`. OR-004 y OR-007 no necesitan columnas nuevas: lo que les
--   faltaba era un módulo dueño, que es la razón de ser de ADR-011.

-- ─── Establecimiento (OR-001, OR-002, OR-008) ───────────────────────────────

CREATE TABLE establishment (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  -- Código único del MSP. El RDACAA lo exige en CADA atención (REQ-020), así
  -- que no puede ser nulo ni repetirse.
  msp_unicode  varchar(20)  NOT NULL,
  -- Tipología del A.M. 00000079: es lo que determina qué está obligado a
  -- reportar el establecimiento.
  typology     varchar(64)  NOT NULL,
  legal_name   varchar(160) NOT NULL,
  ruc          varchar(13),
  active       boolean      NOT NULL DEFAULT true,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),

  -- OR-008: forma, no dígito verificador. Trece dígitos y un código de
  -- establecimiento a partir de 001; la validación completa del SRI —tres
  -- algoritmos distintos según el tercer dígito— vive en `Ruc`.
  CONSTRAINT establishment_ruc_format
    CHECK (ruc IS NULL OR (ruc ~ '^[0-9]{13}$' AND right(ruc, 3) <> '000'))
);

CREATE UNIQUE INDEX establishment_msp_unicode_unique
  ON establishment (msp_unicode);

-- ─── La sede pasa a colgar del establecimiento (OR-004) ─────────────────────
-- ANULABLE a propósito: las filas de `site` que ya existen no tienen
-- establecimiento y no pueden inventárselo aquí. La semilla las rellena
-- (`seed-organization.mts`), y hacerla obligatoria será una migración de un
-- renglón el día que no quede ninguna suelta.
-- RESTRICT: en un sistema clínico no se borra en cascada.

ALTER TABLE site
  ADD COLUMN establishment_id uuid
    REFERENCES establishment (id) ON DELETE RESTRICT;

CREATE INDEX site_by_establishment ON site (establishment_id);

-- La misma comprobación de forma para el RUC que factura por sede (OR-008).
ALTER TABLE site
  ADD CONSTRAINT site_ruc_format
    CHECK (ruc IS NULL OR (ruc ~ '^[0-9]{13}$' AND right(ruc, 3) <> '000'));

-- ─── Puntos de emisión del SRI (OR-023, OR-024, OR-025) ─────────────────────
-- Aquí solo son DATO: la numeración de comprobantes, la firma y el diálogo con
-- el SRI son de `billing` (REQ-085). Este módulo responde «qué puntos hay»,
-- nunca «cuál es el siguiente secuencial».

CREATE TABLE emission_point (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  site_id     uuid        NOT NULL REFERENCES site (id) ON DELETE RESTRICT,
  -- Tres dígitos del SRI. `char(3)` porque son exactamente tres y el cero a la
  -- izquierda es significativo: «001» no es 1.
  code        char(3)     NOT NULL,
  description varchar(120),
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT emission_point_code_format CHECK (code ~ '^[0-9]{3}$')
);

-- OR-024: no hay dos puntos de emisión con el mismo código dentro de una sede.
-- El nombre viaja al cliente por el mapeo de errores de PostgreSQL: es
-- contrato.
CREATE UNIQUE INDEX emission_point_code_unique_per_site
  ON emission_point (site_id, code);

-- ─── El consultorio pertenece a UNA sede, y la base lo hace cumplir ─────────
-- (OR-021 / AG-105 / D-008 punto 1)

-- Redundante como unicidad —`id` ya es la clave primaria— y obligatorio como
-- DESTINO: PostgreSQL exige que las columnas referenciadas por una clave
-- foránea compuesta tengan su propio índice único.
ALTER TABLE site_room
  ADD CONSTRAINT site_room_id_site_unique UNIQUE (id, site_id);

-- `MATCH SIMPLE` (el de por defecto) es justo lo que hace falta: con
-- `room_id` anulable, una cita SIN consultorio pasa sin comprobar nada, que es
-- lo correcto — un bloqueo de agenda no ocupa una sala. En cuanto `room_id`
-- tiene valor, el par entero debe existir en `site_room`, así que un
-- consultorio de otra sede ya no entra ni por SQL directo.
ALTER TABLE agenda_entry
  ADD CONSTRAINT agenda_entry_room_in_site
    FOREIGN KEY (room_id, site_id)
    REFERENCES site_room (id, site_id)
    MATCH SIMPLE
    ON DELETE RESTRICT;
