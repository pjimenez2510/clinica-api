-- billing_charges_from_clinical_acts
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Después: pnpm migrations:check && pnpm db:deploy

-- ═══════════════════════════════════════════════════════════════════════════
-- DEL ACTO CLÍNICO AL CARGO — BI-150 a BI-158
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hasta hoy los cargos se tecleaban en caja uno a uno. Lo que falta para que
-- «el costo salga de lo que realmente se hizo» son dos cosas que NO se pueden
-- deducir del nombre de una prestación ni de un prefijo de código:
--
--   1. DE QUÉ ACTO NACIÓ CADA CARGO, y que la base impida que un acto genere
--      dos. `charge_item` ya tenía `encounter_procedure_id` y
--      `service_order_item_id` —escalares sin clave foránea, a propósito: el
--      lado económico no puede retener una fila clínica bajo RESTRICT— pero
--      nada decía que fueran únicos, y nada podía distinguir «la consulta» de
--      un cargo tecleado a mano sobre la misma atención.
--
--   2. QUÉ PRESTACIÓN ES «LA CONSULTA» de una especialidad. El sistema NO la
--      infiere del nombre ni del código: `CONS-DER-PV` es una convención de la
--      siembra, no un dato, y una clínica que renombre su catálogo dejaría de
--      cobrar consultas sin que nada fallara. La correspondencia es una FILA.
--
-- REENTRANTE. Cada sentencia es `IF NOT EXISTS` / `DROP … IF EXISTS`, así que
-- reejecutarla tras un fallo parcial converge en vez de exigir una base
-- reparada a mano.
--
-- ⚠️ LO QUE ESTA MIGRACIÓN NO HACE, Y NO ES UN OLVIDO: no crea ni una sola
-- clave foránea desde `charge_item` hacia `encounter_procedure` o
-- `service_order_item`. «Qué se hizo» y «qué se cobra» son dos registros
-- distintos (BI-004): borrar un cargo no puede borrar el acto, y el acto no
-- puede quedar retenido porque exista un cargo que lo nombre. El precio de esa
-- decisión es que un identificador huérfano es posible; la alternativa —que
-- corregir la historia clínica falle porque caja cobró— es peor.

-- ---------------------------------------------------------------------------
-- 1. `charge_item.origin` — de dónde vino la línea
-- ---------------------------------------------------------------------------
--
-- Cuatro valores y ni uno más:
--
--   · MANUAL       — lo tecleó alguien en caja. Es el valor por defecto, y por
--                    eso las filas que ya existen quedan clasificadas bien sin
--                    tocarlas: es exactamente lo que eran.
--   · CONSULTATION — la consulta misma, derivada de la atención.
--   · PROCEDURE    — un `encounter_procedure` registrado en la atención.
--   · EXAM         — un `service_order_item` pedido en la atención.
--
-- POR QUÉ UNA COLUMNA Y NO «SE DEDUCE DE QUÉ IDENTIFICADOR VIENE LLENO». Por
-- la consulta: no tiene fila clínica propia que señalar —el acto ES la
-- atención— así que sin esta columna «la consulta» y «una gasa que la cajera
-- añadió a mano» son indistinguibles, y el índice único de más abajo no se
-- podría escribir. Y porque la pantalla de caja tiene que poder decir de dónde
-- viene cada línea sin adivinarlo.
ALTER TABLE "charge_item"
  ADD COLUMN IF NOT EXISTS "origin" VARCHAR(16) NOT NULL DEFAULT 'MANUAL';

ALTER TABLE "charge_item" DROP CONSTRAINT IF EXISTS "charge_item_origin_is_known";
ALTER TABLE "charge_item"
  ADD CONSTRAINT "charge_item_origin_is_known" CHECK (
    "origin" IN ('MANUAL', 'CONSULTATION', 'PROCEDURE', 'EXAM')
  );

-- El origen y el acto que nombra tienen que estar de acuerdo. Sin esto,
-- `origin = 'EXAM'` con `service_order_item_id` nulo es una línea que dice
-- venir de una orden y no puede decir de cuál — que es justo la pregunta que
-- llega con un reclamo.
--
-- MANUAL admite `encounter_id`: una venta de mostrador durante una atención se
-- teclea contra ella y sigue siendo manual. Lo que no admite es señalar un
-- procedimiento o una línea de orden, porque entonces sería derivada.
ALTER TABLE "charge_item" DROP CONSTRAINT IF EXISTS "charge_item_origin_names_its_act";
ALTER TABLE "charge_item"
  ADD CONSTRAINT "charge_item_origin_names_its_act" CHECK (
    CASE "origin"
      WHEN 'PROCEDURE' THEN
        "encounter_procedure_id" IS NOT NULL
        AND "service_order_item_id" IS NULL
        AND "encounter_id" IS NOT NULL
      WHEN 'EXAM' THEN
        "service_order_item_id" IS NOT NULL
        AND "encounter_procedure_id" IS NULL
        AND "encounter_id" IS NOT NULL
      WHEN 'CONSULTATION' THEN
        "encounter_id" IS NOT NULL
        AND "encounter_procedure_id" IS NULL
        AND "service_order_item_id" IS NULL
      ELSE
        "encounter_procedure_id" IS NULL
        AND "service_order_item_id" IS NULL
    END
  );

