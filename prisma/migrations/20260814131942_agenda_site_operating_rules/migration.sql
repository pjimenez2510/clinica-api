-- agenda_site_operating_rules (E7: AG-092, AG-031, AG-094)
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este repositorio:
-- propone borrar las columnas generadas, los índices GIN y BRIN, los índices
-- únicos parciales y los disparadores, porque schema.prisma no puede
-- describirlos. Ver scripts/new-migration.mts.
--
-- QUÉ AÑADE, Y POR QUÉ SÓLO ESTO:
--
-- La entrega E7 de `agenda` es «la agenda LEE lo que la configuración guarda».
-- `holiday` y `site_parameter` ya existen desde
-- `20260813040610_configuration_holidays_and_site_parameters`, así que casi
-- nada hace falta. Faltan exactamente dos cosas, y ninguna es de adorno:
--
--   * AG-092: «admitir marcar un feriado como LABORABLE para una sede
--     concreta: una clínica con urgencias atiende el 25 de diciembre». Con lo
--     que hay hoy sólo se puede decir «este día es feriado aquí» o «en todas
--     partes»; no se puede decir «en todas partes MENOS aquí». Sin esto, la
--     única forma de que urgencias trabaje el 25 es borrar el feriado nacional
--     — y entonces las demás sedes también abren.
--   * AG-031: «SI el inicio solicitado es anterior al instante actual Y LA
--     SEDE NO ADMITE RESERVAR EN EL PASADO». CF-062 dejó los cuatro números de
--     D-001 y este interruptor no estaba entre ellos, así que hoy la regla no
--     tiene de dónde leerse.
--
-- Lo demás que AG-094 enumera —si el sobrecupo está habilitado, el permiso que
-- lo autoriza, los intentos de contacto de la lista de espera— NO entra aquí.
-- Son parámetros de E4 y E5: nada los leería todavía, sus valores por defecto
-- son decisiones de negocio sin tomar, y una columna que nadie lee es una
-- columna que nadie mantiene. Queda registrado en DECISIONES-PENDIENTES.

-- ─── AG-092: la sede que SÍ trabaja un feriado ──────────────────────────────
--
-- UNA EXCEPCIÓN Y NO UNA BANDERA EN `holiday`. La bandera tendría que decir
-- «laborable para quién», y eso son N sedes por feriado: una columna no puede
-- llevarlo y una lista dentro de una columna no la puede recorrer un índice.
--
-- LA SEMÁNTICA ES UNIFORME PARA LOS DOS ÁMBITOS, y por eso no hay ningún CHECK
-- que restrinja esto a los feriados nacionales. «Esta sede trabaja este
-- feriado» se lee igual sobre uno local: el resultado es que ese feriado no se
-- aplica a la única sede a la que podía aplicarse, que es lo mismo que
-- borrarlo. Prohibirlo obligaría a una FK contra un índice parcial —que
-- PostgreSQL no admite— o a un disparador, a cambio de impedir una fila que no
-- miente ni hace daño.
CREATE TABLE holiday_site_exception (
  holiday_id uuid NOT NULL REFERENCES holiday (id) ON DELETE CASCADE,

  -- CASCADE por lo mismo que `holiday.site_id`, y con el mismo argumento de la
  -- migración anterior: esto no es evidencia clínica, no lo referencia nadie y
  -- no significa nada sin su sede. Con RESTRICT, declarar que una sede trabaja
  -- un feriado la volvería imborrable para siempre.
  site_id    uuid NOT NULL REFERENCES site (id) ON DELETE CASCADE,

  created_at timestamptz(6) NOT NULL DEFAULT now(),

  -- La clave primaria ES el par: una sede trabaja un feriado o no lo trabaja;
  -- decirlo dos veces no significa nada distinto.
  PRIMARY KEY (holiday_id, site_id)
);

-- La consulta de disponibilidad va SIEMPRE por sede y fecha: resuelve los
-- feriados del día y necesita saber cuáles de ellos esta sede trabaja. El
-- índice por `site_id` es el lado que la clave primaria no cubre, porque su
-- primera columna es `holiday_id`.
CREATE INDEX holiday_site_exception_by_site
  ON holiday_site_exception (site_id);

COMMENT ON TABLE holiday_site_exception IS
  'AG-092. La sede trabaja ese feriado: urgencias abre el 25 de diciembre sin que el feriado deje de aplicarse a las demás sedes.';

-- ─── AG-031, AG-094: reservar en el pasado ──────────────────────────────────
--
-- `false` POR DEFECTO, y es la elección conservadora deliberada: con la
-- antelación mínima de D-001 en 0 minutos, una sede acepta la cita del
-- paciente que está en el mostrador ahora mismo, y eso no necesita el pasado.
-- Lo que el pasado habilita es registrar a posteriori una atención que ya
-- ocurrió: un caso real, y uno que deja rastro — `agenda_entry.created_at` y
-- `created_by_id` los escribe `book` en cada cita, así que un hueco rellenado
-- hacia atrás se distingue de uno agendado a tiempo leyendo cuándo y quién lo
-- creó. Lo que el rastro no hace es avisar: hay que ir a buscarlo, cita por
-- cita y sospechando ya. Por eso el interruptor nace cerrado — que una sede
-- abra el pasado es una decisión suya, tomada porque necesita registrar a
-- posteriori; tenerlo abierto de fábrica sería una decisión nuestra que nadie
-- de la clínica llegó a tomar.
ALTER TABLE site_parameter
  ADD COLUMN allow_past_booking boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN site_parameter.allow_past_booking IS
  'AG-031. La sede admite reservar con inicio anterior al instante actual (registro a posteriori).';
