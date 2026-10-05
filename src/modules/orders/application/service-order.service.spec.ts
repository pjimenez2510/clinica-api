import { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GLUCOSE, HAEMOGLOBIN } from '../domain/analyte.fixtures';
import { ServiceOrderService } from './service-order.service';
import type { Requester } from './service-order.service';
import type { AnalyteDefinition } from '../domain/analyte';
import type {
  ExamCatalogueRepository,
  ExamDefinitionView,
} from '../domain/exam-catalogue.repository';
import type {
  DraftDiscard,
  DraftRewrite,
  NewServiceOrder,
  OrderQuery,
  PendingOrderEntry,
  PendingOrdersQuery,
  ServiceOrderRepository,
  ServiceOrderView,
} from '../domain/service-order.repository';

/**
 * The order's use cases, against in-memory ports.
 *
 * WHAT A DOUBLE CAN PROVE HERE is exactly what is NOT a database guarantee:
 * that a retired exam refuses the WHOLE order, that the cedula path refuses
 * instead of creating a chart, that the worklist ages against ONE instant, and
 * that nothing about the patient reaches a log line.
 *
 * ⚠️ WHAT IS DELIBERATELY NOT HERE: `pending_items` staying in step with the
 * lines, the partial index the worklist is built on, the frozen `test_code`
 * and the site scope. All four are PostgreSQL's, and a double returning what
 * we asked it for would prove none of them — they are exercised in
 * `test/integration/orders-lifecycle.spec.ts` against a real database.
 */

const SITE = 'site-1';
const ENCOUNTER = 'encounter-1';
const EXAM_BH = 'exam-bh';
const EXAM_GLU = 'exam-glu';
const EXAM_RX = 'exam-rx';
const CONCEPT = 'concept-1';

const requester: Requester = {
  userId: 'user-1',
  sites: [SITE],
  ip: '10.0.0.9',
  userAgent: 'vitest',
};

const anExam = (
  id: string,
  code: string,
  analytes: AnalyteDefinition[],
  category: ExamDefinitionView['category'] = 'LABORATORY',
): ExamDefinitionView => ({
  id,
  code,
  name: `Examen ${code}`,
  category,
  form010Section: 'HEMATOLOGÍA',
  specimenType: 'Sangre total con EDTA',
  patientPreparation: 'No requiere ayuno.',
  turnaroundHours: 4,
  tariffCode: null,
  performedExternally: true,
  externalLabName: null,
  analytes: analytes.map((analyte, index) => ({
    analyte,
    position: index + 1,
    isReflex: false,
  })),
});

class FakeCatalogue implements ExamCatalogueRepository {
  readonly exams = new Map<string, ExamDefinitionView>([
    [EXAM_BH, anExam(EXAM_BH, 'EX-BH', [HAEMOGLOBIN])],
    [EXAM_GLU, anExam(EXAM_GLU, 'EX-GLUCOSA-AYUNAS', [GLUCOSE])],
    [EXAM_RX, anExam(EXAM_RX, 'RX-TORAX', [], 'IMAGING')],
  ]);
  retired = new Set<string>();

  active(): Promise<ExamDefinitionView[]> {
    return Promise.resolve([...this.exams.values()]);
  }
  activeByIds(ids: readonly string[]): Promise<ExamDefinitionView[]> {
    return Promise.resolve(
      ids
        .filter((id) => !this.retired.has(id))
        .map((id) => this.exams.get(id))
        .filter((exam): exam is ExamDefinitionView => exam !== undefined),
    );
  }
  byCodes(codes: readonly string[]): Promise<ExamDefinitionView[]> {
    return Promise.resolve(
      [...this.exams.values()].filter((exam) => codes.includes(exam.code)),
    );
  }
  analytesByIds(ids: readonly string[]): Promise<AnalyteDefinition[]> {
    const all = [HAEMOGLOBIN, GLUCOSE];
    return Promise.resolve(all.filter((analyte) => ids.includes(analyte.id)));
  }
}

class FakeOrders implements ServiceOrderRepository {
  placed: NewServiceOrder[] = [];
  rewritten: DraftRewrite[] = [];
  issued: OrderQuery[] = [];
  discarded: DraftDiscard[] = [];
  pendingQueries: PendingOrdersQuery[] = [];
  charts = new Map<string, string>([['1710034065', 'chart-1']]);

