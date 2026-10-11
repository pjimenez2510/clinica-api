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

import { aRecordReadPermission, aScene, placeIssued } from './orders-fixtures';
import { useDatabase } from './setup/database';
import { createUser } from './setup/fixtures';

/**
 * ORD-179 (D-207 §2) against PostgreSQL: the site's on-call for critical
 * values can be a PERSON. Whether that person can answer —an active account
 * holding `record:read` at the site or at all— is the database's, and so is
 * «a role or a person, never both» (`site_parameter_one_escalation`).
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
  return { scene, reports, asNurse, order, report, result: report.results[0]! };
}

/** An account that can read the record at `siteId`: on-call material. */
async function aClinician(prisma: PrismaClient, siteId: string) {
  await aRecordReadPermission(prisma);
  const role = await prisma.role.create({
    data: {
      code: `CLINICO_${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: 'Clínico',
      permissions: { create: [{ permissionCode: 'record:read' }] },
    },
  });
  const user = await createUser(prisma);
  await prisma.user.update({ where: { id: user.id }, data: { firstName: 'Lucía', lastName: 'Toapanta' } }); // prettier-ignore
  await prisma.userRoleGrant.create({ data: { userId: user.id, roleId: role.id, siteId } }); // prettier-ignore
  return { user, role };
}

describe('ORD-179, la guardia nominal', () => {
  it('ORD-179 vencido el crítico, el aviso toca a la persona de guardia y la entrada la nombra', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const { user: lucia } = await aClinician(prisma, ctx.scene.site.id);
    // Control positivo: sin guardia, la escalada dice que falta.
    const [before] = await ctx.reports.critical(ctx.asNurse, new Date());
    expect(before).toMatchObject({ overdue: true, escalationMissing: true, escalateToPerson: null }); // prettier-ignore

    await prisma.siteParameter.update({ where: { siteId: ctx.scene.site.id }, data: { criticalEscalationUserId: lucia.id } }); // prettier-ignore
    const [mine] = await ctx.reports.critical({ userId: lucia.id, sites: 'all' }, new Date()); // prettier-ignore
    expect(mine).toMatchObject({
      noticeTarget: 'ON_CALL_ROLE',
      escalationMissing: false,
      escalateTo: null,
      escalateToPerson: { userId: lucia.id, name: 'Lucía Toapanta' },
      dueToRequester: true,
    });
    const [theNurses] = await ctx.reports.critical(ctx.asNurse, new Date());
    expect(theNurses?.dueToRequester).toBe(false);
  });

  it('ORD-179 la persona inactiva o sin permiso de leer la historia en la sede no es guardia atendida', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const { user: lucia } = await aClinician(prisma, ctx.scene.site.id);
    const bystander = await createUser(prisma);
    await prisma.siteParameter.update({ where: { siteId: ctx.scene.site.id }, data: { criticalEscalationUserId: bystander.id } }); // prettier-ignore
    const [noRole] = await ctx.reports.critical(ctx.asNurse, new Date());
    expect(noRole).toMatchObject({ escalationMissing: true, dueToRequester: true }); // prettier-ignore

    await prisma.siteParameter.update({ where: { siteId: ctx.scene.site.id }, data: { criticalEscalationUserId: lucia.id } }); // prettier-ignore
    await prisma.user.update({ where: { id: lucia.id }, data: { active: false } }); // prettier-ignore
    const [inactive] = await ctx.reports.critical(ctx.asNurse, new Date());
    expect(inactive?.escalationMissing).toBe(true);
    // Control positivo: activa, sí.
    await prisma.user.update({ where: { id: lucia.id }, data: { active: true } }); // prettier-ignore
    const [active] = await ctx.reports.critical(ctx.asNurse, new Date());
    expect(active?.escalationMissing).toBe(false);
  });

  it('ORD-179 la cola de correcciones nombra a la persona de guardia para localizar al paciente', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const { user: lucia } = await aClinician(prisma, ctx.scene.site.id);
    await prisma.siteParameter.update({ where: { siteId: ctx.scene.site.id }, data: { criticalEscalationUserId: lucia.id } }); // prettier-ignore
    await ctx.reports.notify({ resultId: ctx.result.id, outcome: 'NOTIFIED', readBack: true, recipientKind: 'PATIENT', recipientName: 'La paciente', channel: 'PHONE', notifiedAt: minutesAgo(100) }, ctx.asNurse, new Date()); // prettier-ignore
    await ctx.reports.correct({ reportId: ctx.report.id, performedById: null, issuedAt: minutesAgo(90), results: [{ analyteDefinitionId: ctx.scene.glu.id, valueNumeric: 95 }] }, ctx.asNurse); // prettier-ignore

    const later = new Date(Date.now() + 61 * 60_000);
    const [entry] = await ctx.reports.corrections(ctx.asNurse, later);
    expect(entry).toMatchObject({ locateViaOnCall: true, escalationMissing: false, escalateToPerson: { userId: lucia.id } }); // prettier-ignore
  });

  it('ORD-179 la base no deja a una sede con rol y persona de guardia a la vez', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const { user: lucia, role } = await aClinician(prisma, ctx.scene.site.id);

    await expect(
      prisma.siteParameter.update({ where: { siteId: ctx.scene.site.id }, data: { criticalEscalationUserId: lucia.id, criticalEscalationRoleId: role.id } }), // prettier-ignore
    ).rejects.toThrow(/site_parameter_one_escalation/);
    // Control positivo: cada uno por separado entra.
    await prisma.siteParameter.update({ where: { siteId: ctx.scene.site.id }, data: { criticalEscalationRoleId: role.id } }); // prettier-ignore
    await prisma.siteParameter.update({ where: { siteId: ctx.scene.site.id }, data: { criticalEscalationRoleId: null, criticalEscalationUserId: lucia.id } }); // prettier-ignore
  });
});
