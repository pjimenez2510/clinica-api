import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * D-070 in DEVELOPMENT: resolves the schedule rules of one practitioner at the
 * same hours in two sites, so `staff_schedule_rule_no_overlap_any_site` can be
 * applied to a database seeded before it.
 *
 * `pnpm db:fix:schedule-overlaps`            lists what it would do, writes nothing
 * `pnpm db:fix:schedule-overlaps --apply`    does it
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT DOES (D-085 §6)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * For every pair of ACTIVE rules of one practitioner, on the same weekday, in
 * two different sites, whose hours overlap and whose validities still run on
 * or after 2026-10-01 (D-070's cutover, the predicate of the exclusion), it
 * keeps the OLDER rule (the smaller `uuidv7`, created first) and CLOSES the
 * newer one: `valid_to = 2026-09-30`. Its past stays exactly as it was —the
 * appointments it ruled were booked against it— and from the cutover it no
 * longer collides. A rule that only starts on or after the cutover has no
 * past to keep, so it is deactivated instead (`active = false`). NOTHING IS
 * DELETED, nothing else is touched, and both changes are undone by setting
 * the column back.
 *
 * Appointments already booked at the closed rule's site after the cutover are
 * left as they are: they are conflicts for a person to manage (ST-043).
 *
 * IDEMPOTENT: a second run finds no pairs and says so. Pairs are resolved one
 * at a time and re-read after each, so a practitioner with the same hours in
 * THREE sites keeps exactly one.
 *
 * DEVELOPMENT ONLY. Which rule of a real clinic stays is a decision about a
 * person's schedule and is the clinic's (D-070); the script refuses a
 * production `NODE_ENV`.
 */

interface Conflict {
  kept_id: string;
  kept_site: string;
  dropped_id: string;
  dropped_site: string;
  practitioner: string;
  weekday: number;
  kept_hours: string;
  dropped_hours: string;
}

const NEXT_CONFLICT = `
  SELECT a.id::text AS kept_id, sa.name AS kept_site,
         b.id::text AS dropped_id, sb.name AS dropped_site,
         concat_ws(' ', u.first_name, u.last_name) AS practitioner,
         a.weekday,
         to_char(a.start_time, 'HH24:MI') || '–' || to_char(a.end_time, 'HH24:MI') AS kept_hours,
         to_char(b.start_time, 'HH24:MI') || '–' || to_char(b.end_time, 'HH24:MI') AS dropped_hours
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
     AND (a.valid_to IS NULL OR a.valid_to >= DATE '2026-10-01')
     AND (b.valid_to IS NULL OR b.valid_to >= DATE '2026-10-01')
   ORDER BY a.practitioner_id, a.weekday, a.start_time, a.id, b.id
   LIMIT 1
`;

/** Every conflicting pair, for the dry run. */
const ALL_CONFLICTS = NEXT_CONFLICT.replace('LIMIT 1', '');

/** D-070's cutover: the exclusion covers validities still running from here. */
const CUTOVER = new Date('2026-10-01T00:00:00Z');
const LAST_DAY_BEFORE_CUTOVER = new Date('2026-09-30T00:00:00Z');

const WEEKDAYS = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo']; // prettier-ignore

function describe(c: Conflict): string {
  return (
    `${c.practitioner} · ${WEEKDAYS[c.weekday]} · se queda ${c.kept_site} ${c.kept_hours} ` +
    `(regla ${c.kept_id}); se cierra ${c.dropped_site} ${c.dropped_hours} (regla ${c.dropped_id})`
  );
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Solo para desarrollo: con datos reales, qué horario se queda lo decide la clínica (D-070).',
    );
  }
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    if (!apply) {
      const all = await prisma.$queryRawUnsafe<Conflict[]>(ALL_CONFLICTS);
      if (all.length === 0) {
        console.log(
          'Ningún profesional tiene horario a la misma hora en dos sedes. Nada que hacer.',
        );
        return;
      }
      console.log(
        `${all.length} pares en conflicto. Con --apply se resolverían así (la regla más antigua se queda; la otra se cierra el 30-09-2026):`,
      );
      for (const conflict of all) console.log(`  ${describe(conflict)}`);
      return;
    }

    let resolved = 0;
    for (;;) {
      const [conflict] =
        await prisma.$queryRawUnsafe<Conflict[]>(NEXT_CONFLICT);
      if (!conflict) break;
      const rule = await prisma.practitionerScheduleRule.findUniqueOrThrow({
        where: { id: conflict.dropped_id },
        select: { validFrom: true },
      });
      // Conditioned on `active`, so a concurrent run cannot count it twice.
      const updated = await prisma.practitionerScheduleRule.updateMany({
        where: { id: conflict.dropped_id, active: true },
        data:
          rule.validFrom < CUTOVER
            ? { validTo: LAST_DAY_BEFORE_CUTOVER }
            : { active: false },
      });
      if (updated.count === 1) {
        resolved += 1;
        console.log(`  ${describe(conflict)}`);
      }
    }
    console.log(
      resolved === 0
        ? 'Ningún profesional tiene horario a la misma hora en dos sedes. Nada que hacer.'
        : `${resolved} reglas cerradas el 30-09-2026 (o desactivadas, si empezaban después). No se borró nada.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

await main();
