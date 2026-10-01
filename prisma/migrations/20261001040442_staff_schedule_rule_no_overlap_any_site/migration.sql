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
-- QUÉ CAMBIA. El EXCLUDE pierde `site_id WITH =` y nada más: mismo predicado
-- (`active`), mismas columnas generadas, mismo `[)` en la franja y `[]` en la
-- vigencia. El nombre de la restricción se conserva para que `constraint-
-- meanings` la siga traduciendo a `SCHEDULE_RULE_OVERLAP`.
--
-- Después: pnpm migrations:check && pnpm db:deploy

-- ===========================================================================
-- 1. Diagnóstico: reglas que ya chocan entre sedes
-- ===========================================================================

-- `ADD CONSTRAINT ... EXCLUDE` valida las filas existentes y su fallo nombra la
-- restricción pero no las filas. Misma política que la migración original:
-- diagnosticar primero, con identificadores, y decir qué hacer. Hasta hoy dos
-- reglas así eran LEGALES, y la semilla de desarrollo las tiene: una base de
-- desarrollo anterior a esta migración se rehace con `pnpm db:reset`.
DO $$
DECLARE
  v_conflicts text;
BEGIN
  SELECT string_agg(format('%s <-> %s', a.id, b.id), E'\n' ORDER BY a.id)
    INTO v_conflicts
    FROM practitioner_schedule_rule a
    JOIN practitioner_schedule_rule b
      ON a.practitioner_id = b.practitioner_id
     AND a.site_id <> b.site_id
     AND a.weekday = b.weekday
     AND a.id < b.id
     AND a.minutes_range && b.minutes_range
     AND a.validity && b.validity
   WHERE a.active AND b.active;

  IF v_conflicts IS NOT NULL THEN
    RAISE EXCEPTION
      'practitioner_schedule_rule holds rules of one practitioner at the same hours in two sites (rule id pairs):%', E'\n' || v_conflicts
      USING HINT = 'D-070: one schedule, one place. Close one rule of each pair (set valid_to) or deactivate it, then run this migration again. Do not delete rows: a published schedule is what past appointments were booked against. A development database seeded before this migration is rebuilt with pnpm db:reset.';
  END IF;
END;
$$;

-- ===========================================================================
-- 2. La exclusión, sin sede
-- ===========================================================================

ALTER TABLE practitioner_schedule_rule
  DROP CONSTRAINT schedule_rule_no_overlap;

ALTER TABLE practitioner_schedule_rule
  ADD CONSTRAINT schedule_rule_no_overlap
  EXCLUDE USING gist (
    practitioner_id WITH =,
    weekday WITH =,
    minutes_range WITH &&,
    validity WITH &&
  )
  WHERE (active);

COMMENT ON CONSTRAINT schedule_rule_no_overlap ON practitioner_schedule_rule IS
  'ST-042 (AG-106), sin sede desde D-070: dos reglas vigentes del mismo '
  'profesional y día de la semana no pueden solaparse en horas, en ninguna '
  'sede. El nombre viaja al cliente como SCHEDULE_RULE_OVERLAP a través de '
  'constraint-meanings.';
