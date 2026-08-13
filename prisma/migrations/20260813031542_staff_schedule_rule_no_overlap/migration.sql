-- staff_schedule_rule_no_overlap
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- La garantía que le faltaba a `practitioner_schedule_rule`: dos reglas
-- vigentes del MISMO profesional, en la MISMA sede y el MISMO día de la semana
-- no pueden solaparse en horas (ST-042, que implementa AG-106).
--
-- POR QUÉ EN LA BASE Y NO EN EL SERVICIO. Es exactamente la carrera de la
-- agenda: dos administradores editan el horario del mismo médico, los dos leen
-- «no hay solape» y los dos escriben. Un `SELECT ... WHERE NOT EXISTS` seguido
-- de un `INSERT` pasa todas las pruebas secuenciales y aun así deja dos reglas
-- solapadas — y una rejilla de cupos derivada de dos reglas solapadas ofrece el
-- mismo minuto dos veces, con dos duraciones distintas.
--
-- POR QUÉ HAY QUE RANGIFICAR. `start_time` y `end_time` son `time` —la única
-- excepción deliberada a `timestamptz`, porque son hora de pared y no
-- instantes— y PostgreSQL no trae `timerange`. El operador `&&` que necesita
-- el EXCLUDE sólo existe sobre rangos, así que la franja se convierte a
-- minutos desde medianoche y se guarda como `int4range`. La vigencia ya vive
-- en dos columnas `date`, así que se rangifica igual, en `daterange`.
--
-- Las dos columnas son GENERATED ... STORED: derivadas, nunca escritas por la
-- aplicación, y STORED porque PostgreSQL 18 no indexa ni restringe columnas
-- virtuales. Se declaran en schema.prisma como `Unsupported(...)` para que
-- Prisma no las lea como sobrantes y proponga borrarlas, igual que
-- `catalog_concept.valid_period`.

-- ===========================================================================
-- 1. La franja horaria como rango de minutos
-- ===========================================================================

-- `EXTRACT(... FROM time)` es IMMUTABLE —`extract(text, time without time
-- zone)` lo es en el catálogo, a diferencia de su hermana sobre `timestamptz`,
-- que es STABLE porque depende de `TimeZone`—, y sin inmutabilidad PostgreSQL
-- rechazaría la columna generada de plano. Se comprobó contra el catálogo de
-- esta misma base antes de escribir esto.
--
-- `'[)'`, medio abierto, como los `tstzrange` de la agenda: una regla de
-- 08:00–12:00 y otra de 12:00–16:00 son contiguas, no solapadas. Con `'[]'` el
-- turno de la tarde chocaría con el de la mañana por el minuto exacto en que
-- uno acaba y el otro empieza, que es el reparto más normal de una consulta.
--
-- POR QUÉ `greatest(...)` Y NO EL FIN A SECAS. Una columna generada se calcula
-- ANTES que los CHECK de la fila, y `int4range(720, 480)` no devuelve un rango
-- inválido: lanza `22000 range lower bound must be less than or equal to range
-- upper bound`. Es decir, una regla invertida dejaba de responder
-- `schedule_rule_time_order` —el CHECK que existe justamente para explicarlo—
-- y pasaba a responder un error de rango que no nombra ni el campo ni el
-- arreglo. Se descubrió en la suite de integración, no razonando. Con
-- `greatest` la regla invertida produce un rango VACÍO: no solapa con nada, así
-- que el EXCLUDE la ignora, y el CHECK vuelve a ser quien la rechaza y quien lo
-- explica.
ALTER TABLE practitioner_schedule_rule
  ADD COLUMN minutes_range int4range
  GENERATED ALWAYS AS (
    int4range(
      (EXTRACT(HOUR FROM start_time) * 60 + EXTRACT(MINUTE FROM start_time))::int,
      greatest(
        (EXTRACT(HOUR FROM start_time) * 60 + EXTRACT(MINUTE FROM start_time))::int,
        (EXTRACT(HOUR FROM end_time) * 60 + EXTRACT(MINUTE FROM end_time))::int
      ),
      '[)'
    )
  ) STORED;

COMMENT ON COLUMN practitioner_schedule_rule.minutes_range IS
  'Derivada de start_time/end_time: minutos desde medianoche, medio abierta. '
  'Existe para que el EXCLUDE de ST-042 pueda usar &&, que no opera sobre time.';

-- ===========================================================================
-- 2. La vigencia como daterange
-- ===========================================================================

-- `'[]'` Y NO `'[)'`, A DIFERENCIA DE LA FRANJA HORARIA. `valid_to` YA
-- significa en este sistema «el último día en que la regla rige»: la agenda lo
-- lee así desde E1 (`slot-availability.ts`: `date <= rule.validTo`). Escribir
-- aquí un rango medio abierto habría creado dos verdades sobre la misma
-- columna — el EXCLUDE dejaría pasar dos reglas que la agenda considera
-- vigentes el mismo día — y esa clase de desacuerdo no la detecta nadie hasta
-- que una pantalla ofrece un cupo que la reserva rechaza. PostgreSQL normaliza
-- `[a,b]` sobre tipos discretos a `[a,b+1)`, así que el rango almacenado es
-- canónico igual. `valid_to` NULL sigue significando «sin cota superior».
ALTER TABLE practitioner_schedule_rule
  ADD COLUMN validity daterange
  GENERATED ALWAYS AS (daterange(valid_from, valid_to, '[]')) STORED;

