-- staff_schedule_rule_no_overlap_any_site
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ST-042 sin sede (D-070 B, resuelta por el autor el 30-09-2026): un
-- profesional NO tiene horario a la misma hora en dos sedes. Un horario, un
-- sitio.
--
-- POR QUÉ. El EXCLUDE de `staff_schedule_rule_no_overlap` comparaba
-- profesional, SEDE, día, franja y vigencia, así que dos reglas del mismo
-- médico a la misma hora en la Sede Norte y en la Sur eran legales. La semilla
-- de desarrollo daba el mismo horario en tres sedes, y cada rejilla prometía
-- horas que el médico pasaba en otra: AG-144 dejó de ofrecerlas cuando ya
-- estaban ocupadas, pero una hora en blanco del horario de la Norte seguía
-- pareciendo libre en la Sur, y el sobrecupo de la Sur podía caer dentro.
--
-- QUÉ CAMBIA. `staff_schedule_rule_no_overlap` se queda COMO ESTABA (misma
-- sede, sin fecha): sigue guardando el pasado de una sede. Se AÑADE
-- `schedule_rule_no_overlap_across_sites` —mismo profesional, OTRA sede
-- (`site_id WITH <>`), mismo día, franja y vigencia que se tocan—, y solo
-- para las reglas activas vigentes desde la entrada en vigor, 2026-10-01
-- (D-085 §6): dos reglas que convivieron antes fueron legales entonces.
-- `constraint-meanings` traduce las dos a `SCHEDULE_RULE_OVERLAP`.
--
-- Después: pnpm migrations:check && pnpm db:deploy

-- ===========================================================================
-- 1. Diagnóstico: reglas que ya chocan entre sedes
-- ===========================================================================

-- `ADD CONSTRAINT ... EXCLUDE` valida las filas existentes y su fallo nombra la
-- restricción pero no las filas. Misma política que la migración original:
-- diagnosticar primero y decir qué hacer. Hasta hoy dos reglas así eran
-- LEGALES, y la semilla de desarrollo anterior las tiene.
--
-- QUÉ SE LISTA: cada par en conflicto con el profesional, las dos sedes, el
-- día y las dos franjas, y los identificadores de las reglas — lo necesario
-- para decidir cuál se queda sin abrir otra consulta. Nombres de sede y de
-- profesional, no datos de pacientes.
--
-- NO SE CORRIGE AQUÍ. Qué regla sobra es una decisión de la clínica sobre el
-- horario de una persona; una migración que eligiera sola cerraría la agenda
-- de una sede en silencio. En desarrollo la resuelve, sin borrar nada,
-- `pnpm db:fix:schedule-overlaps` (scripts/resolve-schedule-overlaps.mts),
-- cerrando la vigencia de la regla duplicada el 2026-09-30; con datos reales,
-- la clínica decide cuál se cierra (D-085 §6).
DO $$
DECLARE
  v_conflicts text;
