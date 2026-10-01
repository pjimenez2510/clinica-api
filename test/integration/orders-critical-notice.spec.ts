import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaDiagnosticReportRepository } from '../../src/modules/orders/infrastructure/prisma-diagnostic-report.repository';
import { PrismaExamCatalogueRepository } from '../../src/modules/orders/infrastructure/prisma-exam-catalogue.repository';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import { DiagnosticReportService } from '../../src/modules/orders/application/diagnostic-report.service';
import type { Requester } from '../../src/modules/orders/application/service-order.service';
import type { AccessAuditRecorder } from '../../src/shared/audit/access-audit.port';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { aScene } from './orders-fixtures';
import { useDatabase } from './setup/database';
import { createUser } from './setup/fixtures';

/**
 * The notice of a critical value against a real PostgreSQL (ORD-062 to
 * ORD-065, A.M. 00002393 art. 39).
 *
 * WHAT ONLY THE DATABASE CAN DEMONSTRATE HERE: that the notice cannot be
 * rewritten or removed once written (ORD-064) — the trigger, not the absence of
 * an update route — and that a site's policy cannot be set outside its range
 * by whatever bypasses the application.
 */
const db = useDatabase();

const silentAudit: AccessAuditRecorder = { record: () => Promise.resolve() };

const noopLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function serviceOf(prisma: PrismaClient) {
  const client = prisma as unknown as PrismaService;
  return {
    reports: new DiagnosticReportService(
      new PrismaDiagnosticReportRepository(client),
      new PrismaServiceOrderRepository(client),
      new PrismaExamCatalogueRepository(client),
      silentAudit,
      noopLogger as never,
    ),
    orders: new PrismaServiceOrderRepository(client),
    store: new PrismaDiagnosticReportRepository(client),
  };
}

/** A glucose of 25 mg/dL — critical low — registered an hour before `now`. */
async function aCriticalGlucose(prisma: PrismaClient, now: Date) {
  const scene = await aScene(prisma);
  const { reports, orders } = serviceOf(prisma);
  const requester: Requester = { userId: 'user-1', sites: 'all' };

  const order = await orders.place({
    encounterId: scene.encounter.id,
    category: 'LABORATORY',
    priority: 'ROUTINE',
    lines: [{ examDefinitionId: scene.glucose.id }],
    sites: 'all',
  });
  const report = await reports.register(
    {
      orderId: order.id,
      performedById: null,
      issuedAt: new Date(now.getTime() - 3_600_000),
      results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 25 }],
    },
    requester,
  );
  const result = report.results[0]!;
  expect(result.abnormalFlag).toBe('CRITICAL_LOW');

  return { ...scene, order, report, result };
}

describe('la constancia del aviso de un valor crítico contra PostgreSQL', () => {
  it('ORD-064 no deja reescribir ni borrar la constancia del aviso, ni por SQL directo', async () => {
    const prisma = db();
    const now = new Date();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);

    // Control positivo: la constancia ENTRA.
    const notice = await prisma.criticalResultNotice.create({
      data: {
        observationResultId: BigInt(scene.result.id),
        recipientKind: 'PATIENT',
        recipientName: 'La paciente',
        channel: 'PHONE',
        notifiedById: nurse.id,
        notifiedAt: now,
      },
    });
    expect(await prisma.criticalResultNotice.count()).toBe(1);

    // Y no se reescribe ni se borra: una constancia que se puede cambiar no
    // prueba nada.
    await expect(
      prisma.$executeRaw`
        UPDATE "critical_result_notice" SET "recipient_name" = 'Otra persona'
        WHERE "id" = ${notice.id}::uuid`,
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRaw`
        DELETE FROM "critical_result_notice" WHERE "id" = ${notice.id}::uuid`,
    ).rejects.toThrow(/append-only/);

    const stored = await prisma.criticalResultNotice.findUniqueOrThrow({
      where: { id: notice.id },
    });
    expect(stored.recipientName).toBe('La paciente');
  });

  it('ORD-062 no admite una constancia sin nombre de a quién se avisó', async () => {
    const prisma = db();
    const now = new Date();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const data = {
      observationResultId: BigInt(scene.result.id),
      recipientKind: 'PATIENT' as const,
      channel: 'PHONE' as const,
      notifiedById: nurse.id,
      notifiedAt: now,
    };

    await expect(
      prisma.criticalResultNotice.create({
        data: { ...data, recipientName: '   ' },
      }),
    ).rejects.toThrow();
    // Control positivo: con nombre, entra por el mismo camino.
    await prisma.criticalResultNotice.create({
      data: { ...data, recipientName: 'La paciente' },
    });
    expect(await prisma.criticalResultNotice.count()).toBe(1);
  });

  it('ORD-063 y ORD-046 acotan en la base el plazo de aviso y el de los sin orden', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const where = { siteId: scene.site.id };

    // Lo que trae una sede nueva: sin plazo de críticos (D-111) y 24 h para
    // los sin orden (D-050 §4).
    const fresh = await prisma.siteParameter.findUniqueOrThrow({ where });
    expect(fresh.criticalNoticeWithinMinutes).toBeNull();
    expect(fresh.unmatchedResultDeadlineHours).toBe(24);
    expect(fresh.unmatchedResultOwnerRoleId).toBeNull();

    // Control positivo en los extremos del rango.
    await prisma.siteParameter.update({
      where,
      data: { criticalNoticeWithinMinutes: 5, unmatchedResultDeadlineHours: 168 }, // prettier-ignore
    });
    await prisma.siteParameter.update({
      where,
      data: { criticalNoticeWithinMinutes: 1440, unmatchedResultDeadlineHours: 1 }, // prettier-ignore
    });

    await expect(
      prisma.siteParameter.update({ where, data: { criticalNoticeWithinMinutes: 4 } }), // prettier-ignore
    ).rejects.toThrow();
    await expect(
      prisma.siteParameter.update({ where, data: { unmatchedResultDeadlineHours: 0 } }), // prettier-ignore
    ).rejects.toThrow();
    await expect(
      prisma.siteParameter.update({ where, data: { unmatchedResultDeadlineHours: 169 } }), // prettier-ignore
    ).rejects.toThrow();
  });
});
