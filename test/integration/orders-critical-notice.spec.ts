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
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';

import { createScheduleRule, createSite, createUser } from './setup/fixtures';

/**
 * The notice of a critical value against a real PostgreSQL (ORD-062 to
 * ORD-068, A.M. 00002393 art. 39, D-111).
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

/**
 * NOON IN ECUADOR, YESTERDAY — derived from the clock, never written by hand. The
 * hour every in-hours rule below covers, whatever time the suite runs.
 */
function clinicNoon(): { now: Date; isoWeekday: number; day: string } {
  // YESTERDAY: a report issued «an hour before noon» is then in the past
  // whatever time the suite runs — today's noon is in the future before 11:00.
  const day = clinicalDateOf(new Date(Date.now() - 86_400_000));
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return {
    now: new Date(`${day}T12:00:00-05:00`),
    isoWeekday: weekday === 0 ? 7 : weekday,
    day,
  };
}

/** The site works at noon today: one of its practitioners has a rule then. */
async function siteInHours(
  prisma: PrismaClient,
  scene: { site: { id: string }; practitioner: { id: string } },
  isoWeekday: number,
) {
  await createScheduleRule(
    prisma,
    { practitionerId: scene.practitioner.id, siteId: scene.site.id },
    { weekday: isoWeekday, startTime: '08:00', endTime: '17:00' },
  );
}