-- ---------------------------------------------------------------------------
-- 2. LA IDEMPOTENCIA ES DE LA BASE, NO DE UNA LECTURA PREVIA — BI-154
-- ---------------------------------------------------------------------------
--
-- «Pulsar dos veces no duplica cargos» se implementa casi siempre leyendo
-- antes de escribir, y esa comprobación es correcta en la pantalla y falsa
-- bajo concurrencia: dos peticiones que leen a la vez encuentran las dos que
-- no hay nada, y las dos insertan. La cuenta queda con la biometría cobrada
-- dos veces y nadie sabe cuál sobra.
--
-- Los tres índices siguientes son PARCIALES, así que no indexan las ventas de
-- mostrador ni los cargos tecleados a mano, y viven aquí porque
-- `schema.prisma` no puede describir un predicado.
--
-- ⚠️ Y COMPRENDEN LOS CARGOS ANULADOS A PROPÓSITO (BI-157). Si caja quita la
-- línea de un examen que no se cobra, la fila sigue ahí en `CANCELLED` —nunca
-- se borra (BI-055)— y ocupa el índice. Volver a pulsar «enviar a caja» NO la
-- resucita, que es lo correcto: quitarla fue una decisión de una persona, y un
-- sistema que la deshiciera al siguiente clic estaría cobrando lo que alguien
-- decidió no cobrar.
CREATE UNIQUE INDEX IF NOT EXISTS "charge_item_one_per_encounter_procedure"
  ON "charge_item"("encounter_procedure_id")
  WHERE "encounter_procedure_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "charge_item_one_per_service_order_item"
  ON "charge_item"("service_order_item_id")
  WHERE "service_order_item_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "charge_item_one_consultation_per_encounter"
  ON "charge_item"("encounter_id")
  WHERE "origin" = 'CONSULTATION';

-- El recorrido que hace la propuesta: «¿qué cargos derivados tiene ya esta
-- atención?». Parcial por lo mismo que `charge_item_by_encounter`: una venta
-- de mostrador no tiene atención y no debe entrar.
CREATE INDEX IF NOT EXISTS "charge_item_derived_by_encounter"
  ON "charge_item"("encounter_id", "origin")
  WHERE "encounter_id" IS NOT NULL AND "origin" <> 'MANUAL';

COMMENT ON COLUMN "charge_item"."origin" IS
  'BI-153. De donde nacio la linea: MANUAL, CONSULTATION, PROCEDURE o EXAM. '
  'No se deduce de que identificador viene lleno porque la consulta no tiene '
  'fila clinica propia que senalar.';

-- ---------------------------------------------------------------------------
-- 3. QUÉ PRESTACIÓN ES «LA CONSULTA» — BI-158
-- ---------------------------------------------------------------------------
--
-- La consulta se cobra según SU TIPO Y SU ESPECIALIDAD: dermatología primera
-- vez no vale lo que dermatología subsecuente, ni lo que medicina general.
-- Esas dos cosas —la especialidad y si es primera vez— YA existen del lado
-- clínico (`service_type.specialty_id` de la cita y `encounter.visit_sequence`,
-- que el RDACAA obliga a registrar). Lo que faltaba era la fila que las une
-- con una prestación cobrable.
--
-- ⚠️ POR QUÉ ES UNA FILA Y NO UNA REGLA. La tentación es leer el código
-- (`CONS-DER-PV` → dermatología, primera vez) y ahorrarse la migración. Eso
-- funciona con la siembra y falla en la primera clínica que use su propia
-- codificación, en silencio: dejaría de proponerse el cargo de la consulta, y
-- una consulta no cobrada no da ningún error, sólo menos dinero. Es la misma
-- razón por la que BI-005 prohíbe inferir el IVA del nombre del servicio.
--
-- NULAS LAS DOS EN LA INMENSA MAYORÍA DE FILAS: una gasa, una radiografía o
-- una infiltración no son «la consulta» de ninguna especialidad.
ALTER TABLE "billable_service"
  ADD COLUMN IF NOT EXISTS "specialty_id"   UUID,
  ADD COLUMN IF NOT EXISTS "visit_sequence" VARCHAR(16);

ALTER TABLE "billable_service" DROP CONSTRAINT IF EXISTS "billable_service_specialty_fk";
ALTER TABLE "billable_service"
  ADD CONSTRAINT "billable_service_specialty_fk"
    FOREIGN KEY ("specialty_id") REFERENCES "specialty"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Las dos juntas o ninguna: media correspondencia no resuelve nada y una
-- especialidad sin secuencia haría ambiguo cuál de las dos consultas es.
ALTER TABLE "billable_service" DROP CONSTRAINT IF EXISTS "billable_service_consultation_states_both";
ALTER TABLE "billable_service"
  ADD CONSTRAINT "billable_service_consultation_states_both" CHECK (
    ("specialty_id" IS NULL) = ("visit_sequence" IS NULL)
  );

-- Los mismos dos valores que el tipo `visit_sequence` del lado clínico. Se
-- escribe como texto acotado y no como ese enum a propósito: el catálogo
-- económico no debe depender de un tipo del esquema clínico para poder
-- evolucionar, y el CHECK deja el error igual de temprano.
ALTER TABLE "billable_service" DROP CONSTRAINT IF EXISTS "billable_service_visit_sequence_is_known";
ALTER TABLE "billable_service"
  ADD CONSTRAINT "billable_service_visit_sequence_is_known" CHECK (
    "visit_sequence" IS NULL OR "visit_sequence" IN ('FIRST_TIME', 'SUBSEQUENT')
  );

-- UNA prestación por (especialidad, secuencia). Dos harían la propuesta
-- ambigua, y «se coge la primera» es como una clínica acaba cobrando la
-- consulta vieja durante meses.
CREATE UNIQUE INDEX IF NOT EXISTS "billable_service_one_per_consultation"
  ON "billable_service"("specialty_id", "visit_sequence")
  WHERE "specialty_id" IS NOT NULL;

COMMENT ON COLUMN "billable_service"."specialty_id" IS
  'BI-158. Que prestacion es LA CONSULTA de esta especialidad. Es un dato y no '
  'una regla sobre el codigo: una clinica con su propia codificacion dejaria de '
  'cobrar consultas en silencio.';
