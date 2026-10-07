import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { DiagnosticReportService } from '../../src/modules/orders/application/diagnostic-report.service';
import type { Requester } from '../../src/modules/orders/application/service-order.service';
import { PrismaDiagnosticReportRepository } from '../../src/modules/orders/infrastructure/prisma-diagnostic-report.repository';
import { PrismaExamCatalogueRepository } from '../../src/modules/orders/infrastructure/prisma-exam-catalogue.repository';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import type { AccessAuditRecorder } from '../../src/shared/audit/access-audit.port';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { aScene, placeIssued } from './orders-fixtures';
import { useDatabase } from './setup/database';
import { createSite, createUser } from './setup/fixtures';

/**
 * Quien actuó sobre un crítico se entera de su corrección (ORD-143 a ORD-149,
 * D-115, D-116), contra PostgreSQL: la cola, su cierre, el autoaviso y quién
 * hizo la llamada salen de las filas que aterrizan.
 *
 * Every instant derives from the clock: `now` is the real one, so the
 * correction's recording instant (`created_at`, the app's clock) is before it.
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
  };
}

const minutesAgo = (minutes: number, from: Date = new Date()) =>
  new Date(from.getTime() - minutes * 60_000);

const toPatient = {
  outcome: 'NOTIFIED' as const,
  readBack: true,
  recipientKind: 'PATIENT' as const,
  recipientName: 'La paciente, al teléfono de su ficha',
  channel: 'PHONE' as const,
};

/** A glucose of 25 —critical low— issued two hours ago, on a new order. */
async function aCriticalGlucose(
  prisma: PrismaClient,
  existing?: Awaited<ReturnType<typeof aScene>>,
) {
  const scene = existing ?? (await aScene(prisma));
  const { reports, orders } = serviceOf(prisma);
  const nurse = await createUser(prisma);
  const asNurse: Requester = { userId: nurse.id, sites: 'all' };
  const asDoctor: Requester = { userId: scene.practitioner.userId, sites: 'all' }; // prettier-ignore
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
      issuedAt: minutesAgo(120),
      results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 25 }],
    },
    asNurse,
  );
  const result = report.results[0]!;
  expect(result.abnormalFlag).toBe('CRITICAL_LOW');
  return { scene, reports, nurse, asNurse, asDoctor, order, report, result };
}

/** The laboratory corrects the report to `value`, issued `minutes` ago. */
async function correctTo(
  ctx: Awaited<ReturnType<typeof aCriticalGlucose>>,
  reportId: string,
  value: number,
  minutes = 30,
  from: Date = new Date(),
) {
  return ctx.reports.correct(
    {
      reportId,
      performedById: null,
      issuedAt: minutesAgo(minutes, from),
      results: [{ analyteDefinitionId: ctx.scene.glu.id, valueNumeric: value }],
    },
    ctx.asNurse,
  );
}

