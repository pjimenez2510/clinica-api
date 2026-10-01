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
import { createSite } from './setup/fixtures';

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

  const order = await orders.place({
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
    const hisOrder = await women.orders.place({
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
    const otherOrder = await orders.place({
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

    const order = await orders.place({
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

    const critical = await store.critical({ sites: 'all', limit: 50 });
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

    const order = await orders.place({
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
    expect(await store.critical({ sites: 'all', limit: 50 })).toHaveLength(1);

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
    expect(await store.critical({ sites: 'all', limit: 50 })).toEqual([]);
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
    expect(await store.critical({ sites: [otherSite.id], limit: 50 })).toEqual(
      [],
    );
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

    const order = await orders.place({
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
    const order = await orders.place({
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
});