/** Whether some backend of this database is waiting on a row lock. */
async function someoneWaitsOnALock(prisma: PrismaClient): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ waiting: bigint }[]>`
    SELECT count(*) AS waiting FROM pg_stat_activity
     WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return Number(rows[0]?.waiting ?? 0) > 0;
}

/**
 * Resolves as soon as either condition holds — a CONDITION, polled, never a
 * fixed sleep —, and fails after ten seconds so a broken test cannot hang.
 */
async function untilEither(
  done: () => boolean,
  probe: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (done() || (await probe())) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Ni el aviso terminó ni llegó a esperar el bloqueo');
}

/** A notice that was actually given, with the read-back D-111 §4 requires. */
const given = {
  outcome: 'NOTIFIED' as const,
  readBack: true,
  recipientKind: 'PATIENT' as const,
  recipientName: 'La paciente, al teléfono de su ficha',
  channel: 'PHONE' as const,
};

describe('la constancia del aviso de un valor crítico contra PostgreSQL', () => {
  it('ORD-064 no deja reescribir, borrar ni vaciar la constancia, ni por SQL directo', async () => {
    const prisma = db();
    const { now } = clinicNoon();
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
        outcome: 'NOTIFIED',
        readBackConfirmed: true,
        afterHours: false,
        selfNotice: false,
      },
    });
    expect(await prisma.criticalResultNotice.count()).toBe(1);

    await expect(
      prisma.$executeRaw`
        UPDATE "critical_result_notice" SET "recipient_name" = 'Otra persona'
        WHERE "id" = ${notice.id}::uuid`,
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRaw`
        DELETE FROM "critical_result_notice" WHERE "id" = ${notice.id}::uuid`,
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE "critical_result_notice"'),
    ).rejects.toThrow(/append-only/);

    const stored = await prisma.criticalResultNotice.findUniqueOrThrow({
      where: { id: notice.id },
    });
    expect(stored.recipientName).toBe('La paciente');
  });

  it('ORD-062 y ORD-066 la base no admite una constancia sin nombre, ni un aviso hecho sin read-back', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const base = {
      observationResultId: BigInt(scene.result.id),
      recipientKind: 'PATIENT' as const,
      recipientName: 'La paciente',
      channel: 'PHONE' as const,
      notifiedById: nurse.id,
      notifiedAt: now,
      afterHours: false,
      selfNotice: false,
    };

    await expect(
      prisma.criticalResultNotice.create({
        data: { ...base, recipientName: '   ', outcome: 'NOTIFIED', readBackConfirmed: true }, // prettier-ignore
      }),
    ).rejects.toThrow();
    await expect(
      prisma.criticalResultNotice.create({
        data: { ...base, outcome: 'NOTIFIED', readBackConfirmed: null },
      }),
    ).rejects.toThrow(/critical_result_notice_read_back/);
    await expect(
      prisma.criticalResultNotice.create({
        data: { ...base, outcome: 'NO_ANSWER', readBackConfirmed: true },
      }),
    ).rejects.toThrow(/critical_result_notice_read_back/);
    expect(await prisma.criticalResultNotice.count()).toBe(0);

    // Control positivo: un aviso con read-back y un intento sin él, entran.
    await prisma.criticalResultNotice.create({
      data: { ...base, outcome: 'NOTIFIED', readBackConfirmed: true },
    });
    await prisma.criticalResultNotice.create({
      data: { ...base, outcome: 'NO_ANSWER', readBackConfirmed: null },
    });
    expect(await prisma.criticalResultNotice.count()).toBe(2);
  });

  it('ORD-063 y ORD-046 una sede nace con 60 minutos de aviso y 24 horas para los sin orden, y la base acota los dos', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const where = { siteId: scene.site.id };

    // D-111 §1 y D-050 §4.
    const fresh = await prisma.siteParameter.findUniqueOrThrow({ where });
    expect(fresh.criticalNoticeWithinMinutes).toBe(60);
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
    // D-111 §1: cambiable, no eliminable. La base no admite quitarlo.
    await expect(
      prisma.$executeRaw`UPDATE "site_parameter" SET "critical_notice_within_minutes" = NULL WHERE "site_id" = ${scene.site.id}::uuid`, // prettier-ignore
    ).rejects.toThrow();
    await expect(
      prisma.siteParameter.update({ where, data: { unmatchedResultDeadlineHours: 0 } }), // prettier-ignore
    ).rejects.toThrow();
    await expect(
      prisma.siteParameter.update({ where, data: { unmatchedResultDeadlineHours: 169 } }), // prettier-ignore
    ).rejects.toThrow();
  });

  it('ORD-062 guarda a quién, quién, cuándo y por qué medio, deja su fila en la bitácora y saca el valor de la cola', async () => {
    const prisma = db();
    const { now, isoWeekday } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    await siteInHours(prisma, scene, isoWeekday);
    const nurse = await createUser(prisma);
    const { reports, store } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };

    // Control positivo: antes del aviso, el valor está en la cola.
    expect(await store.critical({ sites: 'all' })).toHaveLength(1);

    const calledAt = new Date(now.getTime() - 10 * 60_000);
    const notice = await reports.notify(
      { resultId: scene.result.id, ...given, notifiedAt: calledAt },
      requester,
      now,
    );

    expect(notice).toMatchObject({
      resultId: scene.result.id,
      recipientKind: 'PATIENT',
      channel: 'PHONE',
      notifiedAt: calledAt,
      outcome: 'NOTIFIED',
      readBackConfirmed: true,
      afterHours: false,
      notifiedBy: { id: nurse.id, name: 'Carmen Salazar' },
    });
    expect(await store.critical({ sites: 'all' })).toEqual([]);

    const report = await store.byId({
      reportId: scene.report.id,
      sites: 'all',
    });
    expect(report?.results[0]?.notices).toEqual([notice]);

    // La fila de la bitácora está EN LA BASE, escrita con el aviso.
    const trail = await prisma.accessAudit.findMany({
      where: { resourceType: 'critical_result_notice', resourceId: notice.id },
    });
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ userId: nurse.id, action: 'CREATE' });
  });

  it('ORD-066 un aviso hecho sin read-back se rechaza y no deja nada', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const { reports } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };

    await expect(
      reports.notify({ resultId: scene.result.id, ...given, readBack: false }, requester, now), // prettier-ignore
    ).rejects.toMatchObject({ code: 'CRITICAL_READ_BACK_REQUIRED' });
    await expect(
      reports.notify({ resultId: scene.result.id, ...given, readBack: undefined }, requester, now), // prettier-ignore
    ).rejects.toMatchObject({ code: 'CRITICAL_READ_BACK_REQUIRED' });
    expect(await prisma.criticalResultNotice.count()).toBe(0);
    expect(await prisma.accessAudit.count({ where: { resourceType: 'critical_result_notice' } })).toBe(0); // prettier-ignore

    // Control positivo: con read-back, entra.
    await reports.notify(
      { resultId: scene.result.id, ...given },
      requester,
      now,
    );
    expect(await prisma.criticalResultNotice.count()).toBe(1);
  });

  it('ORD-067 una llamada sin respuesta se registra, el valor sigue en la cola y la cola cuenta los intentos', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const { reports } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };
    const attempt = {
      resultId: scene.result.id,
      outcome: 'NO_ANSWER' as const,
      recipientKind: 'PATIENT' as const,
      recipientName: 'La paciente, al teléfono de su ficha',
      channel: 'PHONE' as const,
    };

    const first = await reports.notify(attempt, requester, now);
    expect(first).toMatchObject({ outcome: 'NO_ANSWER', readBackConfirmed: null }); // prettier-ignore
    await reports.notify(attempt, requester, now);

    const [waiting] = await reports.critical(requester, now);
    expect(waiting?.resultId).toBe(scene.result.id);
    expect(waiting?.noAnswerAttempts).toBe(2);

    // Control positivo: el aviso hecho sí lo saca.
    await reports.notify({ resultId: scene.result.id, ...given }, requester, now); // prettier-ignore
    expect(await reports.critical(requester, now)).toEqual([]);
  });

  it('ORD-062 rechaza el aviso de un valor que no es crítico', async () => {
    const prisma = db();
    const { now } = clinicNoon();
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
      reports.notify({ resultId: report.results[0]!.id, ...given }, requester, now), // prettier-ignore
    ).rejects.toMatchObject({ code: 'RESULT_NOT_CRITICAL' });
    expect(await prisma.criticalResultNotice.count()).toBe(0);
  });

  it('ORD-062 no deja avisar de un valor que el laboratorio ya corrigió', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const { reports } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };

    await reports.correct(
      {
        reportId: scene.report.id,
        performedById: null,
        issuedAt: new Date(now.getTime() - 30 * 60_000),
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 30 }],
      },
      requester,
    );

    // Una llamada de AHORA, después de la corrección, es sobre un valor retirado.
    const afterCorrection = new Date(Date.now() + 1000);
    await expect(
      reports.notify({ resultId: scene.result.id, ...given }, requester, afterCorrection), // prettier-ignore
    ).rejects.toMatchObject({ code: 'RESULT_SUPERSEDED' });

    // Control positivo: el valor que lo sustituye, crítico también, sí.
    const [standing] = await reports.critical(requester, now);
    expect(standing?.resultId).not.toBe(scene.result.id);
    await reports.notify({ resultId: standing!.resultId, ...given }, requester, afterCorrection); // prettier-ignore
    expect(await prisma.criticalResultNotice.count()).toBe(1);
  });

  it('ORD-062 rechaza una hora de aviso futura o anterior al resultado', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const { reports } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };
    const at = (notifiedAt: Date) =>
      reports.notify({ resultId: scene.result.id, ...given, notifiedAt }, requester, now); // prettier-ignore

    await expect(at(new Date(now.getTime() + 60_000))).rejects.toMatchObject({
      code: 'CRITICAL_NOTICE_TIME_INVALID',
    });
    // El resultado se emitió hace una hora: dos horas antes no pudo avisarse.
    await expect(at(new Date(now.getTime() - 2 * 3_600_000))).rejects.toMatchObject({ code: 'CRITICAL_NOTICE_TIME_INVALID' }); // prettier-ignore
    expect(await prisma.criticalResultNotice.count()).toBe(0);

    // Control positivo: sin hora declarada, la del reloj.
    const notice = await reports.notify({ resultId: scene.result.id, ...given }, requester, now); // prettier-ignore
    expect(notice.notifiedAt).toEqual(now);
  });

  it('ORD-062 responde RESULT_NOT_FOUND por un resultado de una sede fuera del alcance', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const otherSite = await createSite(prisma, 'Sede Norte');
    const { reports } = serviceOf(prisma);
    const request = { resultId: scene.result.id, ...given };

    await expect(
      reports.notify(request, { userId: nurse.id, sites: [otherSite.id] }, now),
    ).rejects.toMatchObject({ code: 'RESULT_NOT_FOUND' });
    await expect(
      reports.notify({ ...request, resultId: 'abc' }, { userId: nurse.id, sites: 'all' }, now), // prettier-ignore
    ).rejects.toMatchObject({ code: 'RESULT_NOT_FOUND' });

    // Control positivo: desde su sede, entra.
    await reports.notify(request, { userId: nurse.id, sites: [scene.site.id] }, now); // prettier-ignore
    expect(await prisma.criticalResultNotice.count()).toBe(1);
  });

  it('ORD-065 en horario, dice si venció y a quién toca: quien pidió, la guardia, o que no hay guardia y no escala sola', async () => {
    const prisma = db();
    const { now, isoWeekday } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    await siteInHours(prisma, scene, isoWeekday);
    const { reports } = serviceOf(prisma);
    const requester: Requester = { userId: 'user-1', sites: 'all' };

    // 60 min de fábrica y el resultado tiene 60: aún dentro, a quien pidió.
    const [onTime] = await reports.critical(requester, now);
    expect(onTime).toMatchObject({
      waitingMinutes: 60,
      overdue: false,
      afterHours: false,
      noticeTarget: 'ORDERING_PRACTITIONER',
      escalationMissing: false,
    });

    // Vencido y sin rol de guardia: lo dice, y sigue tocando a quien pidió.
    await prisma.siteParameter.update({
      where: { siteId: scene.site.id },
      data: { criticalNoticeWithinMinutes: 30 },
    });
    const [lateNoRole] = await reports.critical(requester, now);
    expect(lateNoRole).toMatchObject({
      overdue: true,
      noticeTarget: 'ORDERING_PRACTITIONER',
      escalationMissing: true,
      escalateTo: null,
    });
    expect(lateNoRole?.noticeDueAt).toEqual(new Date(now.getTime() - 30 * 60_000)); // prettier-ignore

    // Con rol de guardia, vencido, le toca a la guardia.
    const role = await prisma.role.create({
      data: { code: 'GUARDIA_CLINICA', name: 'Responsable clínico de guardia' },
    });
    await prisma.siteParameter.update({
      where: { siteId: scene.site.id },
      data: { criticalEscalationRoleId: role.id },
    });
    const [late] = await reports.critical(requester, now);
    expect(late).toMatchObject({
      noticeTarget: 'ON_CALL_ROLE',
      escalationMissing: false,
      escalateTo: { roleId: role.id, name: 'Responsable clínico de guardia' },
    });
  });

  it('ORD-068 fuera de horario toca a la guardia o, sin ella, al paciente, y la constancia lo dice', async () => {
    const prisma = db();
    const { now, isoWeekday, day } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const { reports } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };

    // Ninguna regla de horario cubre el mediodía: fuera de horario, sin guardia.
    const [closed] = await reports.critical(requester, now);
    expect(closed).toMatchObject({ afterHours: true, noticeTarget: 'PATIENT' });

    // Con guardia, a la guardia aunque no haya vencido.
    const role = await prisma.role.create({
      data: { code: 'GUARDIA_CLINICA', name: 'Responsable clínico de guardia' },
    });
    await prisma.siteParameter.update({
      where: { siteId: scene.site.id },
      data: { criticalEscalationRoleId: role.id },
    });
    const [onCall] = await reports.critical(requester, now);
    expect(onCall).toMatchObject({ afterHours: true, overdue: false, noticeTarget: 'ON_CALL_ROLE' }); // prettier-ignore

    // Control positivo del horario: con una regla que cubre el mediodía, en horario…
    await siteInHours(prisma, scene, isoWeekday);
    expect((await reports.critical(requester, now))[0]?.afterHours).toBe(false); // prettier-ignore

    // …salvo que hoy sea feriado para la sede.
    await prisma.holiday.create({
      data: { date: new Date(`${day}T00:00:00Z`), name: 'Feriado de prueba', siteId: scene.site.id }, // prettier-ignore
    });
    expect((await reports.critical(requester, now))[0]?.afterHours).toBe(true); // prettier-ignore

    // Y la constancia guarda que fue fuera de horario.
    const notice = await reports.notify({ resultId: scene.result.id, ...given }, requester, now); // prettier-ignore
    expect(notice.afterHours).toBe(true);
  });

  it('ORD-046 da a cada resultado sin orden su responsable y su plazo, de fábrica quien pidió con 24 h', async () => {
    const prisma = db();
    const { now } = clinicNoon();
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

  it('ORD-041 y ORD-043 un valor sin orden de un informe ya corregido sale de la cola y no se empareja', async () => {
    const prisma = db();
    const { now } = clinicNoon();
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
    const first = await reports.register(
      {
        orderId: order.id,
        performedById: null,
        issuedAt: new Date(now.getTime() - 3 * 3_600_000),
        results: [
          { analyteDefinitionId: scene.glu.id, valueNumeric: 92 },
          { analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 },
        ],
      },
      requester,
    );
    const retired = first.results.find((r) => r.analyteDisplay === 'Hemoglobina')!; // prettier-ignore
    await reports.correct(
      {
        reportId: first.id,
        performedById: null,
        issuedAt: new Date(now.getTime() - 3_600_000),
        results: [
          { analyteDefinitionId: scene.glu.id, valueNumeric: 92 },
          { analyteDefinitionId: scene.hb.id, valueNumeric: 9 },
        ],
      },
      requester,
    );

    // Sólo queda en la cola la hemoglobina vigente, la de 9.
    const queue = await reports.unmatched(requester, 50, now);
    expect(queue.map((entry) => entry.valueNumeric)).toEqual([9]);

    await expect(
      reports.match({ resultId: retired.id, orderItemId: order.items[0]!.id }, requester), // prettier-ignore
    ).rejects.toMatchObject({ code: 'RESULT_SUPERSEDED' });

    // Control positivo: la vigente sí se empareja.
    await reports.match({ resultId: queue[0]!.resultId, orderItemId: order.items[0]!.id }, requester); // prettier-ignore
    expect(await reports.unmatched(requester, 50, now)).toEqual([]);
  });

  it('ORD-060 la cola de críticos pone primero el que más lleva esperando', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const older = await aCriticalGlucose(prisma, new Date(now.getTime() - 3_600_000)); // prettier-ignore
    const { reports, orders } = serviceOf(prisma);
    const requester: Requester = { userId: 'user-1', sites: 'all' };
    const order = await orders.place({
      encounterId: older.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: older.glucose.id }],
      sites: 'all',
    });
    const newer = await reports.register(
      {
        orderId: order.id,
        performedById: null,
        issuedAt: new Date(now.getTime() - 10 * 60_000),
        results: [{ analyteDefinitionId: older.glu.id, valueNumeric: 20 }],
      },
      requester,
    );

    const queue = await reports.critical(requester, now);
    expect(queue.map((entry) => entry.resultId)).toEqual([
      older.result.id,
      newer.results[0]!.id,
    ]);
  });

  it('ORD-062 el médico que pidió el examen que se «avisa a sí mismo» deja constancia pero no saca el valor de la cola', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const { reports } = serviceOf(prisma);
    // Quien registra es la cuenta del médico que pidió la orden.
    const orderer: Requester = {
      userId: scene.practitioner.userId,
      sites: 'all',
    };

    const own = await reports.notify(
      { resultId: scene.result.id, ...given, recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'Yo mismo' }, // prettier-ignore
      orderer,
      now,
    );
    expect(own.selfNotice).toBe(true);
    // D-113 b: el paciente en casa no sabe nada; el valor sigue esperando.
    expect((await reports.critical(orderer, now)).map((e) => e.resultId)).toEqual([scene.result.id]); // prettier-ignore

    // Control positivo: el mismo médico avisa a la paciente, y entonces sale.
    await reports.notify({ resultId: scene.result.id, ...given }, orderer, now);
    expect(await reports.critical(orderer, now)).toEqual([]);

    // Y otra persona que avisa al médico que pidió sí cierra la cola.
    const { orders } = serviceOf(prisma);
    const order = await orders.place({
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.glucose.id }],
      sites: 'all',
    });
    const secondReport = await reports.register(
      {
        orderId: order.id,
        performedById: null,
        issuedAt: new Date(now.getTime() - 3_600_000),
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 20 }],
      },
      orderer,
    );
    const nurse = await createUser(prisma);
    const told = await reports.notify(
      { resultId: secondReport.results[0]!.id, ...given, recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'La médica' }, // prettier-ignore
      { userId: nurse.id, sites: 'all' },
      now,
    );
    expect(told.selfNotice).toBe(false);
    expect(await reports.critical(orderer, now)).toEqual([]);
  });

  it('ORD-062 la llamada hecha antes de que el laboratorio corrigiera se registra; la de después, no', async () => {
    const prisma = db();
    const realNow = new Date();
    const scene = await aCriticalGlucose(prisma, realNow);
    const nurse = await createUser(prisma);
    const { reports } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };
    // La llamada fue hace media hora; el laboratorio corrige ahora.
    const calledAt = new Date(realNow.getTime() - 30 * 60_000);
    await reports.correct(
      {
        reportId: scene.report.id,
        performedById: null,
        issuedAt: new Date(realNow.getTime() - 10 * 60_000),
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 95 }],
      },
      requester,
    );

    const notice = await reports.notify(
      { resultId: scene.result.id, ...given, notifiedAt: calledAt },
      requester,
      new Date(),
    );
    expect(notice.notifiedAt).toEqual(calledAt);

    // Una llamada fechada DESPUÉS de la corrección es sobre un valor retirado.
    await expect(
      reports.notify({ resultId: scene.result.id, ...given }, requester, new Date(Date.now() + 1000)), // prettier-ignore
    ).rejects.toMatchObject({ code: 'RESULT_SUPERSEDED' });
  });

  it('ORD-065 y ORD-067 una corrección que sigue siendo crítica no reinicia el plazo ni los intentos', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    // El primer informe se emitió hace una hora (aCriticalGlucose).
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const { reports } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };

    await reports.notify(
      { resultId: scene.result.id, outcome: 'NO_ANSWER', recipientKind: 'PATIENT', recipientName: 'La paciente', channel: 'PHONE' }, // prettier-ignore
      requester,
      now,
    );
    // El laboratorio corrige a 22 hace un minuto: sigue siendo crítico.
    await reports.correct(
      {
        reportId: scene.report.id,
        performedById: null,
        issuedAt: new Date(now.getTime() - 60_000),
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 22 }],
      },
      requester,
    );

    const [standing] = await reports.critical(requester, now);
    expect(standing?.resultId).not.toBe(scene.result.id);
    expect(standing).toMatchObject({ waitingMinutes: 60, noAnswerAttempts: 1 });
    expect(standing?.firstObservedAt).toEqual(new Date(now.getTime() - 3_600_000)); // prettier-ignore
  });

  it('ORD-065 una llamada sin respuesta al médico que pidió pasa el aviso a la guardia sin esperar a que venza', async () => {
    const prisma = db();
    const { now, isoWeekday } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    await siteInHours(prisma, scene, isoWeekday);
    const nurse = await createUser(prisma);
    const { reports } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };
    const role = await prisma.role.create({
      data: { code: 'GUARDIA_CLINICA', name: 'Responsable clínico de guardia' },
    });
    await prisma.siteParameter.update({
      where: { siteId: scene.site.id },
      data: { criticalNoticeWithinMinutes: 120, criticalEscalationRoleId: role.id }, // prettier-ignore
    });

    // Control positivo: en plazo y sin llamadas, toca a quien pidió.
    expect((await reports.critical(requester, now))[0]?.noticeTarget).toBe('ORDERING_PRACTITIONER'); // prettier-ignore

    await reports.notify(
      { resultId: scene.result.id, outcome: 'NO_ANSWER', recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'La médica', channel: 'PHONE' }, // prettier-ignore
      requester,
      now,
    );
    const [after] = await reports.critical(requester, now);
    expect(after).toMatchObject({
      overdue: false,
      noticeTarget: 'ON_CALL_ROLE',
    });
  });

  it('ORD-068 el horario de la sede: feriado nacional, feriado que la sede trabaja, regla inactiva o fuera de vigencia, el borde de la franja y una hora que cruza el día UTC', async () => {
    const prisma = db();
    const { now, isoWeekday, day } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const { store } = serviceOf(prisma);
    const site = scene.site.id;
    const inHours = async (at: Date) => (await store.sitesInHours([site], at)).has(site); // prettier-ignore
    const local = (hhmm: string) => new Date(`${day}T${hhmm}:00-05:00`);
    const rule = (
      overrides: Partial<Parameters<typeof createScheduleRule>[2]>,
    ) =>
      createScheduleRule(
        prisma,
        { practitionerId: scene.practitioner.id, siteId: site },
        {
          weekday: isoWeekday,
          startTime: '08:00',
          endTime: '20:00',
          ...overrides,
        },
      );

    // Una regla inactiva y una que ya no rige no abren la sede.
    const inactive = await rule({ active: false });
    expect(await inHours(now)).toBe(false);
    await prisma.practitionerScheduleRule.delete({
      where: { id: inactive.id },
    });
    const dayStart = new Date(`${day}T00:00:00Z`);
    const yesterdayOfDay = new Date(dayStart.getTime() - 86_400_000);
    const expired = await rule({ validTo: yesterdayOfDay });
    expect(await inHours(now)).toBe(false);
    await prisma.practitionerScheduleRule.delete({ where: { id: expired.id } });
    // La que acaba ESE día aún rige: `validity` es [] e incluye el último.
    const lastDay = await rule({ validTo: dayStart });
    expect(await inHours(now)).toBe(true);
    await prisma.practitionerScheduleRule.delete({ where: { id: lastDay.id } });

    // Control positivo: con una regla activa y vigente, en horario…
    await rule({});
    expect(await inHours(now)).toBe(true);
    // …el borde superior es abierto: a las 20:00 ya no…
    expect(await inHours(local('20:00'))).toBe(false);
    expect(await inHours(local('19:59'))).toBe(true);
    // …y las 19:30 de Guayaquil son las 00:30 UTC del día siguiente: cuenta el
    // día y la hora de ECUADOR.
    expect(await inHours(local('19:30'))).toBe(true);

    // Un feriado NACIONAL cierra la sede…
    const national = await prisma.holiday.create({
      data: { date: new Date(`${day}T00:00:00Z`), name: 'Feriado nacional de prueba', siteId: null }, // prettier-ignore
    });
    expect(await inHours(now)).toBe(false);
    // …salvo que la sede lo trabaje.
    await prisma.holidaySiteException.create({ data: { holidayId: national.id, siteId: site } }); // prettier-ignore
    expect(await inHours(now)).toBe(true);
  });

  it('ORD-055 una corrección que omite un analito se rechaza: el crítico sin avisar no desaparece', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aScene(prisma);
    const { reports, orders } = serviceOf(prisma);
    const requester: Requester = { userId: 'user-1', sites: 'all' };
    const order = await orders.place({
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.glucose.id }, { examDefinitionId: scene.bh.id }], // prettier-ignore
      sites: 'all',
    });
    const first = await reports.register(
      {
        orderId: order.id,
        performedById: null,
        issuedAt: new Date(now.getTime() - 3_600_000),
        results: [
          { analyteDefinitionId: scene.glu.id, valueNumeric: 25 },
          { analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 },
        ],
      },
      requester,
    );

    // El laboratorio corrige la hemoglobina; quien transcribe teclea sólo esa.
    await expect(
      reports.correct(
        {
          reportId: first.id,
          performedById: null,
          issuedAt: new Date(now.getTime() - 60_000),
          results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 12.1 }],
        },
        requester,
      ),
    ).rejects.toMatchObject({ code: 'REPORT_CORRECTION_INCOMPLETE' });
    // El 25 sigue en la cola: nadie lo retractó.
    expect(
      (await reports.critical(requester, now)).map((e) => e.resultId),
    ).toContain(
      first.results.find((r) => r.analyteDisplay === 'Glucosa en ayunas')!.id,
    );

    // Control positivo: con la glucosa reescrita igual, la corrección entra.
    await reports.correct(
      {
        reportId: first.id,
        performedById: null,
        issuedAt: new Date(now.getTime() - 60_000),
        results: [
          { analyteDefinitionId: scene.glu.id, valueNumeric: 25 },
          { analyteDefinitionId: scene.hb.id, valueNumeric: 12.1 },
        ],
      },
      requester,
    );
    expect(await prisma.diagnosticReport.count()).toBe(2);
  });

  it('ORD-062 un aviso que coincide con una corrección en curso espera a que termine, y entonces se rechaza', async () => {
    const prisma = db();
    const realNow = new Date();
    const scene = await aCriticalGlucose(prisma, realNow);
    const nurse = await createUser(prisma);
    const { reports } = serviceOf(prisma);

    // Una corrección abierta en otra conexión, con el informe ya bloqueado.
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => (markLocked = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const correction = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT 1 FROM "diagnostic_report" WHERE "id" = ${scene.report.id}::uuid FOR NO KEY UPDATE`; // prettier-ignore
        await tx.diagnosticReport.create({
          data: {
            serviceOrderId: scene.order.id,
            status: 'CORRECTED',
            supersedesId: scene.report.id,
            issuedAt: new Date(realNow.getTime() - 60_000),
          },
        });
        markLocked();
        await gate;
      },
      { timeout: 30_000 },
    );
    await locked;

    // El aviso arranca mientras la corrección sigue sin confirmar…
    let settled = false;
    const notice = reports.notify(
      { resultId: scene.result.id, ...given },
      { userId: nurse.id, sites: 'all' },
      new Date(Date.now() + 1000),
    );
    notice.then(
      () => (settled = true),
      () => (settled = true),
    );
    // …y llega a esperar el bloqueo: lo dice PostgreSQL, no un reloj. Si el
    // aviso terminara antes (sin bloqueo, escribiría sobre el valor que se
    // está retirando), la espera acaba igual y la aserción de abajo falla.
    await untilEither(
      () => settled,
      () => someoneWaitsOnALock(prisma),
    );
    // La corrección confirma; el aviso sigue, la ve y no escribe nada.
    release();
    await correction;
    await expect(notice).rejects.toMatchObject({ code: 'RESULT_SUPERSEDED' });
    expect(await prisma.criticalResultNotice.count()).toBe(0);
  });

  it('ORD-062 la corrección real espera a un aviso en curso: su bloqueo choca con el del aviso', async () => {
    const prisma = db();
    const realNow = new Date();
    const scene = await aCriticalGlucose(prisma, realNow);
    const { reports } = serviceOf(prisma);

    // Un aviso abierto en otra conexión, con el informe tomado como lo toma
    // el aviso (`FOR SHARE`).
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => (markLocked = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const notice = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT 1 FROM "diagnostic_report" WHERE "id" = ${scene.report.id}::uuid FOR SHARE`; // prettier-ignore
        markLocked();
        await gate;
      },
      { timeout: 30_000 },
    );
    await locked;

    // La corrección de PRODUCCIÓN. Sin su `FOR NO KEY UPDATE`, la clave
    // foránea sólo toma `FOR KEY SHARE`, que no choca con `FOR SHARE`: la
    // corrección terminaría sin esperar y la aserción de abajo fallaría.
    let settled = false;
    const correction = reports.correct(
      {
        reportId: scene.report.id,
        performedById: null,
        issuedAt: new Date(realNow.getTime() - 60_000),
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 95 }],
      },
      { userId: 'user-1', sites: 'all' },
    );
    correction.then(
      () => (settled = true),
      () => (settled = true),
    );
    await untilEither(
      () => settled,
      () => someoneWaitsOnALock(prisma),
    );
    expect(settled).toBe(false);

    // Control positivo: al terminar el aviso, la corrección entra.
    release();
    await notice;
    await expect(correction).resolves.toMatchObject({ status: 'CORRECTED' });
  });

  it('ORD-065 el plazo de la cadena corre desde la primera versión crítica, y la cola dice si ya se avisó de una anterior', async () => {
    const prisma = db();
    const { now } = clinicNoon();
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
    const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000); // prettier-ignore

    // 95 (normal) hace 6 h, corregido a 25 (crítico) hace 2 h.
    const normal = await reports.register(
      { orderId: order.id, performedById: null, issuedAt: at(6), results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 95 }] }, // prettier-ignore
      requester,
    );
    const critical = await reports.correct(
      { reportId: normal.id, performedById: null, issuedAt: at(2), results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 25 }] }, // prettier-ignore
      requester,
    );
    const [fromCritical] = await reports.critical(requester, now);
    // Espera desde el 25, no desde el 95.
    expect(fromCritical).toMatchObject({ waitingMinutes: 120, previouslyNotified: false }); // prettier-ignore

    // Se avisa del 25, y el laboratorio lo corrige a 22: sigue crítico.
    await reports.notify({ resultId: critical.results[0]!.id, ...given }, requester, at(1.5)); // prettier-ignore
    await reports.correct(
      { reportId: critical.id, performedById: null, issuedAt: at(1), results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 22 }] }, // prettier-ignore
      requester,
    );
    const [again] = await reports.critical(requester, now);
    expect(again).toMatchObject({
      waitingMinutes: 120,
      previouslyNotified: true,
    });
  });
});