describe('la corrección de un valor avisado (ORD-143, ORD-144)', () => {
  it('ORD-143 ORD-144 un 25 avisado al paciente y corregido a 95 espera en la cola con lo que se dijo, y sale con el aviso de la corrección', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    // Control positivo: sin corrección, la cola está vacía.
    await ctx.reports.notify({ resultId: ctx.result.id, ...toPatient, notifiedAt: minutesAgo(90) }, ctx.asNurse, new Date()); // prettier-ignore
    expect(await ctx.reports.corrections(ctx.asNurse, new Date())).toEqual([]);

    const corrected = await correctTo(ctx, ctx.report.id, 95);
    const standing = corrected.results[0]!;
    expect(standing.abnormalFlag).toBe('NORMAL');

    const [entry, ...rest] = await ctx.reports.corrections(
      ctx.asNurse,
      new Date(),
    );
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      resultId: standing.id,
      orderId: ctx.order.id,
      patientId: ctx.scene.patient.id,
      valueNumeric: 95,
      told: { valueNumeric: 25, abnormalFlag: 'CRITICAL_LOW' },
      earlierNotices: [{ recipientKind: 'PATIENT', selfNotice: false }],
      orderedBy: { id: ctx.scene.practitioner.id, name: 'Ana Villacís' },
    });
    // La lectura de la orden marca el valor vigente, y sólo ése.
    const read = await ctx.reports.ofOrder(ctx.order.id, ctx.asNurse);
    const current = read.find((r) => r.supersededById === null)!;
    expect(current.results[0]?.correction).toMatchObject({ due: true, told: { valueNumeric: 25 } }); // prettier-ignore
    expect(read.find((r) => r.supersededById !== null)?.results[0]?.correction).toBeNull(); // prettier-ignore

    // ORD-144: el 95 no es crítico y sí admite el aviso de la corrección.
    const notice = await ctx.reports.notify({ resultId: standing.id, ...toPatient }, ctx.asNurse, new Date()); // prettier-ignore
    expect(notice.resultId).toBe(standing.id);
    expect(await ctx.reports.corrections(ctx.asNurse, new Date())).toEqual([]);
    const after = await ctx.reports.ofOrder(ctx.order.id, ctx.asNurse);
    expect(after.find((r) => r.supersededById === null)?.results[0]?.correction?.due).toBe(false); // prettier-ignore
  });

  it('ORD-144 un valor normal que no corrige nada avisado sigue sin admitir aviso', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    // Corregido sin que nadie avisara del 25: no hay nada que comunicar.
    const corrected = await correctTo(ctx, ctx.report.id, 95);
    await expect(
      ctx.reports.notify({ resultId: corrected.results[0]!.id, ...toPatient }, ctx.asNurse, new Date()), // prettier-ignore
    ).rejects.toMatchObject({ code: 'RESULT_NOT_CRITICAL' });
    expect(await ctx.reports.corrections(ctx.asNurse, new Date())).toEqual([]);
    expect(await prisma.criticalResultNotice.count()).toBe(0);
  });

  it('ORD-143 un intento sin respuesta no la cierra, y la cola sólo enseña las sedes del alcance', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    await ctx.reports.notify({ resultId: ctx.result.id, ...toPatient, notifiedAt: minutesAgo(90) }, ctx.asNurse, new Date()); // prettier-ignore
    const corrected = await correctTo(ctx, ctx.report.id, 95);
    await ctx.reports.notify(
      { resultId: corrected.results[0]!.id, outcome: 'NO_ANSWER', recipientKind: 'PATIENT', recipientName: 'La paciente', channel: 'PHONE' }, // prettier-ignore
      ctx.asNurse,
      new Date(),
    );
    expect(await ctx.reports.corrections(ctx.asNurse, new Date())).toHaveLength(
      1,
    );

    const elsewhere = await createSite(prisma);
    expect(await ctx.reports.corrections({ userId: ctx.nurse.id, sites: [elsewhere.id] }, new Date())).toEqual([]); // prettier-ignore
    // Control positivo: con la sede de la orden, sí.
    expect(await ctx.reports.corrections({ userId: ctx.nurse.id, sites: [ctx.scene.site.id] }, new Date())).toHaveLength(1); // prettier-ignore
  });

  it('ORD-143 si sólo el médico se anotó el 25, su propia constancia de la corrección la cierra; si se avisó al paciente, no', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const own = { ...toPatient, recipientKind: 'ORDERING_PRACTITIONER' as const, recipientName: 'Yo' }; // prettier-ignore
    await ctx.reports.notify({ resultId: ctx.result.id, ...own, notifiedAt: minutesAgo(90) }, ctx.asDoctor, new Date()); // prettier-ignore
    const corrected = await correctTo(ctx, ctx.report.id, 95);
    expect(
      await ctx.reports.corrections(ctx.asDoctor, new Date()),
    ).toHaveLength(1);
    await ctx.reports.notify({ resultId: corrected.results[0]!.id, ...own }, ctx.asDoctor, new Date()); // prettier-ignore
    expect(await ctx.reports.corrections(ctx.asDoctor, new Date())).toEqual([]);

    // Con el paciente avisado, el autoaviso de la corrección no basta.
    const other = await aCriticalGlucose(prisma, ctx.scene);
    await other.reports.notify({ resultId: other.result.id, ...toPatient, notifiedAt: minutesAgo(90) }, other.asNurse, new Date()); // prettier-ignore
    const fixed = await correctTo(other, other.report.id, 95);
    await other.reports.notify({ resultId: fixed.results[0]!.id, ...own }, other.asDoctor, new Date()); // prettier-ignore
    expect((await other.reports.corrections(other.asDoctor, new Date())).map((e) => e.resultId)).toEqual([fixed.results[0]!.id]); // prettier-ignore
  });
});

