import { describe, expect, it } from 'vitest';

import { PrismaDiagnosticReportRepository } from '../../src/modules/orders/infrastructure/prisma-diagnostic-report.repository';
import { PrismaExamCatalogueRepository } from '../../src/modules/orders/infrastructure/prisma-exam-catalogue.repository';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import { DiagnosticReportService } from '../../src/modules/orders/application/diagnostic-report.service';
import type { Requester } from '../../src/modules/orders/application/service-order.service';
import { addDays, clinicalDateOf } from '../../src/shared/domain/clinic-time';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { aScene, placeIssued } from './orders-fixtures';
import { useDatabase } from './setup/database';
import { createEncounter } from './setup/fixtures';

/**
 * EN-221, ORD-127 (D-138.1). The attention freezes the whole age in days and
 * whether the birth date was an estimate; the laboratory flag chooses its
 * range by them. Against PostgreSQL: the trigger is what freezes them.
 */
const db = useDatabase();
const requester: Requester = { userId: 'user-1', sites: 'all' };
const noopLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** «Hace `days` días» en Ecuador, como fecha de nacimiento. */
const bornDaysAgo = (now: Date, days: number) =>
  new Date(addDays(clinicalDateOf(now), -days));

/** Days in a window written in months or years, as the screen stores them. */
const below = (amount: number, perUnit: number) =>
  Math.round(amount * perUnit) - 1;
const MONTH = 365.25 / 12;
const YEAR = 365.25;

