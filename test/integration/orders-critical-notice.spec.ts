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
import { createSite, createUser } from './setup/fixtures';

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

/** The trail, captured: ORD-062 says the notice leaves a row. */
function capturingAudit() {
  const entries: Parameters<AccessAuditRecorder['record']>[0][] = [];
  const recorder: AccessAuditRecorder = {
    record: (entry) => {
      entries.push(entry);
      return Promise.resolve();
    },
  };
  return { entries, recorder };
}

const noopLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function serviceOf(
  prisma: PrismaClient,
  audit: AccessAuditRecorder = silentAudit,
) {
  const client = prisma as unknown as PrismaService;
  return {
    reports: new DiagnosticReportService(
      new PrismaDiagnosticReportRepository(client),
      new PrismaServiceOrderRepository(client),
      new PrismaExamCatalogueRepository(client),
      audit,
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

  it('ORD-062 guarda a quién, quién, cuándo y por qué medio, y saca el valor de la cola de críticos', async () => {
    const prisma = db();
    const now = new Date();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const { entries, recorder } = capturingAudit();
    const { reports, store } = serviceOf(prisma, recorder);
    const requester: Requester = { userId: nurse.id, sites: 'all' };

    // Control positivo: antes del aviso, el valor está en la cola.
    expect(await store.critical({ sites: 'all', limit: 50 })).toHaveLength(1);

    const calledAt = new Date(now.getTime() - 10 * 60_000);
    const notice = await reports.notify(
      {
        resultId: scene.result.id,
        recipientKind: 'PATIENT',
        recipientName: 'La paciente, al teléfono de su ficha',
        channel: 'PHONE',
        notifiedAt: calledAt,
      },
      requester,
      now,
    );

    expect(notice).toMatchObject({
      resultId: scene.result.id,
      recipientKind: 'PATIENT',
      channel: 'PHONE',
      notifiedAt: calledAt,
      // Quién avisó es la cuenta de la sesión, con su nombre.
      notifiedBy: { id: nurse.id, name: 'Carmen Salazar' },
    });
    expect(await store.critical({ sites: 'all', limit: 50 })).toEqual([]);

    // El informe lo cuenta junto al valor.
    const report = await store.byId({
      reportId: scene.report.id,
      sites: 'all',
    });
    expect(report?.results[0]?.notices).toEqual([notice]);

    // Y deja fila en la bitácora: el aviso es un acto clínico (D-050 §2).
    expect(entries).toContainEqual(
      expect.objectContaining({
        userId: nurse.id,
        resourceType: 'critical_result_notice',
        resourceId: notice.id,
        action: 'CREATE',
      }),
    );
  });

  it('ORD-062 rechaza el aviso de un valor que no es crítico', async () => {
    const prisma = db();
    const now = new Date();
    const scene = await aScene(prisma);
    const nurse = await createUser(prisma);
    const { reports, orders } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };

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
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 95 }],
      },
      requester,
    );

    await expect(
      reports.notify(
        {
          resultId: report.results[0]!.id,
          recipientKind: 'PATIENT',
          recipientName: 'La paciente',
          channel: 'PHONE',
        },
        requester,
        now,
      ),
    ).rejects.toMatchObject({ code: 'RESULT_NOT_CRITICAL' });
    expect(await prisma.criticalResultNotice.count()).toBe(0);
  });

  it('ORD-062 rechaza una hora de aviso futura o anterior al resultado', async () => {
    const prisma = db();
    const now = new Date();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const { reports } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };
    const at = (notifiedAt: Date) =>
      reports.notify(
        {
          resultId: scene.result.id,
          recipientKind: 'ORDERING_PRACTITIONER',
          recipientName: 'La médica que pidió el examen',
          channel: 'PHONE',
          notifiedAt,
        },
        requester,
        now,
      );

    await expect(at(new Date(now.getTime() + 60_000))).rejects.toMatchObject({
      code: 'CRITICAL_NOTICE_TIME_INVALID',
    });
    // El resultado se emitió hace una hora: dos horas antes no pudo avisarse.
    await expect(at(new Date(now.getTime() - 2 * 3_600_000))).rejects.toMatchObject({ code: 'CRITICAL_NOTICE_TIME_INVALID' }); // prettier-ignore
    expect(await prisma.criticalResultNotice.count()).toBe(0);

    // Control positivo: sin hora declarada, la del reloj.
    const notice = await reports.notify(
      {
        resultId: scene.result.id,
        recipientKind: 'ORDERING_PRACTITIONER',
        recipientName: 'La médica que pidió el examen',
        channel: 'IN_PERSON',
      },
      requester,
      now,
    );
    expect(notice.notifiedAt).toEqual(now);
  });

  it('ORD-062 responde RESULT_NOT_FOUND por un resultado de una sede fuera del alcance', async () => {
    const prisma = db();
    const now = new Date();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const otherSite = await createSite(prisma, 'Sede Norte');
    const { reports } = serviceOf(prisma);
    const request = {
      resultId: scene.result.id,
      recipientKind: 'PATIENT' as const,
      recipientName: 'La paciente',
      channel: 'PHONE' as const,
    };

    await expect(
      reports.notify(request, { userId: nurse.id, sites: [otherSite.id] }, now),
    ).rejects.toMatchObject({ code: 'RESULT_NOT_FOUND' });
    // Y uno que no es un número, igual.
    await expect(
      reports.notify({ ...request, resultId: 'abc' }, { userId: nurse.id, sites: 'all' }, now), // prettier-ignore
    ).rejects.toMatchObject({ code: 'RESULT_NOT_FOUND' });

    // Control positivo: desde su sede, entra.
    await reports.notify(request, { userId: nurse.id, sites: [scene.site.id] }, now); // prettier-ignore
    expect(await prisma.criticalResultNotice.count()).toBe(1);
  });

  it('ORD-065 no inventa el plazo de un crítico; con el de la sede dice si venció y a qué rol se escala', async () => {
    const prisma = db();
    const now = new Date();
    const scene = await aCriticalGlucose(prisma, now);
    const { reports } = serviceOf(prisma);
    const requester: Requester = { userId: 'user-1', sites: 'all' };

    // De fábrica: la clínica no ha fijado plazo (D-111) y la cola lo dice.
    const [fresh] = await reports.critical(requester, 50, now);
    expect(fresh).toMatchObject({
      waitingMinutes: 60,
      overdue: null,
      noticeDueAt: null,
      escalateTo: null,
    });

    const role = await prisma.role.create({
      data: { code: 'GUARDIA_CLINICA', name: 'Responsable clínico de guardia' },
    });
    await prisma.siteParameter.update({
      where: { siteId: scene.site.id },
      data: {
        criticalNoticeWithinMinutes: 30,
        criticalEscalationRoleId: role.id,
      },
    });

    const [late] = await reports.critical(requester, 50, now);
    expect(late).toMatchObject({
      waitingMinutes: 60,
      overdue: true,
      escalateTo: { roleId: role.id, name: 'Responsable clínico de guardia' },
    });
    expect(late?.noticeDueAt).toEqual(new Date(now.getTime() - 30 * 60_000));

    // Control: con un plazo que aún no se cumple, no está vencido.
    await prisma.siteParameter.update({
      where: { siteId: scene.site.id },
      data: { criticalNoticeWithinMinutes: 120 },
    });
    expect((await reports.critical(requester, 50, now))[0]?.overdue).toBe(
      false,
    );
  });

  it('ORD-046 da a cada resultado sin orden su responsable y su plazo, de fábrica quien pidió con 24 h', async () => {
    const prisma = db();
    const now = new Date();
    const scene = await aScene(prisma);
    const { reports, orders } = serviceOf(prisma);
    const requester: Requester = { userId: 'user-1', sites: 'all' };
    const observedAt = new Date(now.getTime() - 2 * 3_600_000);

    const order = await orders.place({
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.bh.id }],
      sites: 'all',
    });
    await reports.register(
      {
        orderId: order.id,
        performedById: null,
        issuedAt: observedAt,
        results: [
          { analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 },
          { analyteDefinitionId: scene.glu.id, valueNumeric: 92 },
        ],
      },
      requester,
    );

    const [byDefault] = await reports.unmatched(requester, 50, now);
    expect(byDefault).toMatchObject({
      owner: { kind: 'ORDERING_PRACTITIONER', name: 'Ana Villacís' },
      overdue: false,
    });
    expect(byDefault?.dueAt).toEqual(new Date(observedAt.getTime() + 24 * 3_600_000)); // prettier-ignore

    const role = await prisma.role.create({
      data: { code: 'LAB_RECEPCION', name: 'Recepción de resultados' },
    });
    await prisma.siteParameter.update({
      where: { siteId: scene.site.id },
      data: {
        unmatchedResultOwnerRoleId: role.id,
        unmatchedResultDeadlineHours: 1,
      },
    });

    const [byRole] = await reports.unmatched(requester, 50, now);
    expect(byRole).toMatchObject({
      owner: { kind: 'ROLE', name: 'Recepción de resultados' },
      overdue: true,
    });
  });
});