describe('el autoaviso y el destino (ORD-146, ORD-147)', () => {
  it('ORD-146 tras el autoaviso del médico el destino es el paciente, y el aviso de la enfermera al médico —por tipo o por su nombre— no cierra la cola', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const now = new Date();
    // Control positivo: sin autoaviso, toca al médico que pidió.
    expect((await ctx.reports.critical(ctx.asNurse, now))[0]).toMatchObject({ selfNoticed: false }); // prettier-ignore

    const self = await ctx.reports.notify(
      { resultId: ctx.result.id, ...toPatient, recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'Yo' }, // prettier-ignore
      ctx.asDoctor,
      now,
    );
    expect(self.selfNotice).toBe(true);
    expect((await ctx.reports.critical(ctx.asNurse, now))[0]).toMatchObject({ resultId: ctx.result.id, selfNoticed: true, noticeTarget: 'PATIENT' }); // prettier-ignore

    const byKind = await ctx.reports.notify(
      { resultId: ctx.result.id, ...toPatient, recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'La médica' }, // prettier-ignore
      ctx.asNurse,
      now,
    );
    expect(byKind.selfNotice).toBe(false);
    const byName = await ctx.reports.notify(
      { resultId: ctx.result.id, ...toPatient, recipientKind: 'OTHER_PRACTITIONER', recipientName: 'Dra. Ana Villacis' }, // prettier-ignore
      ctx.asNurse,
      now,
    );
    expect(byName.namesOrderingPractitioner).toBe(true);
    expect((await ctx.reports.critical(ctx.asNurse, now)).map((e) => e.resultId)).toEqual([ctx.result.id]); // prettier-ignore

    // Control positivo: el aviso al paciente la cierra.
    await ctx.reports.notify({ resultId: ctx.result.id, ...toPatient }, ctx.asNurse, now); // prettier-ignore
    expect(await ctx.reports.critical(ctx.asNurse, now)).toEqual([]);
  });

  it('ORD-147 el aviso que nombra a quien lo registra es un autoaviso, sea cual sea su tipo, y no saca el valor de la cola', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const now = new Date();
    // La enfermera se llama Carmen Salazar: «Otro médico: Lcda. Carmen Salazar».
    const own = await ctx.reports.notify(
      { resultId: ctx.result.id, ...toPatient, recipientKind: 'OTHER_PRACTITIONER', recipientName: 'Lcda. Carmen  SALAZAR' }, // prettier-ignore
      ctx.asNurse,
      now,
    );
    expect(own.selfNotice).toBe(true);
    expect(await ctx.reports.critical(ctx.asNurse, now)).toHaveLength(1);
    // Control positivo: con el nombre de otra persona, el mismo tipo la cierra.
    const other = await ctx.reports.notify(
      { resultId: ctx.result.id, ...toPatient, recipientKind: 'OTHER_PRACTITIONER', recipientName: 'Dr. Luis Toapanta' }, // prettier-ignore
      ctx.asNurse,
      now,
    );
    expect(other.selfNotice).toBe(false);
    expect(await ctx.reports.critical(ctx.asNurse, now)).toEqual([]);
  });
});

