import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { ensureDevelopmentEstablishment } from './seed-organization.mts';

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

/**
 * The hours of each development site, Monday to Saturday (D-070).
 *
 * Central —where the day is seeded and the walks run— keeps the full day;
 * Norte the midday and Sur the evening, so the three never overlap and an
 * overbooking at Central over midday lands inside Norte's hours (AG-151).
 * Without Central (a database seeded before it existed), Norte takes the day.
 */
function HOURS_OF(
  site: { id: string; mspUnicode: string },
  central: { id: string } | null,
): readonly (readonly [string, string])[] {
  if (central && site.id === central.id) {
    return [
      ['08:00', '12:00'],
      ['14:00', '18:00'],
    ];
  }
  if (site.mspUnicode === 'DEV-SUR') return [['18:00', '20:00']];
  if (central) return [['12:00', '14:00']];
  return [
    ['08:00', '12:00'],
    ['14:00', '18:00'],
  ];
}

/**
 * Entry point of `pnpm db:seed:agenda`. Refuses a production `NODE_ENV`:
 * everything below — sites, practitioner profiles, schedules, today's sample
 * appointments — is demo data, idempotent on the keys listed at the top.
 */
async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This seed is for development only.');
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  // --- Sites -----------------------------------------------------------
  /**
   * La parroquia de las sedes de desarrollo.
   *
   * NO ES DECORACIÓN: la receta imprime la ciudad, y la ciudad se resuelve
   * subiendo por el DPA desde la parroquia de la sede. Sin ella, emitir
   * cualquier receta responde `PRESCRIPTION_ESTABLISHMENT_INCOMPLETE` — que es
   * lo correcto, porque el art. 5.a.ii la exige, pero deja el módulo
   * inutilizable en desarrollo por un dato que nadie sabía que faltaba.
   *
   * Se busca por código y no por nombre: «QUITO» aparece tres veces en el DPA
   * —también en «PUERTO QUITO» y en una parroquia de Chimborazo—.
   */
  const parish = await prisma.catalogConcept.findFirst({
    // UNA PARROQUIA (6 dígitos) y no el cantón: la receta toma la ciudad del
    // PADRE de la parroquia (PR-021), y con el cantón 1701 como «parroquia»
    // imprimía la provincia, «PICHINCHA», como ciudad. 170102 es Carcelén,
    // en el cantón Quito.
    where: { code: '170102', validTo: null, system: { code: 'DPA' } },
    select: { id: true },
  });

  // OR-032. Every site belongs to an establishment: the one the clinic
  // registered, or the development one of `seed-organization.mts` when the
  // database has none yet. Never a site without it. With several, the oldest
  // (`uuidv7` orders by creation): a development seed has one clinic.
  const establishment =
    (await prisma.establishment.findFirst({
      select: { id: true },
      orderBy: { id: 'asc' },
    })) ?? (await ensureDevelopmentEstablishment(prisma));

  const norte = await prisma.site.upsert({
    where: { mspUnicode: 'DEV-NORTE' },
    // También al actualizar: las sedes de una base ya sembrada existen sin
    // parroquia, y `update: {}` sólo lo arreglaría borrando la base.
    update: { parishConceptId: parish?.id ?? null },
    create: {
      mspUnicode: 'DEV-NORTE',
      establishmentId: establishment.id,
      name: 'Sede Norte',
      addressLine: 'Av. de los Granados y 6 de Diciembre, Quito',
      parishConceptId: parish?.id ?? null,
    },
  });
  // La sede que la interfaz abre por defecto es la PRIMERA por nombre, y esa
  // es «Sede Central» (`seed-organization.mts`). Sembrar el día solo en «Sede
  // Norte» dejaba el tablero vacío justo al abrirlo — la peor primera
  // impresión posible, y una que hace pensar que el módulo no funciona.
  //
  // Puede no existir si `seed-organization` no ha corrido; entonces el día se
  // siembra en Norte como siempre.
  let central = await prisma.site.findUnique({
    where: { mspUnicode: 'DEV-SEDE-01' },
  });
  // The same parish for Central, which `seed-organization` creates without
  // one: on a database seeded from scratch it is where the médico attends,
  // and no receta could be issued there. Only when it has none — a parish set
  // from the screen is kept.
  if (central !== null && central.parishConceptId === null && parish) {
    central = await prisma.site.update({
      where: { id: central.id },
      data: { parishConceptId: parish.id },
    });
  }

  const sur = await prisma.site.upsert({
    where: { mspUnicode: 'DEV-SUR' },
    update: { parishConceptId: parish?.id ?? null },
    create: {
      mspUnicode: 'DEV-SUR',
      establishmentId: establishment.id,
      name: 'Sede Sur',
      addressLine: 'Av. Morán Valverde y Cóndor Ñan, Quito',
      parishConceptId: parish?.id ?? null,
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

  /**
   * PR-040, ST-049. A placeholder of the right shape for the receta's «número
   * de contacto permanente del prescriptor». Nobody answers it.
   */
  const DEV_CONTACT_PHONE = '0990000000';

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
      create: {
        userId: doctor.id,
        schedulable: true,
        emergencyContactPhone: DEV_CONTACT_PHONE,
      },
    });
    // PR-040. Without it the doctor cannot issue a receta in development. Only
    // where there is none: a number somebody typed on the staff screen stays.
    if (practitioner.emergencyContactPhone === null) {
      await prisma.practitioner.update({
        where: { id: practitioner.id },
        data: { emergencyContactPhone: DEV_CONTACT_PHONE },
      });
    }
    practitioners.push(practitioner);

    // `central` incluida: es donde se siembra el día, así que sin el vínculo
    // el profesional no aparece en el filtro del tablero.
    for (const site of central ? [central, norte, sur] : [norte, sur]) {
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

      // Monday to Saturday, so whatever day you open the screen availability
      // has something to offer — and EACH SITE AT ITS OWN HOURS (D-070, ST-042
      // without site): the database refuses one practitioner with a schedule
      // at the same hour in two sites. This seed used to give the same hours
      // at three, and that is what made every grid promise hours the doctor
      // spent elsewhere (AG-144).
      for (const weekday of [1, 2, 3, 4, 5, 6]) {
        for (const [start, end] of HOURS_OF(site, central)) {
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
                validFrom: new Date('2026-01-01T00:00:00Z'),
              },
            });
          }
        }
      }
    }
  }

  // --- Today's appointments, in the states E2 transitions from ------------
  const stage = central ?? norte;
  const dayStart = todayAt('00:00');
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000);
  const alreadySeeded = await prisma.agendaEntry.count({
    where: { siteId: stage.id, startsAt: { gte: dayStart, lt: dayEnd } },
  });

  if (alreadySeeded > 0) {
    console.log(
      `Agenda: hoy ya tiene ${alreadySeeded} entradas en ${stage.name}; no se duplican.`,
    );
  } else {
    // PACIENTES QUE NO TENGAN YA UNA CITA HOY, en ninguna sede.
    //
    // `agenda_entry_no_patient_overlap` rechaza —con razón— que la misma
    // persona esté citada en dos sitios a la vez, y la primera versión de esto
    // reutilizaba los cinco primeros por MRN: al sembrar una segunda sede
    // chocaba consigo misma. La base lo dijo en voz alta; la lista de pacientes
    // es larga y elegir libres es la respuesta, no relajar la garantía.
    const patients = await prisma.patient.findMany({
      where: {
        mergedIntoId: null,
        agendaEntries: { none: { startsAt: { gte: dayStart, lt: dayEnd } } },
      },
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
          siteId: stage.id,
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
        siteId: stage.id,
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
      `Agenda: ${sample.length + 1} entradas de hoy en ${stage.name} (una por estado de E2).`,
    );
  }

  console.log(
    `Agenda seed lista: 2 sedes, ${practitioners.length} profesionales agendables, reglas L-S, cada sede a su hora (Central 08-12 y 14-18, Norte 12-14, Sur 18-20; sin Central, Norte el día entero).`,
  );
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
