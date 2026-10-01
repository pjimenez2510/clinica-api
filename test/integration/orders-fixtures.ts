import type { PrismaClient } from '@prisma/client';

import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * The rows an order needs before it can exist, WITH THE VALUES OF THE REAL
 * SEED.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE SEED AND NOT ROUND NUMBERS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `prisma/seed-billing.mts` ships three complete exams, eighteen analytes and
 * twenty-one ranges, and two of those rows are the ones that decide whether
 * this module is correct: `HB`, whose reference range DIFFERS BY SEX
 * (13,0–17,0 `MALE`, 12,0–15,5 `FEMALE`), and `GLU`, which carries a CRITICAL
 * band (below 40, above 400). A fixture with `low: 10, high: 20` would test
 * the comparison operator and stop testing the case the clinic actually meets.
 *
 * ⚠️ THE SEED ITSELF IS NOT LOADED, and it cannot be: `useDatabase` truncates
 * every table between tests, which is what keeps a failure reproducible. So
 * the VALUES are copied and the file says so — if the seed's ranges change,
 * these must too, and the comment is where whoever changes them will look.
 *
 * ⚠️ SHARED BETWEEN THE TWO SUITES ON PURPOSE. A copy in each is two copies
 * that drift, and the one that drifts is the one nobody re-checks.
 */

/** A tariff concept, which is what `service_order_item.concept_id` demands. */
export async function aTariffConcept(
  prisma: PrismaClient,
  options: {
    code?: string;
    systemCode?: string;
    validFrom?: Date;
    validTo?: Date;
  } = {},
) {
  const systemCode = options.systemCode ?? 'TARIFF';
  const system = await prisma.catalogSystem.upsert({
    where: { code: systemCode },
    create: { code: systemCode, name: `Catálogo ${systemCode}` },
    update: {},
  });

  return prisma.catalogConcept.create({
    data: {
      systemId: system.id,
      code: options.code ?? `T-${Math.floor(Math.random() * 1e6)}`,
      display: 'Biometría hemática',
      // Vigente desde mucho antes de cualquier atención de los fixtures; las
      // pruebas que miran la vigencia pasan la suya.
      validFrom: options.validFrom ?? new Date('2020-01-01'), // fecha-fija: vigente desde siempre
      validTo: options.validTo ?? null,
    },
  });
}

/**
 * The exam and its analytes, WITH THE VALUES OF THE REAL SEED: `HB` split by
 * sex, `GLU` with a critical band. Round numbers would stop testing the case
 * the clinic will actually meet.
 */
export async function seedExams(prisma: PrismaClient) {
  const hb = await prisma.analyteDefinition.create({
    data: {
      code: 'HB',
      name: 'Hemoglobina',
      loincCode: '718-7',
      unit: 'g/dL',
      valueType: 'NUMERIC',
      decimals: 1,
      referenceRanges: {
        create: [
          { sex: 'MALE', rangeKind: 'REFERENCE', low: '13.0', high: '17.0' },
          { sex: 'FEMALE', rangeKind: 'REFERENCE', low: '12.0', high: '15.5' },
        ],
      },
    },
  });

  const glu = await prisma.analyteDefinition.create({
    data: {
      code: 'GLU',
      name: 'Glucosa en ayunas',
      loincCode: '2345-7',
      unit: 'mg/dL',
      valueType: 'NUMERIC',
      decimals: 0,
      referenceRanges: {
        create: [
          { rangeKind: 'REFERENCE', low: '70', high: '100' },
          { rangeKind: 'CRITICAL', low: '40', high: '400' },
        ],
      },
    },
  });

  const bh = await prisma.examDefinition.create({
    data: {
      code: 'EX-BH',
      // ORD-004. The tariff service the exam IS, by code: the catalogue is
      // versioned and the concept in force on the clinical date is resolved.
      tariffCode: 'EX-BH',
      name: 'Biometría hemática completa',
      form010Section: 'HEMATOLOGÍA',
      specimenType: 'Sangre total con EDTA',
      patientPreparation: 'No requiere ayuno.',
      turnaroundHours: 4,
      analytes: { create: [{ analyteDefinitionId: hb.id, position: 1 }] },
    },
  });

  const glucose = await prisma.examDefinition.create({
    data: {
      code: 'EX-GLUCOSA-AYUNAS',
      tariffCode: 'EX-GLUCOSA-AYUNAS',
      name: 'Glucosa en ayunas',
      form010Section: 'BIOQUÍMICA',
      patientPreparation: 'Ayuno de 8 a 12 horas.',
      // Deliberately WITHOUT a turnaround: ORD-022's third answer.
      analytes: { create: [{ analyteDefinitionId: glu.id, position: 1 }] },
    },
  });

  return { hb, glu, bh, glucose };
}

export async function aScene(
  prisma: PrismaClient,
  options: { sex?: 'MALE' | 'FEMALE' } = {},
) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma, { sex: options.sex ?? 'FEMALE' });
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  const exams = await seedExams(prisma);
  // ORD-004. One tariff service per exam, under the exam's tariff code.
  const concept = await aTariffConcept(prisma, { code: 'EX-BH' });
  await aTariffConcept(prisma, { code: 'EX-GLUCOSA-AYUNAS' });

  return { site, practitioner, patient, encounter, ...exams, concept };
}

export { createSite, createPatient };