BEGIN
  SELECT string_agg(
           format(
             '%s · %s · %s %s–%s (regla %s) <-> %s %s–%s (regla %s)',
             coalesce(nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''), a.practitioner_id::text),
             CASE a.weekday WHEN 1 THEN 'lunes' WHEN 2 THEN 'martes' WHEN 3 THEN 'miércoles'
                            WHEN 4 THEN 'jueves' WHEN 5 THEN 'viernes' WHEN 6 THEN 'sábado'
                            ELSE 'domingo' END,
             sa.name, to_char(a.start_time, 'HH24:MI'), to_char(a.end_time, 'HH24:MI'), a.id,
             sb.name, to_char(b.start_time, 'HH24:MI'), to_char(b.end_time, 'HH24:MI'), b.id
           ),
           E'\n' ORDER BY a.practitioner_id, a.weekday, a.start_time, a.id, b.id
         )
    INTO v_conflicts
    FROM practitioner_schedule_rule a
    JOIN practitioner_schedule_rule b
      ON a.practitioner_id = b.practitioner_id
     AND a.site_id <> b.site_id
     AND a.weekday = b.weekday
     AND a.id < b.id
     AND a.minutes_range && b.minutes_range
     AND a.validity && b.validity
    JOIN site sa ON sa.id = a.site_id
    JOIN site sb ON sb.id = b.site_id
    JOIN practitioner p ON p.id = a.practitioner_id
    JOIN app_user u ON u.id = p.user_id
   WHERE a.active AND b.active
     -- The same predicate as the exclusion below: only validities still in
     -- force on or after D-070's cutover.
     AND (a.valid_to IS NULL OR a.valid_to >= DATE '2026-10-01')
     AND (b.valid_to IS NULL OR b.valid_to >= DATE '2026-10-01');

  IF v_conflicts IS NOT NULL THEN
    RAISE EXCEPTION
      'D-070: practitioner_schedule_rule holds rules of one practitioner at the same hours in two sites:%', E'\n' || v_conflicts
      USING HINT = 'One schedule, one place (ST-042). Close one rule of each pair on 2026-09-30 (valid_to) and, if that schedule should go on, create it again from today at hours that do not collide (D-085 §6). In DEVELOPMENT: `pnpm db:fix:schedule-overlaps --apply` closes the newer rule of each pair on 2026-09-30, deletes nothing. With real data, which rule stays is decided by the clinic. Nothing was changed: mark this migration rolled back with `pnpm exec prisma migrate resolve --rolled-back 20261001070900_staff_schedule_rule_no_overlap_any_site` and run `pnpm db:deploy` again.';
  END IF;
END;
$$;

-- ===========================================================================
-- 2. La exclusión entre sedes, desde la entrada en vigor
-- ===========================================================================

-- `schedule_rule_no_overlap` (por sede, sin fecha) SE QUEDA COMO ESTABA: dentro
-- de una sede la garantía siempre fue completa, también en el pasado, y
-- quitarla para añadir la de entre sedes dejaría pasar dos reglas solapadas
-- de la misma sede con vigencias anteriores al corte.
--
-- D-085 §6. ENTRE SEDES, SOLO LAS VIGENCIAS QUE SIGUEN DESDE LA ENTRADA EN
-- VIGOR (2026-10-01). Dos reglas que rigieron en el pasado a la misma hora en
-- dos sedes eran legales entonces, y una exclusión sobre vigencias completas
-- dejaría una sola salida: desactivar una regla, que la borra también de su
-- pasado. Con este predicado la salida es la honesta —cerrar la antigua el
-- 2026-09-30, que conserva su historia— y desde el corte la garantía es
-- completa. La fecha es fija a propósito: es el día en que cambió la regla, no
-- «hoy», que un predicado de índice no puede leer.
--
-- `site_id WITH <>` y no simplemente sin sede: el solape dentro de la misma
-- sede ya lo juzga la exclusión de arriba, y esta no tiene que volver a
-- juzgarlo con otro predicado.
ALTER TABLE practitioner_schedule_rule
  ADD CONSTRAINT schedule_rule_no_overlap_across_sites
  EXCLUDE USING gist (
    practitioner_id WITH =,
    site_id WITH <>,
    weekday WITH =,
    minutes_range WITH &&,
    validity WITH &&
  )
  WHERE (active AND (valid_to IS NULL OR valid_to >= DATE '2026-10-01'));

COMMENT ON CONSTRAINT schedule_rule_no_overlap_across_sites ON practitioner_schedule_rule IS
  'ST-042 entre sedes (D-070): dos reglas vigentes del mismo profesional y día '
  'de la semana no pueden solaparse en horas en dos sedes, en las vigencias '
  'que siguen desde el 2026-10-01 (D-085 §6). Viaja al cliente como '
  'SCHEDULE_RULE_OVERLAP a través de constraint-meanings.';