describe('lo que la revisión encontró (ORD-143, ORD-145, ORD-146, ORD-148)', () => {
  it('ORD-143 el autoaviso que no cerró la corrección no la da por avisada cuando el laboratorio reescribe el mismo 95', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    await ctx.reports.notify({ resultId: ctx.result.id, ...toPatient, notifiedAt: minutesAgo(90) }, ctx.asNurse, new Date()); // prettier-ignore
    const corrected = await correctTo(ctx, ctx.report.id, 95);
    const own = { ...toPatient, recipientKind: 'ORDERING_PRACTITIONER' as const, recipientName: 'Yo' }; // prettier-ignore
    await ctx.reports.notify({ resultId: corrected.results[0]!.id, ...own }, ctx.asDoctor, new Date()); // prettier-ignore
    const rewritten = await correctTo(ctx, corrected.id, 95, 10);
    const [entry, ...rest] = await ctx.reports.corrections(
      ctx.asNurse,
      new Date(),
    );
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ resultId: rewritten.results[0]!.id, told: { valueNumeric: 25 } }); // prettier-ignore
  });

  it('ORD-146 el autoaviso por nombre de otra cuenta no manda el aviso al paciente, y el aviso al médico que pidió lo cierra', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const now = new Date();
    const colleague = await ctx.reports.notify(
      { resultId: ctx.result.id, ...toPatient, recipientKind: 'OTHER_PRACTITIONER', recipientName: 'Carmen Salazar' }, // prettier-ignore
      ctx.asNurse,
      now,
    );
    expect(colleague.selfNotice).toBe(true);
    expect((await ctx.reports.critical(ctx.asNurse, now))[0]).toMatchObject({ selfNoticed: false }); // prettier-ignore
    await ctx.reports.notify({ resultId: ctx.result.id, ...toPatient, recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'La médica' }, ctx.asNurse, now); // prettier-ignore
    expect(await ctx.reports.critical(ctx.asNurse, now)).toEqual([]);
  });

  it('ORD-146 el aviso al médico que pidió anterior a su autoaviso sigue cerrando la cola', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const now = new Date();
    await ctx.reports.notify({ resultId: ctx.result.id, ...toPatient, recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'La médica', notifiedAt: minutesAgo(60, now) }, ctx.asNurse, now); // prettier-ignore
    await ctx.reports.notify({ resultId: ctx.result.id, ...toPatient, recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'Yo', notifiedAt: minutesAgo(30, now) }, ctx.asDoctor, now); // prettier-ignore
    expect(await ctx.reports.critical(ctx.asNurse, now)).toEqual([]);
  });

  it('ORD-145 ORD-146 un aviso al médico tras su autoaviso no cuenta como avisado: la corrección aún crítica sigue esperando desde el primer valor', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const now = new Date();
    await ctx.reports.notify({ resultId: ctx.result.id, ...toPatient, recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'Yo', notifiedAt: minutesAgo(100, now) }, ctx.asDoctor, now); // prettier-ignore
    await ctx.reports.notify({ resultId: ctx.result.id, ...toPatient, recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'La médica', notifiedAt: minutesAgo(90, now) }, ctx.asNurse, now); // prettier-ignore
    const still = await correctTo(ctx, ctx.report.id, 30, 20, now);
    expect((await ctx.reports.critical(ctx.asNurse, now))[0]).toMatchObject({ resultId: still.results[0]!.id, previouslyNotified: false, waitingMinutes: 120 }); // prettier-ignore
  });

  it('ORD-148 el aviso cuyo destinatario es quien hizo la llamada es un autoaviso y no cierra la cola', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const now = new Date();
    const odd = await ctx.reports.notify(
      { resultId: ctx.result.id, ...toPatient, recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'Ana Villacís', callerName: 'Dra. Ana Villacís' }, // prettier-ignore
      ctx.asNurse,
      now,
    );
    expect(odd.selfNotice).toBe(true);
    expect(await ctx.reports.critical(ctx.asNurse, now)).toHaveLength(1);
  });
});

