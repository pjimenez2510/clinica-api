import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaDiagnosticReportRepository } from '../../src/modules/orders/infrastructure/prisma-diagnostic-report.repository';
import { PrismaExamCatalogueRepository } from '../../src/modules/orders/infrastructure/prisma-exam-catalogue.repository';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import { DiagnosticReportService } from '../../src/modules/orders/application/diagnostic-report.service';
import type { Requester } from '../../src/modules/orders/application/service-order.service';
import type { AccessAuditRecorder } from '../../src/shared/audit/access-audit.port';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { placeIssued, aScene } from './orders-fixtures';
import { useDatabase } from './setup/database';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';

import { createScheduleRule, createSite, createUser } from './setup/fixtures';
import { InProcessLiveEventBus } from '../../src/shared/events/live-event-bus';

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
      new InProcessLiveEventBus(),
    ),
    orders: new PrismaServiceOrderRepository(client),
    store: new PrismaDiagnosticReportRepository(client),
  };
}

/** A glucose of 25 mg/dL — critical low — registered an hour before `now`. */
async function aCriticalGlucose(prisma: PrismaClient, now: Date) {
  const scene = await aScene(prisma);
  return { ...scene, ...(await criticalGlucoseIn(prisma, scene, now)) };
}

/** Another glucose of 25 mg/dL, on a new order of the same attention. */
async function criticalGlucoseIn(
  prisma: PrismaClient,
  scene: Awaited<ReturnType<typeof aScene>>,
  now: Date,
) {
  const { reports, orders } = serviceOf(prisma);
  const requester: Requester = { userId: 'user-1', sites: 'all' };

  const order = await placeIssued(orders, {
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

  return { order, report, result };
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
  it('ORD-064 y ORD-120 no deja reescribir sin sello, borrar ni vaciar la constancia, ni por SQL directo', async () => {
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

    // ORD-120: editar sí, pero nunca sin decir quién y cuándo.
    await expect(
      prisma.$executeRaw`
        UPDATE "critical_result_notice" SET "recipient_name" = 'Otra persona'
        WHERE "id" = ${notice.id}::uuid`,
    ).rejects.toThrow(/record_version_change_is_stamped/);
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

    const order = await placeIssued(orders, {
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

    const order = await placeIssued(orders, {
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

    const order = await placeIssued(orders, {
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
    const order = await placeIssued(orders, {
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
    const order = await placeIssued(orders, {
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
    const order = await placeIssued(orders, {
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
    const order = await placeIssued(orders, {
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
    // ORD-145 (D-116 b): del 25 ya se avisó; el 22 es un aviso nuevo, y
    // espera desde la corrección.
    const [again] = await reports.critical(requester, now);
    expect(again).toMatchObject({
      waitingMinutes: 60,
      previouslyNotified: true,
    });
    expect(again?.firstObservedAt).toEqual(at(1));
  });
});

/**
 * ORD-120 (D-127): el aviso de un crítico se EDITA en el sitio, y la versión
 * anterior la guarda `record_version`. Lo que sólo la base puede demostrar: que
 * la edición sin sello, el cambio de quién avisó o de qué valor, y el borrado
 * se rechazan aunque se salte la aplicación.
 */
describe('editar el aviso de un valor crítico (ORD-120)', () => {
  const versionsOf = (prisma: PrismaClient, noticeId: string) =>
    prisma.recordVersion.findMany({
      where: { resourceType: 'critical_result_notice', resourceId: noticeId },
      orderBy: { version: 'asc' },
    });

  it('ORD-120 la base admite la edición con sello y guarda la anterior; quién avisó, de qué valor y cuándo se anotó no cambian', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const other = await criticalGlucoseIn(prisma, scene, now);
    const nurse = await createUser(prisma);
    const colleague = await createUser(prisma);
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
    const stamp = (minutes: number) => new Date(now.getTime() + minutes * 60_000); // prettier-ignore

    // Quién avisó, de qué valor y cuándo se anotó: ni con sello.
    await expect(
      prisma.$executeRaw`
        UPDATE "critical_result_notice"
           SET "notified_by_id" = ${colleague.id}::uuid,
               "edited_by_id" = ${colleague.id}::uuid, "edited_at" = ${stamp(1)}
         WHERE "id" = ${notice.id}::uuid`,
    ).rejects.toThrow(/cannot be modified/);
    await expect(
      prisma.$executeRaw`
        UPDATE "critical_result_notice"
           SET "observation_result_id" = ${BigInt(other.result.id)},
               "edited_by_id" = ${colleague.id}::uuid, "edited_at" = ${stamp(1)}
         WHERE "id" = ${notice.id}::uuid`,
    ).rejects.toThrow(/cannot be modified/);
    await expect(
      prisma.$executeRaw`
        UPDATE "critical_result_notice"
           SET "created_at" = ${stamp(-5)},
               "edited_by_id" = ${colleague.id}::uuid, "edited_at" = ${stamp(1)}
         WHERE "id" = ${notice.id}::uuid`,
    ).rejects.toThrow(/cannot be modified/);
    // ORD-066: editado o no, un aviso hecho lleva su read-back.
    await expect(
      prisma.$executeRaw`
        UPDATE "critical_result_notice"
           SET "read_back_confirmed" = NULL,
               "edited_by_id" = ${colleague.id}::uuid, "edited_at" = ${stamp(1)}
         WHERE "id" = ${notice.id}::uuid`,
    ).rejects.toThrow(/critical_result_notice_read_back/);
    // Un sello a medias tampoco.
    await expect(
      prisma.$executeRaw`
        UPDATE "critical_result_notice"
           SET "recipient_name" = 'Otra persona', "edited_by_id" = ${colleague.id}::uuid
         WHERE "id" = ${notice.id}::uuid`,
    ).rejects.toThrow(/record_version_change_is_stamped/);
    expect(await versionsOf(prisma, notice.id)).toEqual([]);

    // Control positivo: lo que se dijo, con sello nuevo, entra y archiva lo de antes.
    await prisma.$executeRaw`
      UPDATE "critical_result_notice"
         SET "recipient_name" = 'La hija de la paciente', "channel" = 'IN_PERSON',
             "edited_by_id" = ${colleague.id}::uuid, "edited_at" = ${stamp(1)}
       WHERE "id" = ${notice.id}::uuid`;

    const stored = await prisma.criticalResultNotice.findUniqueOrThrow({
      where: { id: notice.id },
    });
    expect(stored).toMatchObject({
      recipientName: 'La hija de la paciente',
      channel: 'IN_PERSON',
      notifiedById: nurse.id,
      editedById: colleague.id,
      editedAt: stamp(1),
    });
    const versions = await versionsOf(prisma, notice.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, changedById: colleague.id, changedAt: stamp(1) }); // prettier-ignore
    expect(versions[0]?.data).toMatchObject({
      recipient_name: 'La paciente',
      channel: 'PHONE',
      notified_by_id: nurse.id,
      edited_by_id: null,
    });
  });

  it('ORD-120 editar el aviso lo cambia en el sitio con quién y cuándo, la versión anterior se lee igual que la vigente y queda su fila en la bitácora', async () => {
    const prisma = db();
    const { now, isoWeekday } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    await siteInHours(prisma, scene, isoWeekday);
    const nurse = await createUser(prisma);
    const { reports, store } = serviceOf(prisma);
    const calledAt = new Date(now.getTime() - 10 * 60_000);
    const requester: Requester = { userId: nurse.id, sites: 'all' };

    const notice = await reports.notify(
      { resultId: scene.result.id, ...given, notifiedAt: calledAt },
      requester,
      now,
    );
    expect(notice).toMatchObject({ editedBy: null, editedAt: null });

    const later = new Date(now.getTime() + 5 * 60_000);
    const edited = await reports.editNotice(
      {
        resultId: scene.result.id,
        noticeId: notice.id,
        expectedEditedAt: null,
        ...given,
        recipientKind: 'REPRESENTATIVE',
        recipientName: 'La hija de la paciente',
        channel: 'IN_PERSON',
        notifiedAt: calledAt,
        note: 'Se le explicó que acuda hoy',
      },
      requester,
      later,
    );

    expect(edited).toMatchObject({
      id: notice.id,
      resultId: scene.result.id,
      recipientKind: 'REPRESENTATIVE',
      recipientName: 'La hija de la paciente',
      channel: 'IN_PERSON',
      note: 'Se le explicó que acuda hoy',
      notifiedAt: calledAt,
      outcome: 'NOTIFIED',
      readBackConfirmed: true,
      notifiedBy: { id: nurse.id, name: 'Carmen Salazar' },
      editedBy: { id: nurse.id, name: 'Carmen Salazar' },
      editedAt: later,
    });
    const report = await store.byId({ reportId: scene.report.id, sites: 'all' }); // prettier-ignore
    expect(report?.results[0]?.notices).toEqual([edited]);

    // La versión anterior, con el MISMO mapeo que la vigente.
    const versions = await reports.noticeVersions(
      { resultId: scene.result.id, noticeId: notice.id },
      requester,
    );
    expect(versions).toEqual([
      {
        version: 1,
        replacedBy: { id: nurse.id, name: 'Carmen Salazar' },
        replacedAt: later,
        notice,
      },
    ]);

    // La bitácora: el alta y la edición, escritas con la constancia.
    const trail = await prisma.accessAudit.findMany({
      where: { resourceType: 'critical_result_notice', resourceId: notice.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(trail.map((row) => [row.userId, row.action])).toEqual([
      [nurse.id, 'CREATE'],
      [nurse.id, 'UPDATE'],
    ]);
  });

  it('ORD-120 sólo quien dio el aviso lo edita: otra cuenta con result:write recibe CRITICAL_NOTICE_OF_ANOTHER_USER y no cambia nada', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const colleague = await createUser(prisma);
    const { reports } = serviceOf(prisma);
    const attempt = await reports.notify(
      { resultId: scene.result.id, ...given, outcome: 'NO_ANSWER', readBack: undefined }, // prettier-ignore
      { userId: nurse.id, sites: 'all' },
      now,
    );
    const later = new Date(now.getTime() + 60_000);
    const edit = (userId: string) =>
      reports.editNotice(
        {
          resultId: scene.result.id,
          noticeId: attempt.id,
          expectedEditedAt: null,
          ...given,
          outcome: 'NO_ANSWER',
          readBack: undefined,
          recipientName: 'La paciente, al celular de su ficha',
        },
        { userId, sites: 'all' },
        later,
      );

    // Ni siquiera dejando el «no contestó» como estaba.
    await expect(edit(colleague.id)).rejects.toMatchObject({
      code: 'CRITICAL_NOTICE_OF_ANOTHER_USER',
    });
    expect(await versionsOf(prisma, attempt.id)).toEqual([]);

    // Control positivo: la misma edición, por quien llamó, entra.
    const edited = await edit(nurse.id);
    expect(edited).toMatchObject({
      recipientName: 'La paciente, al celular de su ficha',
      editedBy: { id: nurse.id },
    });
    expect(await versionsOf(prisma, attempt.id)).toHaveLength(1);
  });

  it('ORD-120 un «no contestó» no pasa a «avisado» por edición (CRITICAL_NOTICE_NO_ANSWER_STAYS); el resto de sus campos sí se editan', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const { reports, store } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };
    const attempt = await reports.notify(
      { resultId: scene.result.id, ...given, outcome: 'NO_ANSWER', readBack: undefined }, // prettier-ignore
      requester,
      now,
    );
    const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000); // prettier-ignore

    // Con read-back y todo: una llamada que sí contestan es un aviso nuevo.
    await expect(
      reports.editNotice(
        { resultId: scene.result.id, noticeId: attempt.id, expectedEditedAt: null, ...given }, // prettier-ignore
        requester,
        later(1),
      ),
    ).rejects.toMatchObject({ code: 'CRITICAL_NOTICE_NO_ANSWER_STAYS' });
    expect(await versionsOf(prisma, attempt.id)).toEqual([]);
    // El intento sigue contando: el valor sigue en la cola.
    expect(await store.critical({ sites: 'all' })).toHaveLength(1);

    // Control positivo: el mismo intento, sin pasar a aviso, se corrige.
    const edited = await reports.editNotice(
      {
        resultId: scene.result.id,
        noticeId: attempt.id,
        expectedEditedAt: null,
        ...given,
        outcome: 'NO_ANSWER',
        readBack: undefined,
        channel: 'VIDEO_CALL',
        note: 'Dos timbrazos y buzón',
      },
      requester,
      later(1),
    );
    expect(edited).toMatchObject({ outcome: 'NO_ANSWER', channel: 'VIDEO_CALL', note: 'Dos timbrazos y buzón' }); // prettier-ignore
    expect(await store.critical({ sites: 'all' })).toHaveLength(1);

    // Y la salida que da el mensaje: registrar el aviso nuevo, que sí la saca.
    await reports.notify({ resultId: scene.result.id, ...given }, requester, later(2)); // prettier-ignore
    expect(await store.critical({ sites: 'all' })).toEqual([]);
  });

  it('ORD-120 y ORD-066 al editar, el aviso hecho sigue exigiendo el read-back; un aviso que pasa a «no contestó» devuelve el valor a la cola', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const { reports, store } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };
    const notice = await reports.notify({ resultId: scene.result.id, ...given }, requester, now); // prettier-ignore
    const edit = (
      changes: { outcome?: 'NOTIFIED' | 'NO_ANSWER'; readBack?: boolean },
      expectedEditedAt: Date | null,
      at: Date,
    ) =>
      reports.editNotice(
        { resultId: scene.result.id, noticeId: notice.id, expectedEditedAt, ...given, ...changes }, // prettier-ignore
        requester,
        at,
      );
    const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000); // prettier-ignore

    await expect(edit({ readBack: undefined }, null, later(1))).rejects.toMatchObject({ code: 'CRITICAL_READ_BACK_REQUIRED' }); // prettier-ignore
    await expect(edit({ readBack: false }, null, later(1))).rejects.toMatchObject({ code: 'CRITICAL_READ_BACK_REQUIRED' }); // prettier-ignore
    expect(await versionsOf(prisma, notice.id)).toEqual([]);
    expect(await store.critical({ sites: 'all' })).toEqual([]);

    // Control positivo: con read-back, la edición entra y el valor sigue fuera.
    const first = await edit({}, null, later(1));
    expect(await store.critical({ sites: 'all' })).toEqual([]);

    // Y si resulta que nadie contestó, vuelve a ella.
    await edit({ outcome: 'NO_ANSWER', readBack: undefined }, first.editedAt, later(2)); // prettier-ignore
    expect(await store.critical({ sites: 'all' })).toHaveLength(1);
    expect(await versionsOf(prisma, notice.id)).toHaveLength(2);
  });

  it('ORD-120 y ORD-062 el aviso a sí mismo se juzga con quién AVISÓ', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const { reports, store } = serviceOf(prisma);
    const ordering: Requester = { userId: scene.practitioner.userId, sites: 'all' }; // prettier-ignore

    // El médico que pidió el examen anota que avisó al paciente…
    const notice = await reports.notify(
      { resultId: scene.result.id, ...given },
      ordering,
      now,
    );
    expect(notice.selfNotice).toBe(false);
    expect(await store.critical({ sites: 'all' })).toEqual([]);

    // …y corrige: en realidad fue «al médico que pidió», él mismo.
    const edited = await reports.editNotice(
      { resultId: scene.result.id, noticeId: notice.id, expectedEditedAt: null, ...given, recipientKind: 'ORDERING_PRACTITIONER' }, // prettier-ignore
      ordering,
      new Date(now.getTime() + 60_000),
    );
    expect(edited.selfNotice).toBe(true);
    // D-113 b: un aviso a sí mismo no cierra la cola.
    expect(await store.critical({ sites: 'all' })).toHaveLength(1);
  });

  it('ORD-120 la hora editada sigue acotada, y un aviso de otro valor o de una sede fuera del alcance no se encuentra', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const other = await criticalGlucoseIn(prisma, scene, now);
    const nurse = await createUser(prisma);
    const otherSite = await createSite(prisma, 'Sede Norte');
    const { reports } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };
    const notice = await reports.notify({ resultId: scene.result.id, ...given }, requester, now); // prettier-ignore
    const later = new Date(now.getTime() + 60_000);
    const edit = (
      changes: { notifiedAt?: Date; resultId?: string },
      who: Requester = requester,
    ) =>
      reports.editNotice(
        {
          resultId: scene.result.id,
          noticeId: notice.id,
          expectedEditedAt: null,
          ...given,
          ...changes,
        },
        who,
        later,
      );

    await expect(edit({ notifiedAt: new Date(later.getTime() + 60_000) })).rejects.toMatchObject({ code: 'CRITICAL_NOTICE_TIME_INVALID' }); // prettier-ignore
    await expect(edit({ notifiedAt: new Date(now.getTime() - 2 * 3_600_000) })).rejects.toMatchObject({ code: 'CRITICAL_NOTICE_TIME_INVALID' }); // prettier-ignore
    // El aviso es de OTRO valor: no se edita por esta ruta.
    await expect(edit({ resultId: other.result.id })).rejects.toMatchObject({ code: 'CRITICAL_NOTICE_NOT_FOUND' }); // prettier-ignore
    await expect(
      reports.editNotice({ resultId: scene.result.id, noticeId: '01999999-0000-7000-8000-000000000000', expectedEditedAt: null, ...given }, requester, later), // prettier-ignore
    ).rejects.toMatchObject({ code: 'CRITICAL_NOTICE_NOT_FOUND' });
    await expect(edit({}, { userId: nurse.id, sites: [otherSite.id] })).rejects.toMatchObject({ code: 'RESULT_NOT_FOUND' }); // prettier-ignore
    expect(await versionsOf(prisma, notice.id)).toEqual([]);

    // Control positivo: sin hora declarada se queda la que tenía, y entra.
    const edited = await edit({});
    expect(edited.notifiedAt).toEqual(now);
    expect(await versionsOf(prisma, notice.id)).toHaveLength(1);
  });

  it('ORD-120 y ORD-062 la llamada que se mueve después de la corrección del laboratorio se rechaza', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const { reports } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };
    const calledAt = new Date(now.getTime() - 30 * 60_000);
    const notice = await reports.notify({ resultId: scene.result.id, ...given, notifiedAt: calledAt }, requester, now); // prettier-ignore

    await reports.correct(
      {
        reportId: scene.report.id,
        performedById: null,
        issuedAt: new Date(now.getTime() - 20 * 60_000),
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 30 }],
      },
      requester,
    );
    const afterCorrection = new Date(Date.now() + 60_000);

    await expect(
      reports.editNotice({ resultId: scene.result.id, noticeId: notice.id, expectedEditedAt: null, ...given, notifiedAt: new Date(Date.now() + 1000) }, requester, afterCorrection), // prettier-ignore
    ).rejects.toMatchObject({ code: 'RESULT_SUPERSEDED' });

    // Control positivo: la misma llamada, con su hora de antes, se corrige.
    const edited = await reports.editNotice({ resultId: scene.result.id, noticeId: notice.id, expectedEditedAt: null, ...given, recipientName: 'La paciente, en persona' }, requester, afterCorrection); // prettier-ignore
    expect(edited.recipientName).toBe('La paciente, en persona');
  });

  it('ORD-120 la edición sobre una versión que ya no es la vigente se rechaza con CRITICAL_NOTICE_EDITED_CONCURRENTLY; la que trae la vigente entra', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const { reports } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };
    const notice = await reports.notify({ resultId: scene.result.id, ...given }, requester, now); // prettier-ignore
    const edit = (recipientName: string, expectedEditedAt: Date | null, at: Date) =>
      reports.editNotice({ resultId: scene.result.id, noticeId: notice.id, expectedEditedAt, ...given, recipientName }, requester, at); // prettier-ignore
    const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000); // prettier-ignore

    // La otra pestaña: editó primero.
    const first = await edit('Uno', null, later(1));

    // Ésta sigue creyendo que nadie lo editó.
    await expect(edit('Dos', null, later(2))).rejects.toMatchObject({ code: 'CRITICAL_NOTICE_EDITED_CONCURRENTLY' }); // prettier-ignore
    // Y una versión inventada tampoco vale.
    await expect(edit('Dos', later(3), later(2))).rejects.toMatchObject({ code: 'CRITICAL_NOTICE_EDITED_CONCURRENTLY' }); // prettier-ignore
    expect(await versionsOf(prisma, notice.id)).toHaveLength(1);
    const stored = await prisma.criticalResultNotice.findUniqueOrThrow({ where: { id: notice.id } }); // prettier-ignore
    expect(stored.recipientName).toBe('Uno');

    // Control positivo: con la versión vigente, entra.
    const second = await edit('Dos', first.editedAt, later(2));
    expect(second.recipientName).toBe('Dos');
    expect(await versionsOf(prisma, notice.id)).toHaveLength(2);
  });

  it('ORD-120 dos ediciones a la vez sobre la misma versión: gana la que toma la fila primero, la otra recibe CRITICAL_NOTICE_EDITED_CONCURRENTLY', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const { reports } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };
    const notice = await reports.notify({ resultId: scene.result.id, ...given }, requester, now); // prettier-ignore
    const sameInstant = new Date(now.getTime() + 60_000);
    const edit = (recipientName: string) =>
      reports.editNotice({ resultId: scene.result.id, noticeId: notice.id, expectedEditedAt: null, ...given, recipientName }, requester, sameInstant); // prettier-ignore

    const outcomes = await Promise.allSettled([edit('Uno'), edit('Dos')]);

    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter((o) => o.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.reason).toMatchObject({ code: 'CRITICAL_NOTICE_EDITED_CONCURRENTLY' }); // prettier-ignore
    const winner = won[0]!.value;
    // Lo vigente es exactamente lo del ganador, y sólo él archivó una versión.
    const stored = await prisma.criticalResultNotice.findUniqueOrThrow({ where: { id: notice.id } }); // prettier-ignore
    expect(stored.recipientName).toBe(winner.recipientName);
    expect(stored.editedAt).toEqual(winner.editedAt);
    expect(await versionsOf(prisma, notice.id)).toHaveLength(1);
  });

  it('ORD-120 dos ediciones seguidas en el mismo instante no chocan: la segunda lleva su propio sello', async () => {
    const prisma = db();
    const { now } = clinicNoon();
    const scene = await aCriticalGlucose(prisma, now);
    const nurse = await createUser(prisma);
    const { reports } = serviceOf(prisma);
    const requester: Requester = { userId: nurse.id, sites: 'all' };
    const notice = await reports.notify({ resultId: scene.result.id, ...given }, requester, now); // prettier-ignore
    const sameInstant = new Date(now.getTime() + 60_000);
    const edit = (recipientName: string, expectedEditedAt: Date | null) =>
      reports.editNotice({ resultId: scene.result.id, noticeId: notice.id, expectedEditedAt, ...given, recipientName }, requester, sameInstant); // prettier-ignore

    const first = await edit('Uno', null);
    const second = await edit('Dos', first.editedAt);

    expect(second.editedAt!.getTime()).toBeGreaterThan(first.editedAt!.getTime()); // prettier-ignore
    const versions = await versionsOf(prisma, notice.id);
    expect(versions).toHaveLength(2);
    expect(versions[0]?.changedAt).not.toEqual(versions[1]?.changedAt);
  });
});
