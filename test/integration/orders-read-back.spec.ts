import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { DiagnosticReportService } from '../../src/modules/orders/application/diagnostic-report.service';
import type { Requester } from '../../src/modules/orders/application/service-order.service';
import { PrismaDiagnosticReportRepository } from '../../src/modules/orders/infrastructure/prisma-diagnostic-report.repository';
import { PrismaExamCatalogueRepository } from '../../src/modules/orders/infrastructure/prisma-exam-catalogue.repository';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import type { AccessAuditRecorder } from '../../src/shared/audit/access-audit.port';
import { InProcessLiveEventBus } from '../../src/shared/events/live-event-bus';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { aScene, placeIssued } from './orders-fixtures';
import { useDatabase } from './setup/database';
import { createUser } from './setup/fixtures';

/**
 * ORD-177 (D-207 §2) against PostgreSQL: the read-back is a setting of the
 * site, off by default. Off, a notice given is kept saying whether it was
 * confirmed; on, it is refused without it — by the service with its sentence,
 * and by `trg_critical_result_notice_read_back_by_site` for whatever arrives
 * by another road.
 */
const db = useDatabase();

const silentAudit: AccessAuditRecorder = { record: () => Promise.resolve() };
const noopLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

function serviceOf(prisma: PrismaClient) {
  const client = prisma as unknown as PrismaService;
  return {
    reports: new DiagnosticReportService(
      new PrismaDiagnosticReportRepository(client),
      new PrismaServiceOrderRepository(client),
      new PrismaExamCatalogueRepository(client),
      silentAudit,
      noopLogger as never,
      new InProcessLiveEventBus(),
    ),
    orders: new PrismaServiceOrderRepository(client),
  };
}

/** A critical glucose on a new order, and a nurse who records the notice. */
async function aCriticalGlucose(prisma: PrismaClient) {
  const scene = await aScene(prisma);
  const { reports, orders } = serviceOf(prisma);
  const nurse = await createUser(prisma);
  const asNurse: Requester = { userId: nurse.id, sites: 'all' };
  const order = await placeIssued(orders, {
    encounterId: scene.encounter.id,
    category: 'LABORATORY',
    priority: 'ROUTINE',
    lines: [{ serviceId: scene.glucose.id }],
    sites: 'all',
  });
  const report = await reports.register(
    {
      orderId: order.id,
      performedById: null,
      issuedAt: minutesAgo(120),
      results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 25 }],
    },
    asNurse,
  );
  return { scene, reports, asNurse, order, result: report.results[0]! };
}

const given = {
  outcome: 'NOTIFIED' as const,
  recipientKind: 'PATIENT' as const,
  recipientName: 'La paciente',
  channel: 'PHONE' as const,
};

async function requireReadBack(prisma: PrismaClient, siteId: string) {
  await prisma.siteParameter.update({
    where: { siteId },
    data: { criticalReadBackRequired: true },
  });
}

describe('ORD-177, el read-back por sede', () => {
  it('ORD-177 apagado de fábrica: el aviso hecho se guarda sin read-back y dice si se confirmó', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    expect(
      (await prisma.siteParameter.findUniqueOrThrow({ where: { siteId: ctx.scene.site.id } })).criticalReadBackRequired, // prettier-ignore
    ).toBe(false);

    const without = await ctx.reports.notify({ resultId: ctx.result.id, ...given }, ctx.asNurse, new Date()); // prettier-ignore
    expect(without.readBackConfirmed).toBe(false);
    // Y sale de la cola: el aviso está hecho.
    expect(await ctx.reports.critical(ctx.asNurse, new Date())).toEqual([]);
    const confirmed = await ctx.reports.notify({ resultId: ctx.result.id, ...given, readBack: true }, ctx.asNurse, new Date()); // prettier-ignore
    expect(confirmed.readBackConfirmed).toBe(true);
  });

  it('ORD-177 encendido en la sede, el servicio y la base rechazan el aviso hecho sin read-back', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    await requireReadBack(prisma, ctx.scene.site.id);

    await expect(
      ctx.reports.notify({ resultId: ctx.result.id, ...given }, ctx.asNurse, new Date()), // prettier-ignore
    ).rejects.toMatchObject({ code: 'CRITICAL_READ_BACK_REQUIRED' });
    const insert = (readBack: boolean) => prisma.$executeRaw`
      INSERT INTO "critical_result_notice"
        ("observation_result_id", "recipient_kind", "recipient_name", "channel",
         "notified_by_id", "notified_at", "outcome", "read_back_confirmed",
         "after_hours", "self_notice")
      VALUES (${BigInt(ctx.result.id)}, 'PATIENT', 'La paciente', 'PHONE',
              ${ctx.asNurse.userId}::uuid, now(), 'NOTIFIED', ${readBack},
              false, false)`;
    await expect(insert(false)).rejects.toThrow(/critical_result_notice_read_back_by_site/); // prettier-ignore
    // Control positivo: el mismo camino, confirmado, entra.
    await expect(insert(true)).resolves.toBe(1);
    await expect(
      ctx.reports.notify({ resultId: ctx.result.id, ...given, readBack: true }, ctx.asNurse, new Date()), // prettier-ignore
    ).resolves.toMatchObject({ readBackConfirmed: true });
  });

  it('ORD-177 un intento sin respuesta sigue sin read-back, con la sede que lo exige', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    await requireReadBack(prisma, ctx.scene.site.id);

    await expect(
      ctx.reports.notify({ resultId: ctx.result.id, ...given, outcome: 'NO_ANSWER' }, ctx.asNurse, new Date()), // prettier-ignore
    ).resolves.toMatchObject({ outcome: 'NO_ANSWER', readBackConfirmed: null }); // prettier-ignore
  });

  it('ORD-177 la cola y la lectura de la orden dicen si la sede lo exige', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const [off] = await ctx.reports.critical(ctx.asNurse, new Date());
    expect(off?.readBackRequired).toBe(false);

    expect(await ctx.reports.readBackRequired(ctx.order.id, ctx.asNurse)).toBe(false); // prettier-ignore

    await requireReadBack(prisma, ctx.scene.site.id);
    const [on] = await ctx.reports.critical(ctx.asNurse, new Date());
    expect(on?.readBackRequired).toBe(true);
    expect(await ctx.reports.readBackRequired(ctx.order.id, ctx.asNurse)).toBe(true); // prettier-ignore
  });
});