describe('el plazo desde la corrección (ORD-145)', () => {
  it('ORD-145 la corrección aún crítica de un valor avisado espera desde la corrección, sin las llamadas del aviso ya hecho', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const now = new Date();
    await ctx.reports.notify(
      { resultId: ctx.result.id, outcome: 'NO_ANSWER', recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'La médica', channel: 'PHONE', notifiedAt: minutesAgo(110) }, // prettier-ignore
      ctx.asNurse,
      now,
    );
    // Control positivo: sin aviso hecho, una corrección crítica es el mismo
    // aviso pendiente, desde el 25, con su intento.
    const still = await correctTo(ctx, ctx.report.id, 30, 60, now);
    expect((await ctx.reports.critical(ctx.asNurse, now))[0]).toMatchObject({ resultId: still.results[0]!.id, waitingMinutes: 120, noAnswerAttempts: 1, previouslyNotified: false }); // prettier-ignore

    // Se avisa del 30, y el laboratorio lo corrige a 22 hace 20 minutos.
    await ctx.reports.notify({ resultId: still.results[0]!.id, ...toPatient, notifiedAt: minutesAgo(40) }, ctx.asNurse, now); // prettier-ignore
    const again = await correctTo(ctx, still.id, 22, 20, now);
    const [entry] = await ctx.reports.critical(ctx.asNurse, now);
    expect(entry).toMatchObject({ resultId: again.results[0]!.id, waitingMinutes: 20, noAnswerAttempts: 0, previouslyNotified: true }); // prettier-ignore
    expect(entry?.firstObservedAt).toEqual(minutesAgo(20, now));
    // Ni entra en la cola de correcciones: espera en la de críticos.
    expect(await ctx.reports.corrections(ctx.asNurse, new Date())).toEqual([]);
  });
});

describe('quién hizo la llamada (ORD-148)', () => {
  it('ORD-148 la base no guarda un nombre vacío de quien llamó; sí uno, y sí ninguno', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const base = {
      observationResultId: BigInt(ctx.result.id),
      recipientKind: 'PATIENT' as const,
      recipientName: 'La paciente',
      channel: 'PHONE' as const,
      notifiedById: ctx.nurse.id,
      notifiedAt: new Date(),
      outcome: 'NOTIFIED' as const,
      readBackConfirmed: true,
      afterHours: false,
      selfNotice: false,
    };
    await expect(
      prisma.criticalResultNotice.create({
        data: { ...base, callerName: '  ' },
      }),
    ).rejects.toThrow(/critical_result_notice_caller_named/);
    await prisma.criticalResultNotice.create({ data: { ...base, callerName: 'Lcda. Rosa Pilco' } }); // prettier-ignore
    await prisma.criticalResultNotice.create({ data: base });
    expect(await prisma.criticalResultNotice.count()).toBe(2);
  });

  it('ORD-148 la constancia guarda quién llamó además de quién registró, y se edita con ella', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const now = new Date();
    const notice = await ctx.reports.notify(
      { resultId: ctx.result.id, ...toPatient, callerName: '  Lcda. Rosa Pilco ' }, // prettier-ignore
      ctx.asNurse,
      now,
    );
    expect(notice).toMatchObject({ callerName: 'Lcda. Rosa Pilco', notifiedBy: { id: ctx.nurse.id } }); // prettier-ignore

    const edited = await ctx.reports.editNotice(
      { resultId: ctx.result.id, noticeId: notice.id, expectedEditedAt: null, ...toPatient, callerName: null }, // prettier-ignore
      ctx.asNurse,
      new Date(),
    );
    expect(edited.callerName).toBeNull();
    const [version] = await ctx.reports.noticeVersions({ resultId: ctx.result.id, noticeId: notice.id }, ctx.asNurse); // prettier-ignore
    expect(version?.notice.callerName).toBe('Lcda. Rosa Pilco');
  });
});

