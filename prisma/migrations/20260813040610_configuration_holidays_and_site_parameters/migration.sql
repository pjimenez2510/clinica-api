-- configuration_holidays_and_site_parameters (C3: CF-060..CF-066)
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio:
-- propone borrar las columnas generadas, los índices GIN y BRIN, los índices
-- únicos parciales y los disparadores, porque schema.prisma no puede
-- describirlos. Ver scripts/new-migration.mts.
--
-- QUÉ GARANTIZA:
--   * CF-060: existen los FERIADOS con fecha, nombre y ALCANCE — una sede
--     (`site_id`) o todas (`site_id IS NULL`). El alcance es una columna
--     anulable y no dos tablas porque es la misma cosa mirada con distinto
--     radio, y la agenda tendrá que leer las dos en una sola consulta.
--   * CF-061: no hay dos feriados con la misma fecha y el mismo alcance, y la
--     garantía vive AQUÍ. Un `UNIQUE (date, site_id)` corriente NO sirve para
--     el caso «todas las sedes»: en PostgreSQL dos NULL nunca son iguales, así
--     que «1 de enero, todas las sedes» podría insertarse cien veces sin que
--     el índice dijera nada — que es justo la fila que más daño hace, porque
--     la obedecen todas las sedes. Se usa `UNIQUE NULLS NOT DISTINCT`, que
--     existe desde PostgreSQL 15 y esta instalación es la 18: trata los NULL
--     como iguales entre sí y cubre los dos alcances con UN solo índice. La
--     alternativa clásica —dos índices parciales, uno `WHERE site_id IS NULL`
--     y otro `WHERE site_id IS NOT NULL`— haría lo mismo con el doble de
--     objetos y con dos nombres de constraint distintos viajando al cliente.
--   * CF-062: cada sede tiene sus cuatro parámetros de D-001 con los valores
--     por defecto de esa decisión, y los tiene DESDE QUE SE CREA. El defecto
--     no lo escribe `organization` al dar de alta la sede: lo escribe un
--     disparador, porque el módulo dueño de la sede no debe conocer los
--     parámetros de otro módulo (ADR-011) y porque una importación de datos o
--     un `INSERT` a mano dejaría igualmente la sede sin parámetros.
--   * CF-065: los rangos son CHECK. El DTO los comprueba antes y responde
--     `PARAM_OUT_OF_RANGE` nombrando el rango, pero un DTO no protege a la
--     base de un `psql` a las dos de la mañana ni de un script de migración de
--     datos, y un tope de sobrecupos negativo no es un número raro: es la
--     agenda calculando con él.
--
-- POR QUÉ ESTAS DOS TABLAS SÍ BORRAN EN CASCADA, contra la regla general de
-- `ON DELETE RESTRICT` de este esquema. Un feriado de una sede y los
-- parámetros de una sede no son historia clínica ni evidencia de nada: no los
-- referencia ninguna otra fila, no tienen sentido separados de su sede, y con
-- RESTRICT ninguna sede podría borrarse jamás — el disparador de abajo le crea
-- la fila de parámetros a TODAS, así que OR-006 («borrar una sede que nadie
-- referencia») dejaría de poder cumplirse el día que se aplique esta
-- migración. La cascada aquí no pierde información; RESTRICT rompería un
-- requisito ya construido y probado.

-- ─── Feriados (CF-060, CF-061) ──────────────────────────────────────────────

CREATE TABLE holiday (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),

  -- `date` y no `timestamptz`: un feriado es un día del calendario civil, no
  -- un instante. Guardarlo como instante obligaría a elegir una hora y a
  -- resolverla luego en `America/Guayaquil` para saber de qué día se trataba,
  -- que es exactamente el fallo que ADR-001 §5 documenta.
  date       date         NOT NULL,
  name       varchar(160) NOT NULL,

  -- El ALCANCE de CF-060. NULL = todas las sedes.
  site_id    uuid REFERENCES site (id) ON DELETE CASCADE,

  created_at timestamptz  NOT NULL DEFAULT now(),
  updated_at timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT holiday_name_not_blank CHECK (btrim(name) <> ''),

  -- CF-061. El nombre viaja al cliente a través del mapeo de errores de
  -- PostgreSQL, así que es parte del contrato.
  CONSTRAINT holiday_date_scope_unique UNIQUE NULLS NOT DISTINCT (date, site_id)
);

