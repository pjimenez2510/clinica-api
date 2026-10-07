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
import { createSite, createUser } from './setup/fixtures';
import { OrderItemNotPendingError } from '../../src/modules/orders/domain/orders.errors';

/**
 * The result against a real PostgreSQL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT ONLY THE DATABASE CAN DEMONSTRATE HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  - `trg_service_order_item_pending` taking a line OUT of the worklist when
 *    its last determination arrives (ORD-039). That is the moment the whole
 *    module is about, and the moment nothing in the application decides.
 *  - The `UNIQUE` on `diagnostic_report.supersedes_id` refusing a second
 *    correction of the same report (ORD-052) — including one that comes in by
 *    raw SQL, which is how an import or a `psql` reaches it.
 *  - THE OLD ROW SURVIVING THE CORRECTION UNTOUCHED (ORD-050). A double can
 *    show that no update was ISSUED; only the database can show that the value
 *    a clinician acted on is still there to be read.
 *  - THE PAIRING OF AN ORPHAN RESULT BEING CONFINED TO ITS OWN ORDER
 *    (ORD-043). There is no `CHECK` tying `order_item_id` to the report's
 *    order (⚠️ **Falta esquema**), so the refusal inside the write's own
 *    transaction is the whole guarantee — and a double asserting that the
 *    adapter was CALLED correctly would prove nothing about the row that
 *    lands.
 *
 * And the flag itself is exercised end to end with the REAL seeded ranges, so
 * the same 12,5 g/dL comes back `NORMAL` for one patient and `LOW` for another.
 */
const db = useDatabase();

/** ORD-092. The worklists write nothing here; the reads do. */
const silentAudit: AccessAuditRecorder = { record: () => Promise.resolve() };

const requester: Requester = { userId: 'user-1', sites: 'all' };

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

/** A scene with one order for the complete blood count already placed. */
async function anOrderedBloodCount(
  prisma: PrismaClient,
  options: { sex?: 'MALE' | 'FEMALE' } = {},
) {
  const scene = await aScene(prisma, options);
  const { orders } = serviceOf(prisma);

  const order = await placeIssued(orders, {
    encounterId: scene.encounter.id,
    category: 'LABORATORY',
    priority: 'ROUTINE',
    lines: [{ examDefinitionId: scene.bh.id }],
    sites: 'all',
  });

  return { ...scene, order };
}

