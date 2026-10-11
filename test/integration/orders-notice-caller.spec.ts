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
import { createSite, createUser } from './setup/fixtures';

/**
 * ORD-175 (D-168 §4) against PostgreSQL: who made the call is chosen from the
 * site's accounts —active, with a live role at that site or at all— or typed
 * with at least two words. Which accounts belong to a site is the database's
 * (`user_role_grant`), so only the database can show it.
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
  return { scene, reports, asNurse, result: report.results[0]! };
}

/** The role every account of these tests holds; created once per test. */
async function aStaffRole(prisma: PrismaClient) {
  return prisma.role.create({ data: { code: 'PERSONAL_SEDE', name: 'Personal de la sede' } }); // prettier-ignore
}

/** An account named `firstName lastName` holding `roleId` at `siteId` (null: all). */
async function anAccount(
  prisma: PrismaClient,
  roleId: string,
  name: { firstName: string; lastName: string },
  siteId: string | null,
  state: { active?: boolean; revoked?: boolean } = {},
) {
  const user = await createUser(prisma);
  await prisma.user.update({
    where: { id: user.id },
    data: { ...name, active: state.active ?? true },
  });
  await prisma.userRoleGrant.create({
    data: {
      userId: user.id,
      roleId,
      siteId,
      // `user_role_grant_revocation_order`: revoked after it was granted.
      grantedAt: new Date(Date.now() - 60_000),
      revokedAt: state.revoked ? new Date() : null,
    },
  });
  return user;
}

const told = {
  outcome: 'NOTIFIED' as const,
  readBack: true,
  recipientKind: 'ORDERING_PRACTITIONER' as const,
  recipientName: 'Ana Villacís',
  channel: 'PHONE' as const,
};

describe('ORD-175, quien hizo la llamada', () => {
  it('ORD-175 la cuenta elegida de la sede queda en la constancia con su nombre', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const role = await aStaffRole(prisma);
    const lucia = await anAccount(prisma, role.id, { firstName: 'Lucía', lastName: 'Toapanta' }, ctx.scene.site.id); // prettier-ignore

    const notice = await ctx.reports.notify(
      { resultId: ctx.result.id, ...told, callerUserId: lucia.id },
      ctx.asNurse,
      new Date(),
    );

    expect(notice).toMatchObject({ callerId: lucia.id, callerName: 'Lucía Toapanta', selfNotice: false }); // prettier-ignore
    const row = await prisma.criticalResultNotice.findUniqueOrThrow({ where: { id: notice.id } }); // prettier-ignore
    expect(row).toMatchObject({ callerId: lucia.id, callerName: 'Lucía Toapanta' }); // prettier-ignore
  });

  it('ORD-175 rechaza la cuenta que no es de la sede, la inactiva y la revocada; admite la de todas las sedes', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const elsewhere = await createSite(prisma, 'Sede Sur');
    const role = await aStaffRole(prisma);
    const foreign = await anAccount(prisma, role.id, { firstName: 'Pedro', lastName: 'Quishpe' }, elsewhere.id); // prettier-ignore
    const inactive = await anAccount(prisma, role.id, { firstName: 'Rosa', lastName: 'Andrade' }, ctx.scene.site.id, { active: false }); // prettier-ignore
    const revoked = await anAccount(prisma, role.id, { firstName: 'José', lastName: 'Pilco' }, ctx.scene.site.id, { revoked: true }); // prettier-ignore
    const everywhere = await anAccount(prisma, role.id, { firstName: 'Marta', lastName: 'Cevallos' }, null); // prettier-ignore

    for (const caller of [foreign, inactive, revoked]) {
      await expect(
        ctx.reports.notify({ resultId: ctx.result.id, ...told, callerUserId: caller.id }, ctx.asNurse, new Date()), // prettier-ignore
      ).rejects.toMatchObject({ code: 'CRITICAL_NOTICE_CALLER_NOT_FOUND' });
    }
    expect(await prisma.criticalResultNotice.count()).toBe(0);
    // Control positivo: con rol en todas las sedes, sí es de esta.
    await expect(
      ctx.reports.notify({ resultId: ctx.result.id, ...told, callerUserId: everywhere.id }, ctx.asNurse, new Date()), // prettier-ignore
    ).resolves.toMatchObject({ callerId: everywhere.id });

    const listed = await ctx.reports.noticeCallers(ctx.result.id, ctx.asNurse);
    const ids = listed.map((account) => account.id);
    expect(ids).toContain(everywhere.id);
    expect(ids).not.toContain(foreign.id);
    expect(ids).not.toContain(inactive.id);
    expect(ids).not.toContain(revoked.id);
    expect(listed.find((a) => a.id === everywhere.id)?.name).toBe('Marta Cevallos'); // prettier-ignore
  });

  it('ORD-175 escrito, quien llamó necesita dos palabras sin el tratamiento', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);

    for (const callerName of ['lab', 'Dr. Pérez', 'Lcda.']) {
      await expect(
        ctx.reports.notify({ resultId: ctx.result.id, ...told, callerName }, ctx.asNurse, new Date()), // prettier-ignore
      ).rejects.toMatchObject({ code: 'CRITICAL_NOTICE_CALLER_INCOMPLETE' });
    }
    // Control positivo: dos palabras entran, sin cuenta.
    await expect(
      ctx.reports.notify({ resultId: ctx.result.id, ...told, callerName: 'Dr. Luis Pérez' }, ctx.asNurse, new Date()), // prettier-ignore
    ).resolves.toMatchObject({ callerId: null, callerName: 'Dr. Luis Pérez' });
  });

  it('ORD-175 la base no guarda una cuenta de quien llamó sin su nombre', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const notice = await ctx.reports.notify({ resultId: ctx.result.id, ...told }, ctx.asNurse, new Date()); // prettier-ignore

    await expect(
      prisma.$executeRaw`
        UPDATE "critical_result_notice"
           SET "caller_id" = ${ctx.asNurse.userId}::uuid,
               "edited_by_id" = ${ctx.asNurse.userId}::uuid, "edited_at" = clock_timestamp()
         WHERE "id" = ${notice.id}::uuid`,
    ).rejects.toThrow(/critical_result_notice_caller_account_named/);
    // Control positivo: con el nombre, entra.
    await expect(
      prisma.$executeRaw`
        UPDATE "critical_result_notice"
           SET "caller_id" = ${ctx.asNurse.userId}::uuid, "caller_name" = 'Carmen Salazar',
               "edited_by_id" = ${ctx.asNurse.userId}::uuid, "edited_at" = clock_timestamp()
         WHERE "id" = ${notice.id}::uuid`,
    ).resolves.toBe(1);
  });
});