COMMENT ON COLUMN practitioner_schedule_rule.validity IS
  'Derivada de valid_from/valid_to. valid_to es el ÚLTIMO día en que la regla '
  'rige, inclusive, como lo lee la agenda; NULL significa que sigue vigente.';

-- Un rango vacío no solapa con nada, así que sin este CHECK una regla con
-- `valid_to < valid_from` esquivaría el EXCLUDE por completo y además no
-- ofrecería un solo cupo: sería una regla que la base acepta y que no significa
-- nada. Con la cota superior inclusiva, `valid_to = valid_from` es legítimo y
-- significa «un solo día». Mismo razonamiento que
-- `catalog_concept_period_not_empty`.
ALTER TABLE practitioner_schedule_rule
  ADD CONSTRAINT schedule_rule_validity_not_empty CHECK (
    valid_to IS NULL OR valid_to >= valid_from
  );

-- ===========================================================================
-- 3. ST-045 — el turno tiene que caber al menos una vez
-- ===========================================================================

-- `schedule_rule_slot_positive` ya prohíbe un turno de cero minutos y
-- `schedule_rule_time_order` que la franja esté invertida. Faltaba lo que une
-- a los dos: una regla de 08:00–08:15 con turnos de 20 minutos es
-- representable, pasa ambos CHECK y no produce NI UN cupo. En pantalla se ve
-- como un médico sin agenda y nada dice por qué.
--
-- POR QUÉ EMPIEZA POR `end_time <= start_time`. Sin esa salida, una franja
-- invertida —12:00 a 08:00— también incumple ESTE CHECK, y PostgreSQL reporta
-- el que evalúa primero. El nombre de la restricción es contrato: viaja al
-- cliente y elige el mensaje, así que una franja invertida acabaría diciéndole
-- al administrador «los turnos no caben» en lugar de «la hora de fin debe ser
-- posterior a la de inicio» — un consejo correcto sobre el campo equivocado.
-- Cada CHECK responde de lo suyo; de la inversión responde
-- `schedule_rule_time_order`, que ya existe y ya la rechaza.
ALTER TABLE practitioner_schedule_rule
  ADD CONSTRAINT schedule_rule_slot_fits CHECK (
    end_time <= start_time
    OR EXTRACT(EPOCH FROM (end_time - start_time)) >= slot_minutes * 60
  );

-- ===========================================================================
-- 4. ST-042 (AG-106) — la exclusión
-- ===========================================================================

-- `ADD CONSTRAINT ... EXCLUDE` valida las filas que ya existen, y su fallo
-- nombra la restricción pero no las filas. Misma política que
-- `agenda_entry_no_patient_overlap`: diagnosticar primero, con identificadores
-- y nunca con nombres, y decir qué hacer — en lugar de abortar un despliegue
-- con un error que no ofrece remedio. Hasta hoy dos reglas solapadas eran
-- LEGALES, así que una base con historia puede tenerlas.
DO $$
DECLARE
  v_conflicts text;
BEGIN
  SELECT string_agg(format('%s <-> %s', a.id, b.id), E'\n' ORDER BY a.id)
    INTO v_conflicts
    FROM practitioner_schedule_rule a
    JOIN practitioner_schedule_rule b
      ON a.practitioner_id = b.practitioner_id
     AND a.site_id = b.site_id
     AND a.weekday = b.weekday
     AND a.id < b.id
     AND a.minutes_range && b.minutes_range
     AND a.validity && b.validity
   WHERE a.active AND b.active;

  IF v_conflicts IS NOT NULL THEN
    RAISE EXCEPTION
      'practitioner_schedule_rule holds overlapping rules in force (rule id pairs):%', E'\n' || v_conflicts
      USING HINT = 'Close one rule of each pair (set valid_to) or deactivate it, then run this migration again. Do not delete rows: a published schedule is what past appointments were booked against.';
  END IF;
END;
$$;

-- `btree_gist` ya está instalada desde `20260806022956_clinical_core_constraints`
-- —la necesitan los EXCLUDE de la agenda— y es lo que permite meter los tres
-- `WITH =` dentro de un índice GiST. El `IF NOT EXISTS` es por si esta
-- migración llega a una base restaurada parcialmente.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- El predicado es `active` y nada más. Una regla desactivada no rige, así que
-- no puede solapar con nada; incluirla obligaría a desactivar y reactivar en un
-- orden concreto para editar un horario, que es justo la fricción que empuja a
-- la gente a tocar la base a mano.
ALTER TABLE practitioner_schedule_rule
  ADD CONSTRAINT schedule_rule_no_overlap
  EXCLUDE USING gist (
    practitioner_id WITH =,
    site_id WITH =,
    weekday WITH =,
    minutes_range WITH &&,
    validity WITH &&
  )
  WHERE (active);

COMMENT ON CONSTRAINT schedule_rule_no_overlap ON practitioner_schedule_rule IS
  'ST-042 (AG-106): dos reglas vigentes del mismo profesional, sede y día de la '
  'semana no pueden solaparse en horas. El nombre viaja al cliente como '
  'SCHEDULE_RULE_OVERLAP a través de constraint-meanings.';