describe('la corrección admite lo retirado (ORD-149)', () => {
  it('ORD-149 una determinación retirada y fuera del examen se ofrece y se admite al corregir, bajo la misma línea', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    // Control positivo: con el catálogo intacto, la ofrece el examen.
    expect((await ctx.reports.correctionAnalytes(ctx.report.id, ctx.asNurse)).map((a) => [a.analyte.name, a.examName])).toEqual([['Glucosa en ayunas', 'Glucosa en ayunas']]); // prettier-ignore

    // El catálogo se republica: la glucosa sale del examen y se retira.
    const replacement = await prisma.analyteDefinition.create({
      data: { code: 'GLU2', name: 'Glucosa basal', unit: 'mg/dL', valueType: 'NUMERIC', decimals: 0 }, // prettier-ignore
    });
    await prisma.examDefinitionAnalyte.deleteMany({ where: { examDefinitionId: ctx.scene.glucose.id } }); // prettier-ignore
    await prisma.examDefinitionAnalyte.create({ data: { examDefinitionId: ctx.scene.glucose.id, analyteDefinitionId: replacement.id, position: 1 } }); // prettier-ignore
    await prisma.analyteDefinition.update({ where: { id: ctx.scene.glu.id }, data: { active: false } }); // prettier-ignore
    await prisma.examDefinition.update({ where: { id: ctx.scene.glucose.id }, data: { active: false } }); // prettier-ignore

    const offered = await ctx.reports.correctionAnalytes(ctx.report.id, ctx.asNurse); // prettier-ignore
    expect(offered.map((a) => [a.analyte.id, a.examName])).toEqual([
      [replacement.id, 'Glucosa en ayunas'],
      [ctx.scene.glu.id, null],
    ]);

    const corrected = await correctTo(ctx, ctx.report.id, 95);
    expect(corrected.results[0]).toMatchObject({ analyteDisplay: 'Glucosa en ayunas', orderItemId: ctx.result.orderItemId }); // prettier-ignore
    expect(ctx.result.orderItemId).not.toBeNull();
  });
});

