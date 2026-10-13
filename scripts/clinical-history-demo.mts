import { NestFactory } from '@nestjs/core';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

import { DEV_PASSWORD } from '../prisma/seed.mts';
import type { AppModule as AppModuleType } from '../src/app.module.ts';
import type { DiagnosticReportService as ReportsType } from '../src/modules/orders/application/diagnostic-report.service.ts';
import type { PrismaServiceOrderRepository as OrdersType } from '../src/modules/orders/infrastructure/prisma-service-order.repository.ts';
import type { PrismaService as PrismaType } from '../src/shared/infrastructure/prisma/prisma.service.ts';

import { provenDevLogin } from './dev-api-target.mts';

// The COMPILED application (`dist/`, written by `pnpm start:dev` or `pnpm
// build`): Node strips types but does not run decorators, and the orders
// service is what computes each flag — it is used, not imitated.
const compiled = createRequire(import.meta.url);
const { AppModule } = compiled('../dist/app.module.js') as { AppModule: typeof AppModuleType }; // prettier-ignore
const { DiagnosticReportService } = compiled('../dist/modules/orders/application/diagnostic-report.service.js') as { DiagnosticReportService: typeof ReportsType }; // prettier-ignore
const { PrismaServiceOrderRepository } = compiled('../dist/modules/orders/infrastructure/prisma-service-order.repository.js') as { PrismaServiceOrderRepository: typeof OrdersType }; // prettier-ignore
const { PrismaService } = compiled('../dist/shared/infrastructure/prisma/prisma.service.js') as { PrismaService: typeof PrismaType }; // prettier-ignore

/**
 * SC-097, and the patient the principal walks (D-227 §2). DEVELOPMENT ONLY.
 *
 * Creates, once, an INVENTED patient («Historia Demostración», MRN
 * `HC-DEMO-B1`) with 60 attentions a month apart, about 300 laboratory
 * results registered through the orders service itself (so every flag is the
 * one the laboratory path computes) and 60 issued prescriptions; and, every
 * run, an open attention of today with `medico@` to walk Historia and
 * Evolución. Then it reads `GET /patients/:id/clinical-history` 50 times as
 * `medico@` and prints the P95.
 *
 *   pnpm history:demo            (API_URL and DATABASE_URL from .env; needs
 *                                 `dist/`: the API running with start:dev)
 *
 * `provenDevLogin` refuses unless the API on API_URL writes to this
 * checkout's database, and never the shared `clinica`.
 */
if (process.env.NODE_ENV === 'production') {
  console.error('Este guion es solo de desarrollo.');
  process.exit(1);
}

const { values } = parseArgs({
  options: { reads: { type: 'string', default: '50' } },
  allowPositionals: true,
  strict: false,
});
const READS = Number(values.reads);
const MRN = 'HC-DEMO-B1';
const DAY = 86_400_000;

const session = await provenDevLogin({
  env: process.env,
  argv: process.argv,
  email: 'medico@clinica.ec',
  password: DEV_PASSWORD,
});

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: false,
});
const prisma = app.get(PrismaService);
const reports = app.get(DiagnosticReportService, { strict: false });
const orders = new PrismaServiceOrderRepository(prisma);

const doctor = await prisma.practitioner.findFirstOrThrow({
  where: { user: { email: 'medico@clinica.ec' } },
  select: { id: true, userId: true, sites: { select: { siteId: true } } },
});
const siteId = doctor.sites[0]?.siteId;
if (!siteId) throw new Error('medico@ no tiene sede en la semilla');
const everywhere = { userId: doctor.userId, sites: 'all' as const };

/** A small deterministic wobble, so the curves are not straight lines. */
const wobble = (i: number, size: number) => Math.round(Math.sin(i * 1.7) * size * 10) / 10; // prettier-ignore

async function analyte(code: string) {
  return prisma.analyteDefinition.findUniqueOrThrow({ where: { code }, select: { id: true } }); // prettier-ignore
}
async function service(code: string) {
  return prisma.service.findUniqueOrThrow({ where: { code }, select: { id: true } }); // prettier-ignore
}