  compose(order: NewServiceOrder): Promise<ServiceOrderView> {
    this.placed.push(order);
    return Promise.resolve(anOrder(order.lines.length));
  }
  rewrite(request: DraftRewrite): Promise<ServiceOrderView> {
    this.rewritten.push(request);
    return Promise.resolve(anOrder(request.lines.length));
  }
  issue(query: OrderQuery): Promise<ServiceOrderView> {
    this.issued.push(query);
    return Promise.resolve(anOrder(1));
  }
  discard(request: DraftDiscard): Promise<ServiceOrderView> {
    this.discarded.push(request);
    return Promise.resolve(anOrder(1));
  }
  byId(query: OrderQuery): Promise<ServiceOrderView | undefined> {
    return Promise.resolve(
      query.orderId === 'order-1' ? anOrder(1) : undefined,
    );
  }
  ofEncounter(): Promise<ServiceOrderView[]> {
    return Promise.resolve([anOrder(1)]);
  }
  pending(query: PendingOrdersQuery): Promise<PendingOrderEntry[]> {
    this.pendingQueries.push(query);
    return Promise.resolve([]);
  }
  cancelItem(): Promise<ServiceOrderView> {
    return Promise.resolve(anOrder(1));
  }
  chartByCedula(cedula: string): Promise<string | undefined> {
    return Promise.resolve(this.charts.get(cedula));
  }
}

const anOrder = (lines: number): ServiceOrderView => ({
  id: 'order-1',
  encounterId: ENCOUNTER,
  siteId: SITE,
  patientId: 'chart-1',
  orderedById: 'practitioner-1',
  orderedByUserId: 'user-1',
  number: 1,
  status: 'ISSUED',
  discardedAt: null,
  category: 'LABORATORY',
  priority: 'ROUTINE',
  clinicalNoteText: null,
  pendingItems: lines,
  requestedAt: new Date('2026-09-15T13:00:00Z'),
  items: Array.from({ length: lines }, (_unused, index) => ({
    id: `item-${index}`,
    testCode: 'EX-BH',
    testDisplay: 'Biometría hemática completa',
    conceptId: CONCEPT,
    status: 'REQUESTED' as const,
    completedAt: null,
    createdAt: new Date('2026-09-15T13:00:00Z'),
  })),
});