-- La consulta que hace la pantalla y la que hará la agenda: los feriados de un
-- año, los de la sede y los de todas.
CREATE INDEX holiday_by_date ON holiday (date);
CREATE INDEX holiday_by_site ON holiday (site_id) WHERE site_id IS NOT NULL;

COMMENT ON TABLE holiday IS
  'Días no laborables con alcance: una sede (site_id) o todas (site_id NULL). '
  'La agenda los OBEDECE; aquí sólo se administran (ADR-011).';

-- ─── Política de retención de anuladas (D-001, D-004) ───────────────────────
-- Un tipo enumerado con UN SOLO VALOR hoy, y eso es deliberado. D-004 decidió
-- que el sistema NO BORRA historia clínica y D-001 eligió «no borrar» para las
-- citas anuladas, así que `NEVER` es la única política que existe. Se modela
-- como enumeración y no como booleano `purga_sí/no` para que añadir mañana un
-- `PURGE_AFTER_DAYS` sea `ALTER TYPE … ADD VALUE` y una columna nueva —una
-- migración de dos renglones— y no reescribir la columna, sus CHECK y todas
-- las filas. Un booleano habría cerrado esa puerta.

CREATE TYPE cancelled_retention_policy AS ENUM ('NEVER');

COMMENT ON TYPE cancelled_retention_policy IS
  'Qué se hace con las citas anuladas. Hoy sólo NEVER (D-001, D-004): el '
  'sistema no borra. Una política de purgado futura se añade con ALTER TYPE.';

-- ─── Parámetros por sede (CF-062, CF-065) ───────────────────────────────────