let patient = await prisma.patient.findFirst({ where: { mrn: MRN } });
if (!patient) {
  patient = await prisma.patient.create({
    data: {
      mrn: MRN,
      familyName: 'Demostración',
      givenName: 'Historia',
      sex: 'FEMALE',
      birthDate: new Date('1968-05-20'), // fecha-fija: nacimiento inventado
    },
  });

  const glucoseExam = await service('LAB-GLUCOSA-AYUNAS');
  const bloodCount = await service('LAB-BH');
  const glu = await analyte('GLU');
  const counts = await Promise.all(
    ['HB', 'HCT', 'WBC', 'PLT', 'NEUT-PCT', 'LYMPH-PCT'].map(analyte),
  );
  const bloodCountValues = (i: number) => [
    12.8 + wobble(i, 1.2), // HB
    39 + wobble(i, 3), // HCT
    7.2 + wobble(i, 2.5), // WBC
    260 + wobble(i, 60), // PLT
    58 + wobble(i, 12), // NEUT
    31 + wobble(i, 9), // LYMPH
  ];

  for (let i = 59; i >= 0; i -= 1) {
    const startedAt = new Date(Date.now() - (i * 30 + 2) * DAY);
    const encounter = await prisma.encounter.create({
      data: {
        siteId,
        practitionerId: doctor.id,
        patientId: patient.id,
        startedAt,
        careModality: 'MORBIDITY',
        visitSequence: i === 59 ? 'FIRST_TIME' : 'SUBSEQUENT',
      },
    });
    await prisma.encounterVitals.create({
      data: {
        encounterId: encounter.id,
        measuredAt: startedAt,
        presentingComplaint: i % 3 === 0 ? 'Control de diabetes' : 'Control de presión arterial', // prettier-ignore
        weightKg: 74 - i * 0.1,
        systolicBp: 138 + Math.round(wobble(i, 8)),
        diastolicBp: 86 + Math.round(wobble(i, 5)),
        recordedById: doctor.userId,
      },
    });

    const lines = [{ serviceId: glucoseExam.id }];
    if (i < 40) lines.push({ serviceId: bloodCount.id });
    const draft = await orders.compose({
      encounterId: encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines,
      sites: 'all',
    });
    const order = await orders.issue({ orderId: draft.id, revision: draft.revision, sites: 'all' }); // prettier-ignore
    const results = [
      // A glucose that climbs over five years, out of range at the end.
      { analyteDefinitionId: glu.id, valueNumeric: Math.round(96 + (59 - i) * 1.4 + wobble(i, 6)) }, // prettier-ignore
      ...(i < 40
        ? bloodCountValues(i).map((value, k) => ({ analyteDefinitionId: counts[k]!.id, valueNumeric: value })) // prettier-ignore
        : []),
    ];
    await reports.register(
      { orderId: order.id, performedById: null, issuedAt: new Date(startedAt.getTime() + 3_600_000), results }, // prettier-ignore
      everywhere,
    );

    const draftRx = await prisma.prescription.create({
      data: {
        encounterId: encounter.id,
        siteId,
        prescriberId: doctor.id,
        items: {
          create: [
            { genericName: 'Enalapril', concentration: '10 mg', presentation: 'Tableta', doseText: '1 tableta', frequencyText: 'Cada 12 horas', durationDays: 30, offFormulary: true }, // prettier-ignore
            ...(i % 3 === 0
              ? [{ genericName: 'Metformina', concentration: '850 mg', presentation: 'Tableta', doseText: '1 tableta', frequencyText: 'Con el almuerzo', durationDays: i < 6 ? null : 90, offFormulary: true }] // prettier-ignore
              : []),
            ...(i === 8
              ? [{ genericName: 'Amoxicilina', concentration: '500 mg', presentation: 'Cápsula', doseText: '1 cápsula', frequencyText: 'Cada 8 horas', durationDays: 7, offFormulary: true }] // prettier-ignore
              : []),
          ],
        },
      },
    });
    await prisma.prescription.update({
      where: { id: draftRx.id },
      data: { status: 'ACTIVE', issuedAt: new Date(startedAt.getTime() + 1_800_000) }, // prettier-ignore
    });

    const noteId = (await prisma.$queryRaw<{ id: string }[]>`SELECT uuidv7()::text AS id`)[0]!.id; // prettier-ignore
    await prisma.clinicalNote.create({
      data: { id: noteId, chainId: noteId, encounterId: encounter.id, formCode: '002', formVersion: '1', content: { motivoConsulta: 'Control' }, authorId: doctor.id }, // prettier-ignore
    });
    await prisma.encounter.update({
      where: { id: encounter.id },
      data: { status: 'DISCHARGED', dischargeCondition: 'ALIVE', endedAt: new Date(startedAt.getTime() + 2_400_000) }, // prettier-ignore
    });
  }
  console.log(`Paciente de demostración creado: ${MRN}`);
}

// Today's attention, open, to walk Historia and Evolución.
const today = await prisma.encounter.findFirst({
  where: { patientId: patient.id, status: 'OPEN', startedAt: { gte: new Date(Date.now() - DAY / 2) } }, // prettier-ignore
  select: { id: true },
});
const encounterId =
  today?.id ??
  (
    await prisma.encounter.create({
      data: { siteId, practitionerId: doctor.id, patientId: patient.id, startedAt: new Date(), careModality: 'MORBIDITY', visitSequence: 'SUBSEQUENT' }, // prettier-ignore
      select: { id: true },
    })
  ).id;

await app.close();

const timings: number[] = [];
interface MeasuredBody {
  results: { total: number };
  medications: { items: unknown[] };
  timeline: unknown[];
}
let body: MeasuredBody | null = null;
for (let i = 0; i < READS + 5; i += 1) {
  // The general limit is 30 requests per 10 s (`rate-limit.ts`): paced under
  // it. The pause is outside the timed span, so it changes nothing measured.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const started = performance.now();
  const response = await fetch(
    `${session.apiUrl}/api/v1/patients/${patient.id}/clinical-history`,
    { headers: { Authorization: `Bearer ${session.accessToken}` } },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  body = (await response.json()) as MeasuredBody;
  // The first five warm the connection and the query plans; not measured.
  if (i >= 5) timings.push(performance.now() - started);
}
timings.sort((a, b) => a - b);
const p = (q: number) => timings[Math.min(timings.length - 1, Math.ceil(q * timings.length) - 1)]!; // prettier-ignore

console.log(
  JSON.stringify(
    {
      patientId: patient.id,
      encounterId,
      walk: `/atencion/${encounterId}?seccion=historia`,
      results: body?.results.total,
      medications: body?.medications.items.length,
      timelineDays: body?.timeline.length,
      reads: timings.length,
      p50Ms: Math.round(p(0.5) * 10) / 10,
      p95Ms: Math.round(p(0.95) * 10) / 10,
      maxMs: Math.round(timings[timings.length - 1]! * 10) / 10,
    },
    null,
    2,
  ),
);