describe('el resultado de laboratorio contra PostgreSQL', () => {
  it('ORD-034 y ORD-037 congelan la unidad y el rango que exige la columna del 010B', async () => {
    const prisma = db();
    const scene = await anOrderedBloodCount(prisma);
    const { reports } = serviceOf(prisma);

    const report = await reports.register(
      {
        orderId: scene.order.id,
        performedById: null,
        issuedAt: new Date('2026-09-16T13:00:00Z'),
        results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 12.5 }],
      },
      requester,
    );

    expect(report.results[0]).toMatchObject({
      analyteDisplay: 'Hemoglobina',
      valueNumeric: 12.5,
      unit: 'g/dL',
      referenceLow: 12,
      referenceHigh: 15.5,
    });
  });

  it('ORD-036 clasifica la MISMA hemoglobina distinto según el sexo del paciente', async () => {
    const prisma = db();

    const she = await anOrderedBloodCount(prisma, { sex: 'FEMALE' });
    const women = serviceOf(prisma);
    const hers = await women.reports.register(
      {
        orderId: she.order.id,
        performedById: null,
        issuedAt: new Date('2026-09-16T13:00:00Z'),
        results: [{ analyteDefinitionId: she.hb.id, valueNumeric: 12.5 }],
      },
      requester,
    );

    // Segunda escena completa: otro paciente, otra sede, otro catálogo NO —
    // los analitos son únicos por código, así que se reutilizan los de arriba.
    const site = await createSite(prisma, 'Sede Norte');
    const patient = await prisma.patient.create({
      data: {
        mrn: 'HC900001',
        familyName: 'Quishpe',
        givenName: 'Luis',
        sex: 'MALE',
        birthDate: new Date('1988-05-02'),
      },
    });
    const encounter = await prisma.encounter.create({
      data: {
        siteId: site.id,
        practitionerId: she.practitioner.id,
        patientId: patient.id,
        startedAt: new Date('2026-09-14T14:00:00Z'),
        careModality: 'MORBIDITY',
        visitSequence: 'FIRST_TIME',
      },
    });
    const hisOrder = await placeIssued(women.orders, {
      encounterId: encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: she.bh.id }],
      sites: 'all',
    });
    const his = await women.reports.register(
      {
        orderId: hisOrder.id,
        performedById: null,
        issuedAt: new Date('2026-09-16T13:00:00Z'),
        results: [{ analyteDefinitionId: she.hb.id, valueNumeric: 12.5 }],
      },
      requester,
    );

    // Con un rango único, este número marcaría como anémica a media población
    // o a ninguna. Es el caso que justifica que el rango sea una tabla.
    expect(hers.results[0]?.abnormalFlag).toBe('NORMAL');
    expect(his.results[0]?.abnormalFlag).toBe('LOW');
    expect(his.results[0]?.referenceLow).toBe(13);
  });

  it('ORD-039 saca la línea de la cola cuando llegan todas sus determinaciones', async () => {
    const prisma = db();
    const scene = await anOrderedBloodCount(prisma);
    const { reports, orders } = serviceOf(prisma);

    await reports.register(
      {
        orderId: scene.order.id,
        performedById: null,
        issuedAt: new Date('2026-09-16T13:00:00Z'),
        results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 }],
      },
      requester,
    );

    // El disparador es lo que hace posible que la cola sea un índice parcial:
    // la fila SALE del índice al ponerse `completed_at`.
    const stored = await prisma.serviceOrder.findFirstOrThrow({
      where: { id: scene.order.id },
      select: { pendingItems: true, items: { select: { status: true, completedAt: true } } }, // prettier-ignore
    });
    expect(stored.pendingItems).toBe(0);
    expect(stored.items[0]?.status).toBe('COMPLETED');
    expect(stored.items[0]?.completedAt).not.toBeNull();

    expect(
      await orders.pending({ sites: 'all', now: new Date(), limit: 50 }),
    ).toEqual([]);
  });

  it('ORD-040 guarda sin línea el valor que nadie pidió y lo deja en su cola', async () => {
    const prisma = db();
    const scene = await anOrderedBloodCount(prisma);
    const { reports, store } = serviceOf(prisma);

    // Se pidió biometría; el laboratorio devuelve además una glucosa.
    await reports.register(
      {
        orderId: scene.order.id,
        performedById: null,
        issuedAt: new Date('2026-09-16T13:00:00Z'),
        results: [
          { analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 },
          { analyteDefinitionId: scene.glu.id, valueNumeric: 92 },
        ],
      },
      requester,
    );

    // Ni se descarta ni se empareja solo: un valor que llega de más suele ser
    // un panel ampliado y a veces es el informe de otro paciente.
    const unmatched = await store.unmatched({ sites: 'all', limit: 50 });
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]).toMatchObject({
      analyteDisplay: 'Glucosa en ayunas',
      valueNumeric: 92,
      patientId: scene.patient.id,
    });
  });

  it('ORD-043 empareja el resultado huérfano con una línea de SU orden y lo saca de la cola', async () => {
    // La cola tenía entrada y no salida. Una cola que sólo crece deja de
    // mirarse, y una red de seguridad que nadie mira es una lista.
    const prisma = db();
    const scene = await anOrderedBloodCount(prisma);
    const { reports, store } = serviceOf(prisma);

    await reports.register(
      {
        orderId: scene.order.id,
        performedById: null,
        issuedAt: new Date('2026-09-16T13:00:00Z'),
        results: [
          { analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 },
          { analyteDefinitionId: scene.glu.id, valueNumeric: 92 },
        ],
      },
      requester,
    );

    const orphan = (await store.unmatched({ sites: 'all', limit: 50 }))[0];
    expect(orphan?.analyteDisplay).toBe('Glucosa en ayunas');

    const line = scene.order.items[0]!;
    const report = await reports.match(
      { resultId: orphan!.resultId, orderItemId: line.id },
      requester,
    );

    // Ya no está huérfano, y la cola queda vacía —que es lo que permite que se
    // siga mirando—.
    expect(
      report.results.find((r) => r.analyteDisplay === 'Glucosa en ayunas')
        ?.orderItemId,
    ).toBe(line.id);
    expect(await store.unmatched({ sites: 'all', limit: 50 })).toEqual([]);
    // Nada se creó ni se borró: la fila es la misma, apuntando a una línea.
    expect(await prisma.observationResult.count()).toBe(2);
  });

  it('ORD-043 no deja emparejar con la línea de OTRA orden, que cerraría una línea con la sangre de otro', async () => {
    /**
     * No hay `CHECK` que ate `order_item_id` a la orden del informe (⚠️ falta
     * esquema), así que la negativa dentro de la transacción que escribe es
     * toda la garantía. Y lo que impide es concreto: `pending_items` y la regla
     * de completitud contarían un valor que esa orden nunca recibió.
     */
    const prisma = db();
    const mine = await anOrderedBloodCount(prisma);
    const { reports, orders, store } = serviceOf(prisma);

    await reports.register(
      {
        orderId: mine.order.id,
        performedById: null,
        issuedAt: new Date('2026-09-16T13:00:00Z'),
        results: [{ analyteDefinitionId: mine.glu.id, valueNumeric: 92 }],
      },
      requester,
    );

    // Una segunda orden, de otra atención, con su propia línea.
    const otherEncounter = await prisma.encounter.create({
      data: {
        siteId: mine.site.id,
        practitionerId: mine.practitioner.id,
        patientId: mine.patient.id,
        startedAt: new Date('2026-09-17T13:00:00Z'),
        careModality: 'MORBIDITY',
        visitSequence: 'SUBSEQUENT',
      },
    });
    const otherOrder = await placeIssued(orders, {
      encounterId: otherEncounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: mine.bh.id }],
      sites: 'all',
    });

    const orphan = (await store.unmatched({ sites: 'all', limit: 50 }))[0];

    await expect(
      reports.match(
        { resultId: orphan!.resultId, orderItemId: otherOrder.items[0]!.id },
        requester,
      ),
    ).rejects.toMatchObject({ code: 'ORDER_ITEM_NOT_MATCHABLE' });

    // Y sigue en la cola, sin haberse tocado.
    expect(await store.unmatched({ sites: 'all', limit: 50 })).toHaveLength(1);
  });

  it('ORD-043 rechaza el segundo emparejamiento del mismo resultado', async () => {
    // Dos personas trabajando la misma cola es lo corriente: una gana, y la
    // otra no puede volver a apuntar una fila que alguien ya resolvió.
    const prisma = db();
    const scene = await anOrderedBloodCount(prisma);
    const { reports, store } = serviceOf(prisma);

    await reports.register(
      {
        orderId: scene.order.id,
        performedById: null,
        issuedAt: new Date('2026-09-16T13:00:00Z'),
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 92 }],
      },
      requester,
    );

    const orphan = (await store.unmatched({ sites: 'all', limit: 50 }))[0];
    const line = scene.order.items[0]!;
    await reports.match(
      { resultId: orphan!.resultId, orderItemId: line.id },
      requester,
    );

    await expect(
      reports.match(
        { resultId: orphan!.resultId, orderItemId: line.id },
        requester,
      ),
    ).rejects.toMatchObject({ code: 'RESULT_ALREADY_MATCHED' });
  });

  it('ORD-039 y ORD-043 el emparejamiento no cierra una línea a la que le falta una determinación', async () => {
    /**
     * La biometría promete hemoglobina y sólo llegó la glucosa. Emparejar la
     * glucosa con esa línea NO la completa: la regla es la misma que usa el
     * registro, así que una línea cerrada por un emparejamiento y otra cerrada
     * por un informe no pueden discrepar sobre qué es «completa». Una línea que
     * se cerrara aquí saldría de la cola de pendientes sin que nadie haya visto
     * la hemoglobina.
     */
    const prisma = db();
    const scene = await anOrderedBloodCount(prisma);
    const { reports, store } = serviceOf(prisma);

    await reports.register(
      {
        orderId: scene.order.id,
        performedById: null,
        issuedAt: new Date('2026-09-16T13:00:00Z'),
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 92 }],
      },
      requester,
    );

    const orphan = (await store.unmatched({ sites: 'all', limit: 50 }))[0];
    await reports.match(
      { resultId: orphan!.resultId, orderItemId: scene.order.items[0]!.id },
      requester,
    );

    const stored = await prisma.serviceOrder.findFirstOrThrow({
      where: { id: scene.order.id },
      select: { pendingItems: true, items: { select: { status: true, completedAt: true } } }, // prettier-ignore
    });
    expect(stored.pendingItems).toBe(1);
    expect(stored.items[0]?.completedAt).toBeNull();
  });

  it('ORD-090 y ORD-043 responden lo mismo por un resultado de otra sede que por uno inexistente', async () => {
    const prisma = db();
    const scene = await anOrderedBloodCount(prisma);
    const { reports, store } = serviceOf(prisma);
    const elsewhere = await createSite(prisma, 'Sede Sur');

    await reports.register(
      {
        orderId: scene.order.id,
        performedById: null,
        issuedAt: new Date('2026-09-16T13:00:00Z'),
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 92 }],
      },
      requester,
    );
    const orphan = (await store.unmatched({ sites: 'all', limit: 50 }))[0];

    const outsider: Requester = { userId: 'user-2', sites: [elsewhere.id] };

    await expect(
      reports.match(
        { resultId: orphan!.resultId, orderItemId: scene.order.items[0]!.id },
        outsider,
      ),
    ).rejects.toMatchObject({ code: 'RESULT_NOT_FOUND' });

    // Y un identificador que ni siquiera es un número responde igual: «no es un
    // número» y «no existe» son la misma situación para quien preguntó.
    await expect(
      reports.match(
        { resultId: 'no-es-un-numero', orderItemId: scene.order.items[0]!.id },
        requester,
      ),
    ).rejects.toMatchObject({ code: 'RESULT_NOT_FOUND' });
  });

  it('ORD-060 y ORD-061 sacan el valor crítico a su cola sin que el laboratorio lo marque', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const { reports, orders, store } = serviceOf(prisma);

    const order = await placeIssued(orders, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.glucose.id }], // prettier-ignore
      sites: 'all',
    });

    // 25 mg/dL: por debajo de 70 —bajo— y por debajo de 40 —crítico—. El
    // informe no trae bandera ninguna, que es el caso corriente.
    const report = await reports.register(
      {
        orderId: order.id,
        performedById: null,
        issuedAt: new Date('2026-09-16T13:00:00Z'),
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 25 }],
      },
      requester,
    );

    expect(report.results[0]?.abnormalFlag).toBe('CRITICAL_LOW');
    // Y el VALOR DE REFERENCIA impreso sigue siendo el normal: si trajera
    // 40–400, el paciente leería que cualquier glucosa bajo 400 está bien.
    expect(report.results[0]).toMatchObject({ referenceLow: 70, referenceHigh: 100 }); // prettier-ignore

    const critical = await store.critical({ sites: 'all' });
    expect(critical).toHaveLength(1);
    expect(critical[0]?.abnormalFlag).toBe('CRITICAL_LOW');
  });

  /**
   * El defecto que apareció recorriendo el flujo por pantalla, y no en revisión:
   * una glucosa de 450 corregida a 95 SEGUÍA en esta cola como pendiente de
   * avisar.
   *
   * No es cosmético. Esta cola existe para que alguien ACTÚE sobre un valor, y
   * actuar sobre una cifra que el laboratorio ya retractó significa llamar a un
   * paciente por un resultado que no es el suyo — peor que el silencio que la
   * cola viene a evitar.
   */
  it('ORD-061 saca de la cola de críticos el valor que una corrección ya sustituyó', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const { orders, reports, store } = serviceOf(prisma);

    const order = await placeIssued(orders, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.glucose.id }], // prettier-ignore
      sites: 'all',
    });

    const wrong = await reports.register(
      {
        orderId: order.id,
        performedById: null,
        issuedAt: new Date('2026-09-16T13:00:00Z'),
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 25 }],
      },
      requester,
    );
    expect(await store.critical({ sites: 'all' })).toHaveLength(1);

    await reports.correct(
      {
        reportId: wrong.id,
        performedById: null,
        issuedAt: new Date('2026-09-16T15:00:00Z'),
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 95 }],
      },
      requester,
    );

    // El 25 sigue siendo LEGIBLE en el histórico —una corrección nunca
    // sobrescribe— pero deja de ser algo que alguien tenga que ir a avisar.
    expect(await store.critical({ sites: 'all' })).toEqual([]);
  });

  it('ORD-050 corrige sin tocar el valor anterior, que sigue legible', async () => {
    const prisma = db();
    const scene = await anOrderedBloodCount(prisma);
    const { reports, store } = serviceOf(prisma);

    const original = await reports.register(
      {
        orderId: scene.order.id,
        performedById: null,
        issuedAt: new Date('2026-09-16T13:00:00Z'),
        results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 }],
      },
      requester,
    );

    const correction = await reports.correct(
      {
        reportId: original.id,
        performedById: null,
        issuedAt: new Date('2026-09-18T13:00:00Z'),
        results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 9.1 }],
      },
      requester,
    );

    // El médico que mandó a casa a la paciente con 13,4 tiene que poder ver
    // el 13,4. Un valor que cambia en silencio es un incidente de seguridad.
    const before = await store.byId({ reportId: original.id, sites: 'all' });
    expect(before?.results[0]?.valueNumeric).toBe(13.4);
    expect(before?.supersededById).toBe(correction.id);
    expect(before?.supersededAt).toEqual(new Date('2026-09-18T13:00:00Z'));

    expect(correction.status).toBe('CORRECTED');
    expect(correction.supersedesId).toBe(original.id);
    expect(correction.results[0]?.valueNumeric).toBe(9.1);
    // ORD-054. La bandera se recalcula con la misma regla: 9,1 g/dL en una
    // paciente está por debajo de 12,0.
    expect(correction.results[0]?.abnormalFlag).toBe('LOW');

    // Las dos filas existen. Nada se sobrescribió.
    expect(await prisma.observationResult.count()).toBe(2);
  });

  it('ORD-119 un informe parcial se completa editándolo: queda FINAL, la versión anterior sigue legible y la línea se cierra', async () => {
    const prisma = db();
    const scene = await anOrderedBloodCount(prisma);
    // The blood count promises a second, non-reflex determination here.
    await prisma.examDefinitionAnalyte.create({
      data: { examDefinitionId: scene.bh.id, analyteDefinitionId: scene.glu.id, position: 2 }, // prettier-ignore
    });
    const { reports, store } = serviceOf(prisma);
    const issuedAt = new Date(Date.now() - 2 * 3_600_000);

    const partial = await reports.register(
      {
        orderId: scene.order.id,
        performedById: null,
        issuedAt,
        results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 }],
      },
      requester,
    );
    // Positive control: with one of two, the report is partial and the line
    // still waits.
    expect(partial.status).toBe('PARTIAL');
    const line = () =>
      prisma.serviceOrderItem.findFirstOrThrow({
        where: { serviceOrderId: scene.order.id },
      });
    expect((await line()).status).toBe('REQUESTED');

    const completed = await reports.correct(
      {
        reportId: partial.id,
        performedById: null,
        issuedAt,
        results: [
          { analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 },
          { analyteDefinitionId: scene.glu.id, valueNumeric: 92 },
        ],
      },
      requester,
    );

    expect(completed).toMatchObject({ status: 'FINAL', supersedesId: partial.id }); // prettier-ignore
    expect(completed.results.map((result) => result.analyteDisplay)).toEqual([
      'Hemoglobina',
      'Glucosa en ayunas',
    ]);
    const before = await store.byId({ reportId: partial.id, sites: 'all' });
    expect(before?.supersededById).toBe(completed.id);
    expect(before?.results.map((result) => result.valueNumeric)).toEqual([13.4]); // prettier-ignore
    expect((await line()).status).toBe('COMPLETED');
  });

  it('ORD-119 editar un parcial cambiando un valor que ya decía lo deja CORREGIDO, no en silencio', async () => {
    const prisma = db();
    const scene = await anOrderedBloodCount(prisma);
    await prisma.examDefinitionAnalyte.create({
      data: { examDefinitionId: scene.bh.id, analyteDefinitionId: scene.glu.id, position: 2 }, // prettier-ignore
    });
    const { reports } = serviceOf(prisma);
    const issuedAt = new Date(Date.now() - 2 * 3_600_000);
    const partial = await reports.register(
      { orderId: scene.order.id, performedById: null, issuedAt, results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 }] }, // prettier-ignore
      requester,
    );

    const changed = await reports.correct(
      {
        reportId: partial.id,
        performedById: null,
        issuedAt,
        results: [
          { analyteDefinitionId: scene.hb.id, valueNumeric: 9.1 },
          { analyteDefinitionId: scene.glu.id, valueNumeric: 92 },
        ],
      },
      requester,
    );

    expect(changed).toMatchObject({ status: 'CORRECTED', supersedesId: partial.id }); // prettier-ignore
  });

  it('ORD-119 un parcial editado que sigue incompleto queda PARCIAL aunque cambie un valor; completarlo cambiando la conclusión lo deja CORREGIDO', async () => {
    const prisma = db();
    const scene = await anOrderedBloodCount(prisma);
    await prisma.examDefinitionAnalyte.create({
      data: { examDefinitionId: scene.bh.id, analyteDefinitionId: scene.glu.id, position: 2 }, // prettier-ignore
    });
    const { reports, store } = serviceOf(prisma);
    const issuedAt = new Date(Date.now() - 2 * 3_600_000);
    const line = () =>
      prisma.serviceOrderItem.findFirstOrThrow({
        where: { serviceOrderId: scene.order.id },
      });
    const first = await reports.register(
      { orderId: scene.order.id, performedById: null, issuedAt, conclusion: 'Muestra lipémica', results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 }] }, // prettier-ignore
      requester,
    );

    // Cambia la hemoglobina, y la glucosa sigue sin llegar.
    const second = await reports.correct(
      { reportId: first.id, performedById: null, issuedAt, conclusion: 'Muestra lipémica', results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 9.1 }] }, // prettier-ignore
      requester,
    );
    expect(second).toMatchObject({ status: 'PARTIAL', supersedesId: first.id });
    // El cambio no es silencioso: el primero queda sustituido y legible.
    const replaced = await store.byId({ reportId: first.id, sites: 'all' });
    expect(replaced?.supersededById).toBe(second.id);
    expect(replaced?.results.map((result) => result.valueNumeric)).toEqual([13.4]); // prettier-ignore
    expect((await line()).status).toBe('REQUESTED');

    // Se completa con los mismos valores, pero la conclusión dice otra cosa.
    const third = await reports.correct(
      {
        reportId: second.id,
        performedById: null,
        issuedAt,
        conclusion: 'Sin observaciones',
        results: [
          { analyteDefinitionId: scene.hb.id, valueNumeric: 9.1 },
          { analyteDefinitionId: scene.glu.id, valueNumeric: 92 },
        ],
      },
      requester,
    );
    expect(third).toMatchObject({ status: 'CORRECTED', supersedesId: second.id }); // prettier-ignore
    expect((await line()).status).toBe('COMPLETED');

    // Control positivo: otro parcial, completado con la MISMA conclusión, es FINAL.
    const other = await placeIssued(serviceOf(prisma).orders, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.bh.id }],
      sites: 'all',
    });
    const partial = await reports.register(
      { orderId: other.id, performedById: null, issuedAt, conclusion: 'Muestra lipémica', results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 }] }, // prettier-ignore
      requester,
    );
    const completed = await reports.correct(
      {
        reportId: partial.id,
        performedById: null,
        issuedAt,
        conclusion: 'Muestra lipémica',
        results: [
          { analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 },
          { analyteDefinitionId: scene.glu.id, valueNumeric: 92 },
        ],
      },
      requester,
    );
    expect(completed.status).toBe('FINAL');
  });

  it('ORD-052 impide que la cadena de correcciones se bifurque, también por SQL directo', async () => {
    const prisma = db();
    const scene = await anOrderedBloodCount(prisma);
    const { reports } = serviceOf(prisma);

    const original = await reports.register(
      {
        orderId: scene.order.id,
        performedById: null,
        issuedAt: new Date('2026-09-16T13:00:00Z'),
        results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 }],
      },
      requester,
    );
    await reports.correct(
      {
        reportId: original.id,
        performedById: null,
        issuedAt: new Date('2026-09-18T13:00:00Z'),
        results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 9.1 }],
      },
      requester,
    );

    // Por la aplicación: una frase.
    await expect(
      reports.correct(
        {
          reportId: original.id,
          performedById: null,
          issuedAt: new Date('2026-09-19T13:00:00Z'),
          results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 10 }],
        },
        requester,
      ),
    ).rejects.toMatchObject({ code: 'REPORT_ALREADY_CORRECTED' });

    // Y por debajo de la aplicación: el `UNIQUE` de la base, que es lo que
    // también detiene un import o un `psql`. Sin él, dos médicos verían dos
    // resultados finales distintos del mismo tubo.
    await expect(
      prisma.$executeRaw`
        INSERT INTO "diagnostic_report"
          ("service_order_id", "status", "supersedes_id", "updated_at")
        VALUES (${scene.order.id}::uuid, 'CORRECTED', ${original.id}::uuid,
                CURRENT_TIMESTAMP)`,
    ).rejects.toThrow();
  });

  it('ORD-122 congela los límites críticos aplicados, y la base rechaza una bandera que no explican', async () => {
    const prisma = db();
    const scene = await anOrderedBloodCount(prisma);
    const { reports } = serviceOf(prisma);
    const report = await reports.register(
      {
        orderId: scene.order.id,
        performedById: null,
        issuedAt: new Date(Date.now() - 3_600_000),
        results: [
          { analyteDefinitionId: scene.glu.id, valueNumeric: 92 },
          { analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 },
        ],
      },
      requester,
    );
    const glucose = await prisma.observationResult.findFirstOrThrow({ where: { reportId: report.id, analyteDisplay: scene.glu.name } }); // prettier-ignore
    expect(glucose).toMatchObject({ abnormalFlag: 'NORMAL' });
    expect([Number(glucose.criticalLow), Number(glucose.criticalHigh)]).toEqual([40, 400]); // prettier-ignore
    const hb = await prisma.observationResult.findFirstOrThrow({ where: { reportId: report.id, analyteDisplay: scene.hb.name } }); // prettier-ignore
    // Sin crítico definido, ningún lado.
    expect([hb.criticalLow, hb.criticalHigh]).toEqual([null, null]);

    // Filas escritas por SQL directo en el mismo informe: lo que también
    // detiene un import o un `psql`.
    const insert = (value: number, flag: string | null, low: number | null, high: number | null) =>
      prisma.$executeRaw`
        INSERT INTO "observation_result"
          ("report_id", "analyte_display", "value_numeric", "unit", "critical_low", "critical_high", "abnormal_flag", "observed_at")
        VALUES (${report.id}::uuid, 'Glucosa en ayunas', ${value}, 'mg/dL', ${low}, ${high},
                ${flag}::abnormal_flag, ${new Date()})`; // prettier-ignore
    const refused = expect.objectContaining({ message: expect.stringContaining('observation_result_flag_agrees_with_critical_bounds') }); // prettier-ignore

    // Control positivo: filas que sus límites explican entran, bordes incluidos.
    await expect(insert(450, 'CRITICAL_HIGH', 40, 400)).resolves.toBe(1);
    await expect(insert(30, 'CRITICAL_LOW', 40, 400)).resolves.toBe(1);
    await expect(insert(400, 'HIGH', 40, 400)).resolves.toBe(1); // el borde no es crítico
    await expect(insert(40, 'LOW', 40, 400)).resolves.toBe(1);
    // Crítica sin el límite que la hace crítica, o en el borde.
    await expect(insert(300, 'CRITICAL_HIGH', 40, 400)).rejects.toEqual(
      refused,
    );
    await expect(insert(400, 'CRITICAL_HIGH', 40, 400)).rejects.toEqual(
      refused,
    );
    await expect(insert(30, 'CRITICAL_LOW', null, 400)).rejects.toEqual(
      refused,
    );
    // Fuera de sus límites y marcada como no crítica: el caso que saca de la cola.
    await expect(insert(450, 'HIGH', 40, 400)).rejects.toEqual(refused);
    await expect(insert(450, null, 40, 400)).rejects.toEqual(refused);
    // Límites en una determinación que no es numérica.
    await expect(
      prisma.$executeRaw`
        INSERT INTO "observation_result" ("report_id", "analyte_display", "value_text", "critical_high", "observed_at")
        VALUES (${report.id}::uuid, 'Aspecto', 'Hemolizada', 400, ${new Date()})`, // prettier-ignore
    ).rejects.toEqual(refused);
  });

  it('ORD-050 ORD-122 la base no deja reescribir ni borrar un resultado; sólo emparejar el que no tiene línea', async () => {
    const prisma = db();
    const scene = await anOrderedBloodCount(prisma);
    const { reports } = serviceOf(prisma);
    const report = await reports.register(
      {
        orderId: scene.order.id,
        performedById: null,
        issuedAt: new Date(Date.now() - 3_600_000),
        // Una glucosa crítica que la orden de biometría no pidió: sin línea.
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 420 }],
      },
      requester,
    );
    const row = await prisma.observationResult.findFirstOrThrow({ where: { reportId: report.id } }); // prettier-ignore
    expect(row).toMatchObject({ abnormalFlag: 'CRITICAL_HIGH', orderItemId: null }); // prettier-ignore
    const frozen = expect.objectContaining({ message: expect.stringContaining('observation_result_frozen') }); // prettier-ignore

    // Subir el umbral congelado y bajar la bandera a la vez pasaría el CHECK.
    await expect(prisma.$executeRaw`UPDATE "observation_result" SET "critical_high" = 500, "abnormal_flag" = 'HIGH' WHERE "id" = ${row.id}`).rejects.toEqual(frozen); // prettier-ignore
    await expect(prisma.$executeRaw`UPDATE "observation_result" SET "value_numeric" = 90, "abnormal_flag" = 'NORMAL' WHERE "id" = ${row.id}`).rejects.toEqual(frozen); // prettier-ignore
    await expect(prisma.$executeRaw`DELETE FROM "observation_result" WHERE "id" = ${row.id}`).rejects.toEqual(frozen); // prettier-ignore

    // Control positivo: emparejarlo con una línea, una vez (ORD-043).
    const line = scene.order.items[0]!.id;
    await expect(prisma.$executeRaw`UPDATE "observation_result" SET "order_item_id" = ${line}::uuid WHERE "id" = ${row.id}`).resolves.toBe(1); // prettier-ignore
    // Y no re-apuntarlo después.
    await expect(prisma.$executeRaw`UPDATE "observation_result" SET "order_item_id" = NULL WHERE "id" = ${row.id}`).rejects.toEqual(frozen); // prettier-ignore
  });

  it('ORD-090 no deja leer un informe de una sede fuera del alcance', async () => {
    const prisma = db();
    const scene = await anOrderedBloodCount(prisma);
    const { reports, store } = serviceOf(prisma);
    const otherSite = await createSite(prisma, 'Sede Norte');

    const report = await reports.register(
      {
        orderId: scene.order.id,
        performedById: null,
        issuedAt: new Date('2026-09-16T13:00:00Z'),
        results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 }],
      },
      requester,
    );

    expect(
      await store.byId({ reportId: report.id, sites: [otherSite.id] }),
    ).toBeUndefined();
    expect(await store.critical({ sites: [otherSite.id] })).toEqual([]);
  });

  it('ORD-041 deja el resultado sin orden en su cola informe tras informe, hasta que una persona lo empareja', async () => {
    const prisma = db();
    const scene = await anOrderedBloodCount(prisma);
    const { reports, store } = serviceOf(prisma);
    const now = new Date();
    const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000); // prettier-ignore

    // Se pidió biometría; el laboratorio manda además una glucosa.
    await reports.register(
      {
        orderId: scene.order.id,
        performedById: null,
        issuedAt: hoursAgo(5),
        results: [
          { analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 },
          { analyteDefinitionId: scene.glu.id, valueNumeric: 92 },
        ],
      },
      requester,
    );
    const orphan = (await store.unmatched({ sites: 'all', limit: 50 }))[0];
    expect(orphan?.analyteDisplay).toBe('Glucosa en ayunas');

    // Un segundo informe de la MISMA orden no lo resuelve: nada lo empareja
    // por su cuenta, ni siquiera cuando vuelve a llegar el mismo analito.
    await reports.register(
      {
        orderId: scene.order.id,
        performedById: null,
        issuedAt: hoursAgo(2),
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 90 }],
      },
      requester,
    );
    const still = await store.unmatched({ sites: 'all', limit: 50 });
    expect(still.map((entry) => entry.resultId)).toContain(orphan!.resultId);
    expect(still).toHaveLength(2);
    const stored = await prisma.observationResult.findMany({
      where: { analyteDisplay: 'Glucosa en ayunas' },
      select: { orderItemId: true },
    });
    expect(stored.every((row) => row.orderItemId === null)).toBe(true);

    // Control positivo: la persona lo empareja y SOLO entonces sale.
    await reports.match(
      { resultId: orphan!.resultId, orderItemId: scene.order.items[0]!.id },
      requester,
    );
    const after = await store.unmatched({ sites: 'all', limit: 50 });
    expect(after.map((entry) => entry.resultId)).not.toContain(orphan!.resultId); // prettier-ignore
    expect(after).toHaveLength(1);
  });

  it('ORD-054 registra la corrección en filas nuevas y recalcula la bandera con la misma regla', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const { reports, orders } = serviceOf(prisma);
    const now = new Date();

    const order = await placeIssued(orders, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.glucose.id }],
      sites: 'all',
    });
    const original = await reports.register(
      {
        orderId: order.id,
        performedById: null,
        issuedAt: new Date(now.getTime() - 3 * 3_600_000),
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 95 }],
      },
      requester,
    );
    expect(original.results[0]?.abnormalFlag).toBe('NORMAL');

    // El laboratorio llama: era 25, no 95. La corrección no trae bandera; la
    // pone el sistema con los mismos rangos que al original.
    const correction = await reports.correct(
      {
        reportId: original.id,
        performedById: null,
        issuedAt: new Date(now.getTime() - 3_600_000),
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 25 }],
      },
      requester,
    );

    expect(correction.results[0]).toMatchObject({
      valueNumeric: 25,
      abnormalFlag: 'CRITICAL_LOW',
      unit: 'mg/dL',
      referenceLow: 70,
      referenceHigh: 100,
    });
    expect(correction.results[0]?.id).not.toBe(original.results[0]?.id);

    // La fila vieja, tal cual: 95 y NORMAL, y las dos existen.
    const old = await prisma.observationResult.findFirstOrThrow({
      where: { id: BigInt(original.results[0]!.id) },
      select: { valueNumeric: true, abnormalFlag: true },
    });
    expect(old.valueNumeric?.toNumber()).toBe(95);
    expect(old.abnormalFlag).toBe('NORMAL');
    expect(await prisma.observationResult.count()).toBe(2);
  });

  it('ORD-030 deja el informe parcial mientras falte una determinación del examen', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const { reports, orders } = serviceOf(prisma);

    // Se añade una segunda determinación no refleja a la biometría.
    await prisma.examDefinitionAnalyte.create({
      data: {
        examDefinitionId: scene.bh.id,
        analyteDefinitionId: scene.glu.id,
        position: 2,
      },
    });
    const order = await placeIssued(orders, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.bh.id }],
      sites: 'all',
    });

    const report = await reports.register(
      {
        orderId: order.id,
        performedById: null,
        issuedAt: new Date('2026-09-16T13:00:00Z'),
        results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 }],
      },
      requester,
    );

    expect(report.status).toBe('PARTIAL');
    // Y la línea SIGUE en la cola: la mitad de un informe no es un informe.
    const stored = await prisma.serviceOrder.findFirstOrThrow({
      where: { id: order.id },
      select: { pendingItems: true },
    });
    expect(stored.pendingItems).toBe(1);
  });
  it('ORD-124 rechaza el informe de una orden con todos sus exámenes anulados y no escribe nada', async () => {
    const prisma = db();
    const scene = await anOrderedBloodCount(prisma);
    const { reports, orders } = serviceOf(prisma);
    const canceller = await createUser(prisma);
    await orders.cancelItem({
      orderId: scene.order.id,
      itemId: scene.order.items[0]!.id,
      sites: 'all',
      cancelledById: canceller.id,
    });

    const now = new Date();
    await expect(
      reports.register(
        {
          orderId: scene.order.id,
          performedById: null,
          issuedAt: new Date(now.getTime() - 60 * 60 * 1000),
          results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 }],
        },
        requester,
        now,
      ),
    ).rejects.toBeInstanceOf(OrderItemNotPendingError);

    expect(
      await prisma.diagnosticReport.count({ where: { serviceOrderId: scene.order.id } }), // prettier-ignore
    ).toBe(0);
  });

  it('ORD-124 con un examen vivo y otro anulado el informe entra, y ningún valor queda bajo el anulado', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const { reports, orders } = serviceOf(prisma);
    const order = await placeIssued(orders, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [
        { examDefinitionId: scene.bh.id },
        { examDefinitionId: scene.glucose.id },
      ],
      sites: 'all',
    });
    const glucoseLine = order.items.find((i) => i.testCode === 'EX-GLUCOSA-AYUNAS')!; // prettier-ignore
    const canceller = await createUser(prisma);
    await orders.cancelItem({
      orderId: order.id,
      itemId: glucoseLine.id,
      sites: 'all',
      cancelledById: canceller.id,
    });

    const now = new Date();
    const report = await reports.register(
      {
        orderId: order.id,
        performedById: null,
        issuedAt: new Date(now.getTime() - 60 * 60 * 1000),
        results: [
          { analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 },
          { analyteDefinitionId: scene.glu.id, valueNumeric: 92 },
        ],
      },
      requester,
      now,
    );

    // Control positivo: el informe entra y la biometría cierra su línea.
    expect(report.status).toBe('FINAL');
    const rows = await prisma.observationResult.findMany({
      where: { reportId: report.id },
      select: { analyteDisplay: true, orderItemId: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.orderItemId === glucoseLine.id)).toBe(false);
    // La glucosa que llegó queda sin línea, en su cola (ORD-040).
    expect(rows.find((r) => r.analyteDisplay === 'Glucosa en ayunas')?.orderItemId).toBeNull(); // prettier-ignore
    const stored = await prisma.serviceOrderItem.findUniqueOrThrow({
      where: { id: glucoseLine.id },
      select: { status: true },
    });
    expect(stored.status).toBe('CANCELLED');
  });
});

