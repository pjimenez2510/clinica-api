import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Development seed for the AGENDA screens (E1/E2).
 *
 * The main seed creates accounts with GLOBAL grants and no sites, so the
 * agenda page had nothing to list: no site, no practitioner, no schedule, no
 * appointments to transition. Without this, manually trying E1/E2 means
 * assembling rows by hand — which nobody does, so the screen never gets tried.
 *
 * Idempotent: sites upsert by their MSP code, practitioner profiles by user,
 * schedule rules by (practitioner, site, weekday, start), and the sample
 * appointments are only created when TODAY (in Ecuador) has none at the site —
 * re-running never duplicates a day, and a day you altered by testing stays
 * as you left it.
 *
 * Requires `db:seed` (users) and `db:seed:patients` (patients) to have run.
 */

const CLINIC_TIME_ZONE = 'America/Guayaquil';

/** Today as the Ecuadorian calendar date; entries are anchored to it. */
function todayInClinic(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CLINIC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The instant at which `HH:mm` strikes today in Ecuador (fixed UTC-5). */
function todayAt(time: string): Date {
  // Mainland Ecuador has no daylight saving; -05:00 is safe for a dev seed.
  return new Date(`${todayInClinic()}T${time}:00-05:00`);
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This seed is for development only.');
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  // --- Sites -----------------------------------------------------------
  const norte = await prisma.site.upsert({
    where: { mspUnicode: 'DEV-NORTE' },
    update: {},
    create: {
      mspUnicode: 'DEV-NORTE',
      name: 'Sede Norte',
      addressLine: 'Av. de los Granados y 6 de Diciembre, Quito',
    },
  });
  const sur = await prisma.site.upsert({
    where: { mspUnicode: 'DEV-SUR' },
    update: {},
    create: {
      mspUnicode: 'DEV-SUR',
      name: 'Sede Sur',
      addressLine: 'Av. Morán Valverde y Cóndor Ñan, Quito',
    },
  });

  for (const [site, name] of [
    [norte, 'Consultorio 1'],
    [norte, 'Consultorio 2'],
    [sur, 'Consultorio 1'],
  ] as const) {
    await prisma.siteRoom.upsert({
      where: { siteId_name: { siteId: site.id, name } },
      update: {},
      create: { siteId: site.id, name },
    });
  }

  // --- Practitioners: every seeded doctor account gets a clinical profile --
  const doctors = await prisma.user.findMany({
    where: { email: { in: ['medico@clinica.ec', 'admin@clinica.ec'] } },
    select: { id: true, email: true },
  });
  if (doctors.length === 0) {
    throw new Error('No seeded users found. Run `pnpm db:seed` first.');
  }

  const practitioners = [];
  for (const doctor of doctors) {
    const practitioner = await prisma.practitioner.upsert({
      where: { userId: doctor.id },
      update: { schedulable: true, active: true },
      create: { userId: doctor.id, schedulable: true },
    });
    practitioners.push(practitioner);

    for (const site of [norte, sur]) {
      await prisma.practitionerSite.upsert({
        where: {
          practitionerId_siteId: {
            practitionerId: practitioner.id,
            siteId: site.id,
          },
        },
        update: {},
        create: { practitionerId: practitioner.id, siteId: site.id },
      });

      // Monday to Saturday, morning and afternoon, 20-minute slots: whatever
      // day you open the screen, availability has something to offer.
      for (const weekday of [1, 2, 3, 4, 5, 6]) {
        for (const [start, end] of [
          ['08:00', '12:00'],
          ['14:00', '18:00'],
        ] as const) {
          const existing = await prisma.practitionerScheduleRule.findFirst({
            where: {
              practitionerId: practitioner.id,
              siteId: site.id,
              weekday,
              startTime: new Date(`1970-01-01T${start}:00Z`),
            },
            select: { id: true },
          });
          if (!existing) {
            await prisma.practitionerScheduleRule.create({
              data: {
                practitionerId: practitioner.id,
                siteId: site.id,
                weekday,
                startTime: new Date(`1970-01-01T${start}:00Z`),
                endTime: new Date(`1970-01-01T${end}:00Z`),
                slotMinutes: 20,
                validFrom: new Date('2026-01-01T00:00:00Z'),
              },
            });
          }
        }
      }
    }
  }

  // --- Today's appointments, in the states E2 transitions from ------------
  const dayStart = todayAt('00:00');
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000);
  const alreadySeeded = await prisma.agendaEntry.count({
    where: { siteId: norte.id, startsAt: { gte: dayStart, lt: dayEnd } },
  });

  if (alreadySeeded > 0) {
    console.log(
      `Agenda: hoy ya tiene ${alreadySeeded} entradas en ${norte.name}; no se duplican.`,
    );
  } else {
    const patients = await prisma.patient.findMany({
      where: { mergedIntoId: null },
      orderBy: { mrn: 'asc' },
      take: 5,
      select: { id: true },
    });
    if (patients.length < 5) {
      throw new Error(
        'Fewer than 5 patients available. Run `pnpm db:seed:patients` first.',
      );
    }

    const doctor = practitioners[0]!;
    const receptionist = await prisma.user.findUnique({
      where: { email: 'recepcion@clinica.ec' },
      select: { id: true },
    });

    // One entry per E2-relevant state. Hours are fixed; states are chosen so
    // the screen makes sense at any time of day (past hours hold the states
    // that need a started appointment, future hours the pending ones).
    const sample = [
      { time: '08:00', status: 'FULFILLED' as const },
      { time: '08:20', status: 'CHECKED_IN' as const },
      { time: '09:00', status: 'CONFIRMED' as const },
      { time: '15:00', status: 'BOOKED' as const },
    ];

    for (const [index, item] of sample.entries()) {
      const startsAt = todayAt(item.time);
      await prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: norte.id,
          practitionerId: doctor.id,
          patientId: patients[index]!.id,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 20 * 60_000),
          status: item.status,
          bookingChannel: 'PHONE',
          createdById: receptionist?.id ?? null,
          ...(item.status === 'CHECKED_IN' || item.status === 'FULFILLED'
            ? { checkedInAt: startsAt }
            : {}),
        },
      });
    }

    // A released cancellation: shows how a freed slot re-appears in the grid
    // and how a terminal row offers no actions.
    const cancelledStart = todayAt('09:20');
    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: norte.id,
        practitionerId: doctor.id,
        patientId: patients[4]!.id,
        startsAt: cancelledStart,
        endsAt: new Date(cancelledStart.getTime() + 20 * 60_000),
        status: 'CANCELLED',
        bookingChannel: 'WEB',
        cancelledAt: new Date(cancelledStart.getTime() - 60 * 60_000),
        releasedAt: new Date(cancelledStart.getTime() - 60 * 60_000),
        cancellationNote: 'Paciente reagendó por teléfono',
        createdById: receptionist?.id ?? null,
      },
    });

    console.log(
      `Agenda: ${sample.length + 1} entradas de hoy en ${norte.name} (una por estado de E2).`,
    );
  }

  console.log(
    `Agenda seed lista: 2 sedes, ${practitioners.length} profesionales agendables, reglas L-S 08:00-12:00 y 14:00-18:00.`,
  );
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
