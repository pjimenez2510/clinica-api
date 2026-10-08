import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * DEVELOPMENT ONLY. Leaves something in caja's «Por cobrar» (billing BI-181,
 * BI-182) to try by hand: at Sede Norte, one visit of today that ended with
 * something written, and one interrupted before anything was done. Without
 * it the list is empty until somebody closes a consultation on screen.
 *
 * The attended visit also leaves a fasting-glucose order IN DRAFT that the
 * doctor never issued (D-123.6): the account shows its notice (BI-192) and
 * the doctor finds it under «Sus órdenes sin emitir» (ORD-115).
 *
 * Run after `db:seed`, `db:seed:patients` and `db:seed:agenda`. Idempotent:
 * if the site already has a visit ended today, nothing is added.
 *
 * The visits are opened, written in while open (a note cannot be added to a
 * visit that is over) and then ended — the order the clinical tables enforce.
 */

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

/** Midnight in Ecuador of today's clinic date. Mainland Ecuador has no DST. */
function startOfTodayInClinic(now = new Date()): Date {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return new Date(`${day}T00:00:00-05:00`);
}

async function main(): Promise<void> {
  const site = await prisma.site.findFirst({ where: { name: 'Sede Norte' } });
  const doctor = await prisma.practitioner.findFirst({
    where: { user: { email: 'medico@clinica.ec' } },
  });
  const author = await prisma.user.findFirst({
    where: { email: 'admin@clinica.ec' },
  });
  const patients = await prisma.patient.findMany({
    where: { identifiers: { some: { type: 'CEDULA' } } },
    orderBy: { mrn: 'asc' },
    take: 2,
  });
  if (!site || !doctor || !author || patients.length < 2) {
    throw new Error(
      'Falta la siembra previa: corra db:seed, db:seed:patients y db:seed:agenda.',
    );
  }

  const already = await prisma.encounter.count({
    where: { siteId: site.id, endedAt: { gte: startOfTodayInClinic() } },
  });
  if (already > 0) {
    console.log('Caja: Sede Norte ya tiene atenciones terminadas hoy.');
    return;
  }

  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);

  // 1. Attended and discharged: «Por cobrar», sin pasar a caja.
  const attended = await prisma.encounter.create({
    data: {
      siteId: site.id,
      practitionerId: doctor.id,
      patientId: patients[0]!.id,
      startedAt: at(40),
      careModality: 'MORBIDITY',
      visitSequence: 'FIRST_TIME',
    },
  });
  const noteId = randomUUID();
  await prisma.clinicalNote.create({
    data: {
      id: noteId,
      chainId: noteId,
      encounterId: attended.id,
      formCode: '002',
      formVersion: '1',
      content: { motivoConsulta: 'Control de presión arterial' },
      authorId: doctor.id,
    },
  });
  // BI-192, ORD-115. A draft written while the visit was open, never issued.
  // ORD-163. Its name and tariff code are its service's.
  const glucoseRow = await prisma.examDefinition.findUnique({
    where: { code: 'EX-GLUCOSA-AYUNAS' },
    select: {
      code: true,
      billableService: { select: { name: true, tariffCode: true } },
    },
  });
  const glucose = glucoseRow && {
    code: glucoseRow.code,
    name: glucoseRow.billableService.name,
    tariffCode: glucoseRow.billableService.tariffCode,
  };
  const [tariff] = glucose?.tariffCode
    ? await prisma.$queryRaw<{ id: string }[]>`
        SELECT cc."id"::text AS id
          FROM "catalog_concept" cc
          JOIN "catalog_system" cs ON cs."id" = cc."system_id" AND cs."code" = 'TARIFF'
         WHERE cc."code" = ${glucose.tariffCode}
         ORDER BY lower(cc."valid_period") DESC
         LIMIT 1`
    : [];
  if (glucose && tariff) {
    await prisma.serviceOrder.create({
      data: {
        encounterId: attended.id,
        siteId: site.id,
        orderedById: doctor.id,
        category: 'LABORATORY',
        status: 'DRAFT',
        requestedAt: at(20),
        items: {
          create: {
            conceptId: tariff.id,
            testCode: glucose.code,
            testDisplay: glucose.name,
          },
        },
      },
    });
  }
  await prisma.encounter.update({
    where: { id: attended.id },
    data: {
      status: 'DISCHARGED',
      dischargeCondition: 'ALIVE',
      endedAt: at(10),
    },
  });

  // 2. Interrupted before anything was done: listed, saying why nothing is
  // proposed (BI-182).
  const left = await prisma.encounter.create({
    data: {
      siteId: site.id,
      practitionerId: doctor.id,
      patientId: patients[1]!.id,
      startedAt: at(30),
      careModality: 'MORBIDITY',
      visitSequence: 'FIRST_TIME',
    },
  });
  await prisma.encounter.update({
    where: { id: left.id },
    data: {
      status: 'DISCONTINUED',
      endedAt: at(25),
      discontinuedReason: 'Se fue antes de ser atendido',
      discontinuedOrigin: 'PATIENT',
      discontinuedById: author.id,
      discontinuedAt: at(25),
    },
  });

  console.log(
    'Caja: 2 atenciones terminadas hoy en Sede Norte para «Por cobrar» (una atendida, con una orden de exámenes en borrador sin emitir; una sin acto clínico).',
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