/**
 * ORD-124, ORD-008 (revisión de la rama). Lo que garantiza la base, y las dos
 * carreras con la anulación, reproducidas sin esperas fijas: una transacción
 * retiene el bloqueo y la prueba espera a ver la otra sesión bloqueada en
 * `pg_locks` antes de soltarlo.
 */
describe('ORD-124 la anulación y el informe, a la vez, contra PostgreSQL', () => {
  /** Waits until some session is waiting on a lock: the race is set. */
  async function untilSomeoneWaits(prisma: PrismaClient): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS "waiting" FROM pg_locks WHERE NOT granted`;
      if (Number(row?.waiting ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error('Nadie quedó esperando el bloqueo'); // prettier-ignore
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async function aTwoLineOrder(prisma: PrismaClient) {
    const scene = await aScene(prisma);
    const { orders } = serviceOf(prisma);
    const order = await placeIssued(orders, {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [
        { examDefinitionId: scene.bh.id },
        { examDefinitionId: scene.glucose.id },
      ],
      sites: 'all',
    });
    const line = (code: string) => order.items.find((i) => i.testCode === code)!; // prettier-ignore
    return { scene, order, bh: line('EX-BH'), glucose: line('EX-GLUCOSA-AYUNAS') }; // prettier-ignore
  }

  it('ORD-124 la base no deja colgar un resultado de una línea anulada; de una viva, sí (control positivo)', async () => {
    const prisma = db();
    const { scene, order, glucose, bh } = await aTwoLineOrder(prisma);
    const { reports, orders } = serviceOf(prisma);
    const now = new Date();
    // Un informe de verdad, del que se copian las filas de prueba.
    const report = await reports.register(
      {
        orderId: order.id,
        performedById: null,
        issuedAt: new Date(now.getTime() - 60 * 60 * 1000),
        results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 }],
      },
      requester,
      now,
    );
    const resultId = report.results[0]!.id;
    await orders.cancelItem({ orderId: order.id, itemId: glucose.id, sites: 'all', cancelledById: (await createUser(prisma)).id }); // prettier-ignore

    await expect(
      prisma.$executeRaw`INSERT INTO "observation_result" ("report_id", "order_item_id", "analyte_display", "value_numeric", "unit", "observed_at")
        SELECT "report_id", ${glucose.id}::uuid, 'Glucosa en ayunas', 90, 'mg/dL', "observed_at" FROM "observation_result" WHERE "id" = ${BigInt(resultId)}`,
    ).rejects.toThrow(/ORD-124|observation_result_not_on_cancelled_line/);
    // Control positivo: la misma fila, bajo la línea viva, entra.
    await expect(
      prisma.$executeRaw`INSERT INTO "observation_result" ("report_id", "order_item_id", "analyte_display", "value_numeric", "unit", "observed_at")
        SELECT "report_id", ${bh.id}::uuid, 'Hemoglobina', 13.1, 'g/dL', "observed_at" FROM "observation_result" WHERE "id" = ${BigInt(resultId)}`,
    ).resolves.toBe(1);
  });

  it('ORD-008 la base no deja anular una línea completada; una pendiente, sí (control positivo)', async () => {
    const prisma = db();
    const { bh, glucose } = await aTwoLineOrder(prisma);
    const userId = (await createUser(prisma)).id;
    await prisma.serviceOrderItem.update({ where: { id: bh.id }, data: { status: 'COMPLETED', completedAt: new Date() } }); // prettier-ignore

    await expect(
      prisma.serviceOrderItem.update({ where: { id: bh.id }, data: { status: 'CANCELLED', cancelledById: userId } }), // prettier-ignore
    ).rejects.toThrow(/ORD-008|service_order_item_completed_is_not_cancelled/);
    await prisma.serviceOrderItem.update({
      where: { id: glucose.id },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
        cancelledById: userId,
      },
    });
  });

  it('ORD-124 una anulación confirmada mientras el informe espera hace que el informe se rechace entero', async () => {
    const prisma = db();
    const { scene, order, glucose } = await aTwoLineOrder(prisma);
    const { reports } = serviceOf(prisma);
    const userId = (await createUser(prisma)).id;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => (signalLocked = resolve));

    // Otra sesión anula la glucosa y retiene el bloqueo.
    const cancelling = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE "service_order_item" SET "status" = 'CANCELLED', "completed_at" = clock_timestamp(), "cancelled_by_id" = ${userId}::uuid WHERE "id" = ${glucose.id}::uuid`;
        signalLocked();
        await held;
      },
      { timeout: 20_000 },
    );
    // El informe sale solo cuando la anulación ya tiene la fila.
    await locked;
    const now = new Date();
    const registering = reports
      .register(
        {
          orderId: order.id,
          performedById: null,
          issuedAt: new Date(now.getTime() - 60 * 60 * 1000),
          results: [
            { analyteDefinitionId: scene.hb.id, valueNumeric: 13.4 },
            { analyteDefinitionId: scene.glu.id, valueNumeric: 92 },
          ],
        },
        requester,
        now,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    await untilSomeoneWaits(prisma);
    release();
    await cancelling;

    expect(await registering).toBeInstanceOf(OrderItemNotPendingError);
    expect(await prisma.diagnosticReport.count({ where: { serviceOrderId: order.id } })).toBe(0); // prettier-ignore
  });

  it('ORD-008 una anulación que espera a que el informe complete la línea se rechaza, y la línea sigue completada', async () => {
    const prisma = db();
    const { order, bh } = await aTwoLineOrder(prisma);
    const { orders } = serviceOf(prisma);
    const userId = (await createUser(prisma)).id;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => (signalLocked = resolve));

    // El informe completa la biometría y retiene el bloqueo.
    const completing = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "service_order_item" WHERE "id" = ${bh.id}::uuid FOR UPDATE`;
        await tx.$executeRaw`UPDATE "service_order_item" SET "status" = 'COMPLETED', "completed_at" = clock_timestamp() WHERE "id" = ${bh.id}::uuid`;
        signalLocked();
        await held;
      },
      { timeout: 20_000 },
    );
    // La anulación sale solo cuando el informe ya tiene la fila completada.
    await locked;
    const cancelling = orders
      .cancelItem({
        orderId: order.id,
        itemId: bh.id,
        sites: 'all',
        cancelledById: userId,
      }) // prettier-ignore
      .then(
        () => null,
        (error: unknown) => error,
      );
    await untilSomeoneWaits(prisma);
    release();
    await completing;

    expect(await cancelling).toBeInstanceOf(OrderItemNotPendingError);
    const stored = await prisma.serviceOrderItem.findUniqueOrThrow({ where: { id: bh.id }, select: { status: true } }); // prettier-ignore
    expect(stored.status).toBe('COMPLETED');
  });
});