describe('la edad congelada en la atención contra PostgreSQL', () => {
  it('EN-221 la atención congela la edad entera en días y si la fecha era estimada, y no deja cambiarlas', async () => {
    const prisma = db();
    const now = new Date();
    const scene = await aScene(prisma);
    await prisma.patient.update({
      where: { id: scene.patient.id },
      data: { birthDate: bornDaysAgo(now, 400), birthDateEstimated: true },
    });
    const encounter = await prisma.encounter.create({
      data: {
        siteId: scene.site.id,
        practitionerId: scene.practitioner.id,
        patientId: scene.patient.id,
        startedAt: now,
        careModality: 'MORBIDITY',
        visitSequence: 'SUBSEQUENT',
      },
      select: { id: true, ageInDays: true, ageEstimated: true },
    });

    expect(encounter.ageInDays).toBe(400);
    expect(encounter.ageEstimated).toBe(true);
    await expect(
      prisma.$executeRaw`UPDATE "encounter" SET "age_in_days" = 10 WHERE "id" = ${encounter.id}::uuid`,
    ).rejects.toThrow(/EN-221/);
    await expect(
      prisma.$executeRaw`UPDATE "encounter" SET "age_estimated" = false WHERE "id" = ${encounter.id}::uuid`,
    ).rejects.toThrow(/EN-221/);
    // Control positivo: otra columna de la atención sí cambia.
    await prisma.encounter.update({
      where: { id: encounter.id },
      data: { careSetting: 'EXTRAMURAL' },
    });
  });

  it('ORD-127 corregir la fecha de la ficha no cambia la edad con que se clasifica; una atención nueva sí la toma', async () => {
    const prisma = db();
    const now = new Date();
    const scene = await aScene(prisma);
    // Un rango de lactante, escrito en meses: hasta los 18 meses, 50–80.
    await prisma.analyteReferenceRange.create({
      data: {
        analyteDefinitionId: scene.glu.id,
        rangeKind: 'REFERENCE',
        low: '50',
        high: '80',
        ageMinDays: 0,
        ageMaxDays: below(18, MONTH),
        validFrom: new Date(),
      },
    });
    await prisma.patient.update({
      where: { id: scene.patient.id },
      data: { birthDate: bornDaysAgo(now, 400) },
    });
    const infant = await createEncounter(prisma, {
      siteId: scene.site.id,
      practitionerId: scene.practitioner.id,
      patientId: scene.patient.id,
    });
    const service = serviceOf(prisma);
    const firstOrder = await placeIssued(service.orders, {
      encounterId: infant.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.glucose.id }],
      sites: 'all',
    });

    // La ficha se rectifica: tenía diez años, no trece meses.
    await prisma.patient.update({
      where: { id: scene.patient.id },
      data: { birthDate: bornDaysAgo(now, 3700) },
    });

    const glucose = [{ analyteDefinitionId: scene.glu.id, valueNumeric: 85 }];
    const issuedAt = new Date(now.getTime() - 60 * 60 * 1000);
    const frozen = await service.reports.register(
      {
        orderId: firstOrder.id,
        performedById: null,
        issuedAt,
        results: glucose,
      },
      requester,
      now,
    );
    // Con la edad congelada (13 meses), el rango del lactante: alta.
    expect(frozen.results[0]?.abnormalFlag).toBe('HIGH');

    // Control positivo: una atención nueva toma la fecha rectificada.
    const later = await prisma.encounter.create({
      data: {
        siteId: scene.site.id,
        practitionerId: scene.practitioner.id,
        patientId: scene.patient.id,
        startedAt: now,
        careModality: 'MORBIDITY',
        visitSequence: 'SUBSEQUENT',
      },
    });
    const secondOrder = await placeIssued(service.orders, {
      encounterId: later.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.glucose.id }],
      sites: 'all',
    });
    const fresh = await service.reports.register(
      {
        orderId: secondOrder.id,
        performedById: null,
        issuedAt,
        results: glucose,
      },
      requester,
      now,
    );
    expect(fresh.results[0]?.abnormalFlag).toBe('NORMAL');
  });

  it('ORD-127 con fecha estimada no se aplica un rango en meses, y sí uno en años', async () => {
    const prisma = db();
    const now = new Date();
    const scene = await aScene(prisma, { sex: 'FEMALE' });
    await prisma.patient.update({
      where: { id: scene.patient.id },
      data: { birthDate: bornDaysAgo(now, 400), birthDateEstimated: true },
    });
    // Glucosa: un rango de lactante escrito en MESES (hasta 18), 50–80.
    await prisma.analyteReferenceRange.create({
      data: {
        analyteDefinitionId: scene.glu.id,
        rangeKind: 'REFERENCE',
        low: '50',
        high: '80',
        ageMinDays: 0,
        ageMaxDays: below(18, MONTH),
        validFrom: new Date(),
      },
    });
    // Hemoglobina: uno de niña escrito en AÑOS (hasta 2), 10–13.
    await prisma.analyteReferenceRange.create({
      data: {
        analyteDefinitionId: scene.hb.id,
        sex: 'FEMALE',
        rangeKind: 'REFERENCE',
        low: '10.0',
        high: '13.0',
        ageMinDays: 0,
        ageMaxDays: below(2, YEAR),
        validFrom: new Date(),
      },
    });
    const encounter = await prisma.encounter.create({
      data: {
        siteId: scene.site.id,
        practitionerId: scene.practitioner.id,
        patientId: scene.patient.id,
        startedAt: now,
        careModality: 'MORBIDITY',
        visitSequence: 'SUBSEQUENT',
      },
    });
    const service = serviceOf(prisma);
    const order = await placeIssued(service.orders, {
      encounterId: encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [
        { examDefinitionId: scene.glucose.id },
        { examDefinitionId: scene.bh.id },
      ],
      sites: 'all',
    });

    const report = await service.reports.register(
      {
        orderId: order.id,
        performedById: null,
        issuedAt: new Date(now.getTime() - 60 * 60 * 1000),
        results: [
          { analyteDefinitionId: scene.glu.id, valueNumeric: 85 },
          { analyteDefinitionId: scene.hb.id, valueNumeric: 11.0 },
        ],
      },
      requester,
      now,
    );
    const flagOf = (name: string) =>
      report.results.find((r) => r.analyteDisplay === name)?.abnormalFlag;

    // La edad es una estimación: el rango en meses no se elige con ella, y
    // queda el general (70–100).
    expect(flagOf('Glucosa en ayunas')).toBe('NORMAL');
    // Control positivo: el rango en años sí (con el general de mujer, 12–15,5,
    // 11,0 saldría baja).
    expect(flagOf('Hemoglobina')).toBe('NORMAL');
  });
});

function serviceOf(prisma: ReturnType<typeof db>) {
  const client = prisma as unknown as PrismaService;
  return {
    reports: new DiagnosticReportService(
      new PrismaDiagnosticReportRepository(client),
      new PrismaServiceOrderRepository(client),
      new PrismaExamCatalogueRepository(client),
      { record: () => Promise.resolve() },
      noopLogger as never,
    ),
    orders: new PrismaServiceOrderRepository(client),
  };
}