CREATE TABLE site_parameter (
  -- La clave primaria ES la sede: una fila por sede, ni dos ni ninguna. Un
  -- `id` propio con un UNIQUE encima habría dicho lo mismo con una columna
  -- más y una forma de equivocarse más.
  site_id             uuid PRIMARY KEY REFERENCES site (id) ON DELETE CASCADE,

  -- Los cuatro valores de D-001, con sus defectos.
  min_lead_minutes    int  NOT NULL DEFAULT 0,
  max_lead_days       int  NOT NULL DEFAULT 180,
  overbooking_cap     int  NOT NULL DEFAULT 2,
  cancelled_retention cancelled_retention_policy NOT NULL DEFAULT 'NEVER',

  -- ─── D-021: EL ÁTOMO DE LA AGENDA (14-08-2026) ───────────────────────────
  --
  -- QUÉ ES. El incremento en que se trocea la jornada de esta sede. Todos los
  -- cupos que la agenda ofrece duran esto, y toda duración configurable —la
  -- base de un especialidad·tipo y la excepción de un médico— tiene que ser
  -- múltiplo suyo. Por eso «átomo»: es la unidad indivisible de la que se
  -- componen las demás.
  --
  -- POR QUÉ SUBE HASTA AQUÍ. Vivía en `practitioner_schedule_rule.slot_minutes`
  -- —un número libre POR REGLA— junto a otro número libre por especialidad·tipo
  -- que tenía que casar con él, y nada los obligaba. La base ya tenía rejillas
  -- de 20 y de 30 con tipos de 10, 20 y 30: un tipo de 20 sobre un médico de
  -- cupos de 30 era imposible de reservar (AG-012 lo rechaza) y ninguna
  -- pantalla lo cruzaba. La práctica establecida —American College of
  -- Physicians, y toda la literatura de scheduling ambulatorio— es un
  -- incremento pequeño y ÚNICO del que todas las citas son múltiplos.
  --
  -- POR QUÉ 10 DE DEFECTO. Es el único de la banda estándar (10, 15, 20) del
  -- que son múltiplos las tres duraciones ya configuradas —10, 20 y 30—, así
  -- que ningún dato existente queda incoherente al migrar.
  slot_atom_minutes   int  NOT NULL DEFAULT 10,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- CF-065. Los topes superiores no son adorno: 7 días de antelación mínima ya
  -- impide agendar al paciente que está en el mostrador, 2 años de antelación
  -- máxima excede cualquier agenda que exista, y un tope de 20 sobrecupos
  -- convierte el sobrecupo en la vía normal. Un rango que nadie puede alcanzar
  -- no es un rango.
  CONSTRAINT site_parameter_min_lead_minutes_range
    CHECK (min_lead_minutes BETWEEN 0 AND 10080),
  CONSTRAINT site_parameter_max_lead_days_range
    CHECK (max_lead_days BETWEEN 1 AND 730),
  CONSTRAINT site_parameter_overbooking_cap_range
    CHECK (overbooking_cap BETWEEN 0 AND 20),

  -- D-021. De 5 a 60 minutos y de cinco en cinco.
  --
  -- EL PASO DE 5 NO ES CEREMONIA: es lo que mantiene verdadero el `CHECK` que
  -- la base SÍ puede expresar sobre las duraciones. `service_type_duration_range`
  -- y `duration_exception_range` exigen múltiplos de 5, y un `CHECK` no puede
  -- consultar `site_parameter` para exigir el múltiplo del átomo. Con el átomo
  -- restringido a múltiplos de 5, la regla local de esas dos tablas deja de ser
  -- un resto contradictorio y pasa a ser una CONSECUENCIA de la regla fina que
  -- hace cumplir la aplicación. Los extremos: por debajo de 5 la rejilla es
  -- ruido —una agenda de 1 minuto no la opera nadie— y por encima de 60 no hay
  -- ninguna banda documentada, y la banda estándar (10, 15, 20) cae dentro.
  CONSTRAINT site_parameter_slot_atom_minutes_range
    CHECK (slot_atom_minutes BETWEEN 5 AND 60 AND slot_atom_minutes % 5 = 0),

  -- Coherencia entre los dos: una antelación mínima mayor que la máxima deja
  -- la sede sin ninguna hora reservable, y la agenda no tendría cómo
  -- explicárselo a recepción.
  CONSTRAINT site_parameter_lead_window_coherent
    CHECK (min_lead_minutes <= max_lead_days * 1440)
);

COMMENT ON TABLE site_parameter IS
  'Parámetros de operación de una sede (D-001). Sólo números que cambian el '
  'comportamiento y que ninguna fila referencia; lo que el expediente, la '
  'factura o el reporte al Estado citan NO es un parámetro (ADR-011).';

-- ─── El defecto se escribe al crear la sede (CF-062) ────────────────────────
-- En la base y no en `OrganizationService`, por dos razones que se refuerzan:
-- ADR-011 prohíbe que el módulo dueño de la sede conozca las tablas de
-- `configuration`, y una sede creada por una importación, una semilla o un
-- `INSERT` a mano tendría que quedar igual de parametrizada — si no, la agenda
-- se encuentra una sede sin parámetros y tiene que inventarse qué hacer.
--
-- `ON CONFLICT DO NOTHING`: idempotente, para que un `INSERT … RETURNING`
-- repetido o una restauración parcial no falle por una fila que ya está.

CREATE OR REPLACE FUNCTION site_parameter_write_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO site_parameter (site_id)
  VALUES (NEW.id)
  ON CONFLICT (site_id) DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_site_parameter_defaults
  AFTER INSERT ON site
  FOR EACH ROW
  EXECUTE FUNCTION site_parameter_write_defaults();

-- Las sedes que ya existen. Sin esto, CF-062 sería cierto sólo para las sedes
-- creadas a partir de hoy, y la pantalla respondería 404 en las de siempre.
INSERT INTO site_parameter (site_id)
SELECT id FROM site
ON CONFLICT (site_id) DO NOTHING;