describe('la emisión y el seguimiento de una orden', () => {
  let orders: FakeOrders;
  let catalogue: FakeCatalogue;
  let logger: PinoLogger;
  let service: ServiceOrderService;

  beforeEach(() => {
    orders = new FakeOrders();
    catalogue = new FakeCatalogue();
    logger = {
      setContext: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as PinoLogger;
    service = new ServiceOrderService(orders, catalogue, logger, {
      record: () => Promise.resolve(),
    });
  });

  const twoLines = {
    encounterId: ENCOUNTER,
    category: 'LABORATORY' as const,
    priority: 'ROUTINE' as const,
    lines: [{ examDefinitionId: EXAM_BH }, { examDefinitionId: EXAM_GLU }],
  };

  it('ORD-002 emite una línea por examen pedido', async () => {
    const order = await service.compose(twoLines, requester);

    expect(order.items).toHaveLength(2);
    expect(orders.placed[0]?.lines).toHaveLength(2);
  });

  it('ORD-001 nunca deja que quien llama elija quién firma la orden', async () => {
    // El profesional lo pone la ATENCIÓN. Un id en la petición es una orden
    // que alguien puede archivar a nombre de un colega.
    await service.compose(twoLines, requester);

    expect(Object.keys(twoLines)).not.toContain('orderedById');
    expect(orders.placed[0]).not.toHaveProperty('orderedById');
  });

  it('ORD-003 rechaza la orden ENTERA cuando un examen ya no se puede pedir', async () => {
    // Un pedido de cinco exámenes que guarda cuatro es un pedido en el que
    // nadie se fija en cuál falta, y el que falta es el que nadie reclama.
    catalogue.retired.add(EXAM_GLU);

    await expect(service.compose(twoLines, requester)).rejects.toMatchObject({
      code: 'EXAM_NOT_ORDERABLE',
    });
    expect(orders.placed).toEqual([]);
  });

  it('ORD-024 no deja viajar el nombre del examen ni el paciente a la bitácora técnica', async () => {
    await service.compose(twoLines, requester);

    const calls = (logger.info as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    const [context] = calls[0] as [Record<string, unknown>, string];

    expect(context).toEqual({
      site_id: SITE,
      action: 'SERVICE_ORDER_COMPOSED',
      item_count: 2,
    });
  });

  it('ORD-097 rechaza la orden ENTERA si un examen no es del tipo de la orden', async () => {
    // Un hemograma pedido como imagen llega al servicio equivocado.
    await expect(
      service.compose({ ...twoLines, category: 'IMAGING' as const }, requester),
    ).rejects.toMatchObject({ code: 'EXAM_CATEGORY_MISMATCH' });
    expect(orders.placed).toEqual([]);
  });

  it('ORD-097 la corrección del borrador pasa por la misma comprobación de tipo', async () => {
    await expect(
      service.rewrite(
        {
          orderId: 'order-1',
          category: 'LABORATORY',
          priority: 'ROUTINE',
          lines: [{ examDefinitionId: EXAM_RX }],
        },
        requester,
      ),
    ).rejects.toMatchObject({ code: 'EXAM_CATEGORY_MISMATCH' });
    expect(orders.rewritten).toEqual([]);
  });

  it('ORD-096 corrige el borrador entero con el alcance de quien llama', async () => {
    await service.rewrite(
      {
        orderId: 'order-1',
        category: 'IMAGING',
        priority: 'URGENT',
        lines: [{ examDefinitionId: EXAM_RX }],
      },
      requester,
    );

    expect(orders.rewritten[0]).toMatchObject({
      orderId: 'order-1',
      category: 'IMAGING',
      sites: [SITE],
    });
  });

  it('ORD-098 emite con el alcance de quien llama y deja constancia sin nombrar el examen', async () => {
    await service.issue('order-1', requester);

    expect(orders.issued).toEqual([{ orderId: 'order-1', sites: [SITE] }]);
    const calls = (logger.info as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(calls[0]?.[0]).toEqual({
      site_id: SITE,
      action: 'SERVICE_ORDER_PLACED',
      item_count: 1,
    });
  });

  it('ORD-099 descarta dejando quién lo hizo, que es quien llama y no un id enviado', async () => {
    await service.discard('order-1', requester);

    expect(orders.discarded).toEqual([
      { orderId: 'order-1', sites: [SITE], userId: 'user-1' },
    ]);
  });

  it('D-123 un colega no corrige, emite ni descarta el borrador que firma otro profesional', async () => {
    const colleague = { ...requester, userId: 'user-2' };
    const rewrite = {
      orderId: 'order-1',
      category: 'LABORATORY' as const,
      priority: 'ROUTINE' as const,
      lines: [{ examDefinitionId: EXAM_BH }],
    };

    for (const attempt of [
      service.issue('order-1', colleague),
      service.discard('order-1', colleague),
      service.rewrite(rewrite, colleague),
    ]) {
      await expect(attempt).rejects.toMatchObject({
        code: 'ORDER_DRAFT_OF_ANOTHER_PRACTITIONER',
      });
    }
    expect(orders.issued).toEqual([]);
    expect(orders.discarded).toEqual([]);
    expect(orders.rewritten).toEqual([]);
  });

  it('ORD-009 responde que no existe cuando la orden está fuera del alcance', async () => {
    await expect(service.byId('otra', requester)).rejects.toMatchObject({
      code: 'ORDER_NOT_FOUND',
    });
  });

  it('ORD-081 concilia por cédula resolviendo primero la ficha', async () => {
    await service.pending({ cedula: '1710034065', limit: 50 }, requester, new Date()); // prettier-ignore

    expect(orders.pendingQueries[0]?.chartId).toBe('chart-1');
  });

  it('ORD-080 rechaza una cédula que ninguna ficha lleva, y no crea nada', async () => {
    // Se rechaza ANTES del listado: una lista vacía se leería como «ya llegó
    // todo», que es lo contrario de lo que pasa.
    await expect(
      service.pending(
        { cedula: '0102030405', limit: 50 },
        requester,
        new Date(),
      ),
    ).rejects.toMatchObject({ code: 'RESULT_CHART_UNMATCHED' });

    expect(orders.pendingQueries).toEqual([]);
    // La única operación del puerto sobre fichas es de lectura: no hay
    // contraparte que escriba, ni aquí ni en ningún sitio del módulo.
    expect(Object.getOwnPropertyNames(FakeOrders.prototype)).not.toContain(
      'createChart',
    );
  });

  it('ORD-021 envejece todo el listado contra UN solo instante', async () => {
    const now = new Date('2026-09-20T13:00:00Z');
    await service.pending({ limit: 50 }, requester, now);

    // Dos entradas envejecidas contra dos «now» distintos son una lista cuyo
    // orden cambia sin que nadie la toque.
    expect(orders.pendingQueries[0]?.now).toBe(now);
  });

  it('ORD-023 no filtra por canal: la cola se pide sólo con sede, categoría y examen', async () => {
    await service.pending({ limit: 50 }, requester, new Date());

    const query = orders.pendingQueries[0];
    expect(query).toBeDefined();
    expect(Object.keys(query ?? {}).sort()).toEqual([
      'category',
      'chartId',
      'examCode',
      // ORD-026: si la fila lleva el nombre, no por qué canal vuelve.
      'includePatientName',
      'limit',
      'now',
      'sites',
    ]);
  });

  it('ORD-007 anula la línea sin borrarla de la orden', async () => {
    const order = await service.cancelItem('order-1', 'item-0', requester);
    expect(order.items).toHaveLength(1);
  });
});
