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
 *
 * ⚠️ WHY THE SPECIALTY ASSIGNMENT AND THE DURATION EXCEPTION MOVED HERE.
 * `practitioner_specialty` and `duration_exception` are tables of THIS module
 * since the 13-08-2026 move (`SPEC.md`, ST-008 and ST-009), and
 * `seed-specialties.mts` was still writing the first one while nobody wrote
 * the second at all — so the ST-009 screen opened on an empty table and could
 * not be tried by hand. A module that owns a table owns its seed; the
 * specialty catalogue itself stays where it belongs, in `seed-specialties`.
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

/**
 * ST-008. The primary specialty of each seeded practitioner, by the account
 * they hang from. Moved verbatim from `seed-specialties.mts`: the codes are
 * public contract and changing the emitter cannot change them.
 */
const PRACTITIONER_PRIMARIES: readonly {
  email: string;
  specialtyCode: string;
}[] = [
  { email: 'medico@clinica.ec', specialtyCode: 'cardiologia' },
  { email: 'admin@clinica.ec', specialtyCode: 'medicina-general' },
];

/**
 * ST-009. One duration exception, so the screen opens on something.
 *
 * «Control» lasts 20 minutes by default (SP-020) and this cardiologist takes
 * 40: an exception that is VISIBLY different from the base is what makes the
 * D-010 hierarchy —excepción → base— legible at a glance.
 *
 * 40 AND NOT 45 SINCE D-021: every duration has to be a multiple of the site's
 * slot atom, which a fresh site starts at 10 minutes. A seed that wrote 45
 * would be seeding the very incoherence the decision removed — and it would
 * write it straight past the endpoint that refuses it.
 */
const DURATION_EXCEPTIONS: readonly {
  email: string;
  specialtyCode: string;
  serviceTypeName: string;
  durationMinutes: number;
}[] = [
  {
    email: 'medico@clinica.ec',
    specialtyCode: 'cardiologia',
    serviceTypeName: 'Control',
    durationMinutes: 40,
  },
];

export interface StaffSeedResult {
  habilitated: number;
  siteAssignments: number;
  rules: number;
  /** ST-008. Zero when the specialty catalogue has not been seeded yet. */
  specialtiesAssigned: number;
  /** ST-009. Zero for the same reason, and never an error. */
  durationExceptions: number;
}

export async function seedStaff(
  prisma: PrismaClient,
): Promise<StaffSeedResult> {
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
      { validFrom: new Date('2026-01-01T00:00:00Z'), validTo: new Date('2026-06-30T00:00:00Z') }, // prettier-ignore
      // In force ever since.
      { validFrom: new Date('2026-07-01T00:00:00Z'), validTo: null }, // prettier-ignore
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
          validFrom: period.validFrom,
          validTo: period.validTo,
        },
      });
      rules += 1;
    }
  }

  // --- Specialties and duration exceptions (ST-008, ST-009) ----------------
  const specialtiesAssigned = await assignPrimarySpecialties(prisma);
  const durationExceptions = await setDurationExceptions(prisma);

  return {
    habilitated,
    siteAssignments: assignments,
    rules,
    specialtiesAssigned,
    durationExceptions,
  };
}

/** The practitioner of an account, or `null` when either does not exist. */
async function practitionerOf(
  prisma: PrismaClient,
  email: string,
): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { practitioner: { select: { id: true } } },
  });
  return user?.practitioner?.id ?? null;
}

/** A specialty by its stable code, matched case-insensitively like the catalogue seed. */
async function specialtyIdOf(
  prisma: PrismaClient,
  code: string,
): Promise<string | null> {
  const specialty = await prisma.specialty.findFirst({
    where: { code: { equals: code, mode: 'insensitive' } },
    select: { id: true },
  });
  return specialty?.id ?? null;
}

/**
 * ST-008. Only when the practitioner exists AND has no specialties yet: an
 * assignment somebody edited from the screen is configuration, not seed
 * material. A missing specialty catalogue is skipped, never an error — this
 * seed does not own it.
 */
async function assignPrimarySpecialties(prisma: PrismaClient): Promise<number> {
  let assigned = 0;

  for (const { email, specialtyCode } of PRACTITIONER_PRIMARIES) {
    const practitionerId = await practitionerOf(prisma, email);
    if (!practitionerId) continue;

    const already = await prisma.practitionerSpecialty.count({
      where: { practitionerId },
    });
    if (already > 0) continue;

    const specialtyId = await specialtyIdOf(prisma, specialtyCode);
    if (!specialtyId) continue;

    await prisma.practitionerSpecialty.create({
      data: { practitionerId, specialtyId, isPrimary: true },
    });
    assigned += 1;
  }

  return assigned;
}

/**
 * ST-009. The row the duration-exception screen needs to be worth opening.
 *
 * `skipDuplicates` and not an update: the composite primary key
 * (practitioner, service type) is what makes re-running safe, and a clinic
 * that changed 40 to 30 from the screen meant it.
 */
async function setDurationExceptions(prisma: PrismaClient): Promise<number> {
  let written = 0;

  for (const exception of DURATION_EXCEPTIONS) {
    const practitionerId = await practitionerOf(prisma, exception.email);
    if (!practitionerId) continue;

    const specialtyId = await specialtyIdOf(prisma, exception.specialtyCode);
    if (!specialtyId) continue;

    const serviceType = await prisma.serviceType.findFirst({
      where: {
        specialtyId,
        name: { equals: exception.serviceTypeName, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (!serviceType) continue;

    const { count } = await prisma.durationException.createMany({
      data: {
        practitionerId,
        serviceTypeId: serviceType.id,
        durationMinutes: exception.durationMinutes,
      },
      skipDuplicates: true,
    });
    written += count;
  }

  return written;
}

/** Entry point for `pnpm db:seed:staff`. */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This seed is for development only.');
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  try {
    const result = await seedStaff(prisma);
    console.log(
      `Staff seed lista: ${result.habilitated} fichas con ACESS y código MSP ` +
        `(una caduca en 20 días y otra caducó hace 10), ` +
        `${result.siteAssignments} asignaciones de sede nuevas, ` +
        `${result.rules} reglas de horario nuevas, ` +
        `${result.specialtiesAssigned} especialidades principales, ` +
        `${result.durationExceptions} excepciones de duración.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Only when invoked directly, so the integration suite can import `seedStaff`
// without connecting twice.
if (process.argv[1]?.endsWith('seed-staff.mts')) {
  await main();
}
