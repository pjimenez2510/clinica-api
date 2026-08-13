import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Development seed for the STAFF screens (S1 and S2).
 *
 * WHY IT IS ITS OWN FILE and not part of `seed-agenda.mts`, which is where the
 * practitioner profiles are born: what these screens need lives in two tables
 * that neither of the existing seeds owns end to end. The ACESS registration
 * and its expiry are columns of `app_user` (`seed.mts`), the MSP code and the
 * schedulable flag are `practitioner` (`seed-agenda.mts`), and the schedule
 * rules with validity are a shape the agenda seed deliberately does not
 * produce — it writes open-ended rules so availability always has something to
 * offer. Bolting all of that onto either file would make it seed a module it
 * does not own; this one depends on both and says so.
 *
 * Idempotent: ACESS and MSP data are written with `update`, and every schedule
 * rule is looked up by (practitioner, site, weekday, start, validFrom) before
 * being created. Re-running never duplicates a rule — and it could not even if
 * it tried, because ST-042's EXCLUDE would refuse the second one.
 *
 * Requires `pnpm db:seed` (accounts) and `pnpm db:seed:agenda` (sites and
 * practitioner profiles).
 *
 * WHAT IT DELIBERATELY LEAVES IN A «BAD» STATE, because a screen that only
 * ever shows the happy path is a screen nobody has really tried:
 *   - one practitioner whose ACESS expires in 20 days — the ST-005 warning;
 *   - one whose ACESS expired 10 days ago — the ST-004 refusal to sign, which
 *     must NOT stop anybody from booking them (D-009).
 */

/** Today as the Ecuadorian calendar date, never the host's. */
function todayInClinic(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** A `date` value `days` away from today in Ecuador, at UTC midnight. */
function clinicDay(days: number): Date {
  const date = new Date(`${todayInClinic()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

/** `HH:MM` as the `time` column wants it: 1970-01-01 with the wall clock in UTC. */
function wallClock(time: string): Date {
  return new Date(`1970-01-01T${time}:00Z`);
}

const ACESS = [
  {
    email: 'medico@clinica.ec',
    registration: 'ACESS-1001',
    /** ST-005: inside the 30-day window, so the warning screen has a row. */
    expiresInDays: 20,
    mspCode: 'MSP-100234',
  },
  {
    email: 'admin@clinica.ec',
    registration: 'ACESS-2002',
    /** ST-004: already expired, so the refusal to sign can be seen. */
    expiresInDays: -10,
    mspCode: 'MSP-100987',
  },
];

/**
 * Sunday, which the agenda seed leaves empty on purpose (it writes Monday to
 * Saturday). Using a free weekday is not tidiness: ST-042 refuses two rules in
 * force over the same hours, so reusing Monday would make this seed fail the
 * second time somebody changed the agenda one.
 */
const SUNDAY = 7;

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This seed is for development only.');
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  // --- The habilitación, which lives on the ACCOUNT (ST-001, ST-002) --------
  let habilitated = 0;
  for (const person of ACESS) {
    const user = await prisma.user.findUnique({
      where: { email: person.email },
      select: { id: true },
    });
    if (!user) continue;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        acessRegistration: person.registration,
        acessExpiresOn: clinicDay(person.expiresInDays),
      },
    });

    // ST-003: the code RDACAA demands on every attention (REQ-021). Written
    // only where the profile already exists — `seed-agenda.mts` creates it,
    // and inventing one here would put a clinical profile on an account this
    // seed knows nothing about.
    const updated = await prisma.practitioner.updateMany({
      where: { userId: user.id },
      data: { mspCode: person.mspCode, schedulable: true, active: true },
    });
    habilitated += updated.count;
  }

  if (habilitated === 0) {
    throw new Error(
      'No practitioner profiles found. Run `pnpm db:seed` and `pnpm db:seed:agenda` first.',
    );
  }

  // --- Sites and schedule rules with validity (ST-007, ST-040, ST-041) -----
  const practitioners = await prisma.practitioner.findMany({
    select: { id: true, sites: { select: { siteId: true } } },
  });
  const sites = await prisma.site.findMany({ select: { id: true } });
  if (sites.length === 0) {
    throw new Error('No sites found. Run `pnpm db:seed:agenda` first.');
  }

  let assignments = 0;
  let rules = 0;

  for (const practitioner of practitioners) {
    // ST-007: without the assignment no rule may be written for that site, and
    // the screen would refuse with PRACTITIONER_NOT_IN_SITE — which is correct
    // and unhelpful as a starting state.
    for (const site of sites) {
      const created = await prisma.practitionerSite.createMany({
        data: { practitionerId: practitioner.id, siteId: site.id },
        skipDuplicates: true,
      });
      assignments += created.count;
    }

    const firstSite = sites[0]!;

    /**
     * Two rules over the SAME hours of the same Sunday, one closed and one in
     * force. They are legal precisely because their validity does not overlap
     * (ST-041, ST-042), and together they are what the editing screen needs to
     * be worth opening: a history to read and a current rule to change.
     */
    const sundays = [
      // Closed six months ago: `validTo` is the LAST day it ruled.
      { validFrom: new Date('2026-01-01T00:00:00Z'), validTo: new Date('2026-06-30T00:00:00Z'), slotMinutes: 30 }, // prettier-ignore
      // In force ever since.
      { validFrom: new Date('2026-07-01T00:00:00Z'), validTo: null, slotMinutes: 20 }, // prettier-ignore
    ];

    for (const period of sundays) {
      const existing = await prisma.practitionerScheduleRule.findFirst({
        where: {
          practitionerId: practitioner.id,
          siteId: firstSite.id,
          weekday: SUNDAY,
          startTime: wallClock('09:00'),
          validFrom: period.validFrom,
        },
        select: { id: true },
      });
      if (existing) continue;

      await prisma.practitionerScheduleRule.create({
        data: {
          practitionerId: practitioner.id,
          siteId: firstSite.id,
          weekday: SUNDAY,
          startTime: wallClock('09:00'),
          endTime: wallClock('13:00'),
          slotMinutes: period.slotMinutes,
          validFrom: period.validFrom,
          validTo: period.validTo,
        },
      });
      rules += 1;
    }
  }

  console.log(
    `Staff seed lista: ${habilitated} fichas con ACESS y código MSP ` +
      `(una caduca en 20 días y otra caducó hace 10), ` +
      `${assignments} asignaciones de sede nuevas, ${rules} reglas de horario nuevas.`,
  );
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