describe('la corrección que llega a quien debe, a tiempo (ORD-153 a ORD-157, D-156)', () => {
  const onCall = { ...toPatient, recipientKind: 'OTHER_PRACTITIONER' as const, recipientName: 'Dr. Luis Toapanta' }; // prettier-ignore

  it('ORD-153 con el paciente avisado del 25, el aviso de la corrección al médico de guardia no la cierra y al representante sí', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    await ctx.reports.notify({ resultId: ctx.result.id, ...toPatient, notifiedAt: minutesAgo(90) }, ctx.asNurse, new Date()); // prettier-ignore
    const fixed = (await correctTo(ctx, ctx.report.id, 95)).results[0]!;

    const [entry] = await ctx.reports.corrections(ctx.asNurse, new Date());
    expect(entry).toMatchObject({ resultId: fixed.id, patientRequired: true, noticeTarget: 'PATIENT' }); // prettier-ignore
    const read = await ctx.reports.ofOrder(ctx.order.id, ctx.asNurse);
    expect(read.find((r) => r.supersededById === null)?.results[0]?.correction).toMatchObject({ patientRequired: true }); // prettier-ignore

    await ctx.reports.notify({ resultId: fixed.id, ...onCall }, ctx.asNurse, new Date()); // prettier-ignore
    expect((await ctx.reports.corrections(ctx.asNurse, new Date())).map((e) => e.resultId)).toEqual([fixed.id]); // prettier-ignore
    // Control positivo: al representante, sí.
    await ctx.reports.notify({ resultId: fixed.id, ...toPatient, recipientKind: 'REPRESENTATIVE', recipientName: 'Su hija' }, ctx.asNurse, new Date()); // prettier-ignore
    expect(await ctx.reports.corrections(ctx.asNurse, new Date())).toEqual([]);
  });

  it('ORD-154 la cola de correcciones vence con el plazo de críticos de la sede y escala a la guardia, con las llamadas sin respuesta', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    // Sólo se avisó a un médico: no toca al paciente por ORD-153.
    await ctx.reports.notify({ resultId: ctx.result.id, ...onCall, notifiedAt: minutesAgo(90) }, ctx.asNurse, new Date()); // prettier-ignore
    const fixed = (await correctTo(ctx, ctx.report.id, 95)).results[0]!;
    await ctx.reports.notify({ resultId: fixed.id, ...onCall, outcome: 'NO_ANSWER', readBack: undefined }, ctx.asNurse, new Date()); // prettier-ignore

    const [fresh] = await ctx.reports.corrections(ctx.asNurse, new Date());
    expect(fresh).toMatchObject({ patientRequired: false, overdue: false, noAnswerAttempts: 1 }); // prettier-ignore
    // 60 minutos de fábrica, desde que se registró la corrección.
    expect(fresh!.noticeDueAt.getTime() - fresh!.correctedAt.getTime()).toBe(60 * 60_000); // prettier-ignore

    const later = new Date(fresh!.correctedAt.getTime() + 61 * 60_000);
    // La sede no tiene horario: fuera de horario y sin guardia, al paciente.
    const [late] = await ctx.reports.corrections(ctx.asNurse, later);
    expect(late).toMatchObject({ waitingMinutes: 61, overdue: true, afterHours: true, noticeTarget: 'PATIENT', escalationMissing: true, escalateTo: null }); // prettier-ignore

    const role = await prisma.role.create({
      data: { code: 'GUARDIA_CLINICA', name: 'Responsable clínico de guardia' },
    });
    await prisma.siteParameter.update({
      where: { siteId: ctx.scene.site.id },
      data: {
        criticalEscalationRoleId: role.id,
        criticalNoticeWithinMinutes: 120,
      },
    });
    const [onCallNow] = await ctx.reports.corrections(ctx.asNurse, later);
    expect(onCallNow).toMatchObject({ overdue: false, noticeTarget: 'ON_CALL_ROLE', escalationMissing: false, escalateTo: { roleId: role.id } }); // prettier-ignore
    expect(onCallNow!.noticeDueAt.getTime() - onCallNow!.correctedAt.getTime()).toBe(120 * 60_000); // prettier-ignore
  });

  it('ORD-155 el aviso que el médico registra a su nombre de la llamada que le hizo la enfermera no es autoaviso y cierra la cola de críticos', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const now = new Date();
    const toMe = { ...toPatient, recipientKind: 'ORDERING_PRACTITIONER' as const, recipientName: 'Ana Villacís' }; // prettier-ignore
    // Control positivo: sin quien llamó, es un autoaviso y no cierra.
    const own = await ctx.reports.notify({ resultId: ctx.result.id, ...toMe }, ctx.asDoctor, now); // prettier-ignore
    expect(own.selfNotice).toBe(true);
    expect(await ctx.reports.critical(ctx.asNurse, now)).toHaveLength(1);

    const other = await aCriticalGlucose(prisma, ctx.scene);
    const called = await other.reports.notify({ resultId: other.result.id, ...toMe, callerName: 'Lcda. Rosa Pilco' }, other.asDoctor, now); // prettier-ignore
    expect(called.selfNotice).toBe(false);
    const stored = await prisma.criticalResultNotice.findUniqueOrThrow({ where: { id: called.id } }); // prettier-ignore
    expect(stored.selfNotice).toBe(false);
    expect((await ctx.reports.critical(ctx.asNurse, now)).map((e) => e.resultId)).toEqual([ctx.result.id]); // prettier-ignore
  });

  it('ORD-157 el destinatario con las palabras del nombre de quien registra en otro orden es un autoaviso', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const now = new Date();
    // La enfermera es Carmen Salazar; «Salazar Carmen», como en la cédula.
    const own = await ctx.reports.notify({ resultId: ctx.result.id, ...onCall, recipientName: 'Salazar Carmen' }, ctx.asNurse, now); // prettier-ignore
    expect(own.selfNotice).toBe(true);
    expect(await ctx.reports.critical(ctx.asNurse, now)).toHaveLength(1);
    // Control positivo: con una palabra más, es otra persona.
    const other = await ctx.reports.notify({ resultId: ctx.result.id, ...onCall, recipientName: 'Salazar Carmen Pilco' }, ctx.asNurse, now); // prettier-ignore
    expect(other.selfNotice).toBe(false);
    expect(await ctx.reports.critical(ctx.asNurse, now)).toEqual([]);
  });

  it('ORD-155 al editar el autoaviso para decir que llamó la enfermera, deja de serlo y saca el valor de la cola de críticos', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    const now = new Date();
    const toMe = { ...toPatient, recipientKind: 'ORDERING_PRACTITIONER' as const, recipientName: 'Ana Villacís' }; // prettier-ignore
    const own = await ctx.reports.notify({ resultId: ctx.result.id, ...toMe }, ctx.asDoctor, now); // prettier-ignore
    expect(own.selfNotice).toBe(true);
    // Control positivo: editado con quien llamó «Dr.», que no nombra a nadie, sigue siéndolo.
    const titleOnly = await ctx.reports.editNotice({ resultId: ctx.result.id, noticeId: own.id, expectedEditedAt: null, ...toMe, callerName: 'Dr.' }, ctx.asDoctor, new Date()); // prettier-ignore
    expect(titleOnly.selfNotice).toBe(true);
    expect(await ctx.reports.critical(ctx.asNurse, new Date())).toHaveLength(1);

    const edited = await ctx.reports.editNotice({ resultId: ctx.result.id, noticeId: own.id, expectedEditedAt: titleOnly.editedAt, ...toMe, callerName: 'Lcda. Rosa Pilco' }, ctx.asDoctor, new Date()); // prettier-ignore
    expect(edited.selfNotice).toBe(false);
    const stored = await prisma.criticalResultNotice.findUniqueOrThrow({ where: { id: own.id } }); // prettier-ignore
    expect(stored.selfNotice).toBe(false);
    expect(await ctx.reports.critical(ctx.asNurse, new Date())).toEqual([]);
  });

  it('ORD-154 ORD-146 tras el autoaviso de la corrección del médico que pidió, la cola de correcciones dice que toca al paciente', async () => {
    const prisma = db();
    const ctx = await aCriticalGlucose(prisma);
    // Al médico que pidió se le avisó del 25 por otra persona: no toca al paciente por ORD-153.
    await ctx.reports.notify({ resultId: ctx.result.id, ...onCall, recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'Ana Villacís', notifiedAt: minutesAgo(90) }, ctx.asNurse, new Date()); // prettier-ignore
    const fixed = (await correctTo(ctx, ctx.report.id, 95)).results[0]!;
    // Fuera de horario y con guardia: le toca a la guardia (control positivo).
    const role = await prisma.role.create({ data: { code: 'GUARDIA_CLINICA', name: 'Responsable clínico de guardia' } }); // prettier-ignore
    await prisma.siteParameter.update({ where: { siteId: ctx.scene.site.id }, data: { criticalEscalationRoleId: role.id } }); // prettier-ignore
    const [before] = await ctx.reports.corrections(ctx.asNurse, new Date());
    expect(before).toMatchObject({ patientRequired: false, noticeTarget: 'ON_CALL_ROLE' }); // prettier-ignore

    await ctx.reports.notify({ resultId: fixed.id, ...toPatient, recipientKind: 'ORDERING_PRACTITIONER', recipientName: 'Yo' }, ctx.asDoctor, new Date()); // prettier-ignore
    const [after] = await ctx.reports.corrections(ctx.asNurse, new Date());
    expect(after).toMatchObject({
      resultId: fixed.id,
      noticeTarget: 'PATIENT',
    });
  });
});
