import { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AccessAuditEntry,
  AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import { GLUCOSE, HAEMOGLOBIN, NITRITES } from '../domain/analyte.fixtures';
import { DiagnosticReportService } from './diagnostic-report.service';
import type { SubmittedResult } from './diagnostic-report.service';
import type { Requester } from './service-order.service';
import type { AnalyteDefinition } from '../domain/analyte';
import type {
  DiagnosticReportRepository,
  CriticalNoticeView,
  CriticalQueueRow,
  DiagnosticReportView,
  SafetyPolicy,
  ExpectedAnalytes,
  FlaggedResultEntry,
  MatchResultCommand,
  MatchableResult,
  NewReport,
  OrderPatient,
  ReportQuery,
  ResultQuery,
} from '../domain/diagnostic-report.repository';
import type {
  ExamCatalogueRepository,
  ExamDefinitionView,
} from '../domain/exam-catalogue.repository';
import type {
  ServiceOrderRepository,
  ServiceOrderView,
} from '../domain/service-order.repository';

/**
 * The result's use cases, against in-memory ports.
 *
 * WHAT A DOUBLE CAN PROVE: the order of the refusals, that the flag is refused
 * rather than dropped, that a value nobody asked for is STORED with no line
 * instead of discarded, that the status is derived and not typed, and that a
 * correction is a new report and never an edit.
 *
 * ⚠️ NOT HERE: the `UNIQUE` on `supersedes_id`, the trigger that keeps
 * `pending_items` in step, and the frozen row surviving the correction. Those
 * are PostgreSQL's, and they live in
 * `test/integration/orders-results.spec.ts`.
 */

const SITE = 'site-1';
const ORDER = 'order-1';
const ITEM_BH = 'item-bh';
const ORPHAN = '918273645';

const requester: Requester = {
  userId: 'user-1',
  sites: [SITE],
  ip: '10.0.0.9',
  userAgent: 'vitest',
};

const patient: OrderPatient = {
  patientId: 'chart-1',
  siteId: SITE,
  sex: 'FEMALE',
  ageDays: 12_000,
};

const examBh: ExamDefinitionView = {
  id: 'exam-bh',
  code: 'EX-BH',
  name: 'Biometría hemática completa',
  form010Section: 'HEMATOLOGÍA',
  specimenType: 'Sangre total con EDTA',
  patientPreparation: null,
  turnaroundHours: 4,
  tariffCode: null,
  performedExternally: true,
  externalLabName: null,
  analytes: [
    { analyte: HAEMOGLOBIN, position: 1, isReflex: false },
    { analyte: NITRITES, position: 2, isReflex: true },
  ],
};

const anOrder = (): ServiceOrderView => ({
  id: ORDER,
  encounterId: 'encounter-1',
  siteId: SITE,
  patientId: 'chart-1',
  orderedById: 'practitioner-1',
  number: 1,
  category: 'LABORATORY',
  priority: 'ROUTINE',
  clinicalNoteText: null,
  pendingItems: 1,
  requestedAt: new Date('2026-09-15T13:00:00Z'),
  items: [
    {
      id: ITEM_BH,
      testCode: 'EX-BH',
      testDisplay: 'Biometría hemática completa',
      conceptId: 'concept-1',
      status: 'REQUESTED',
      completedAt: null,
      createdAt: new Date('2026-09-15T13:00:00Z'),
    },
  ],
});

class FakeOrders implements Partial<ServiceOrderRepository> {
  byId(query: { orderId: string }): Promise<ServiceOrderView | undefined> {
    return Promise.resolve(query.orderId === ORDER ? anOrder() : undefined);
  }
}

class FakeCatalogue implements Partial<ExamCatalogueRepository> {
  known: AnalyteDefinition[] = [HAEMOGLOBIN, GLUCOSE, NITRITES];

  byCodes(codes: readonly string[]): Promise<ExamDefinitionView[]> {
    return Promise.resolve(codes.includes('EX-BH') ? [examBh] : []);
  }
  analytesByIds(ids: readonly string[]): Promise<AnalyteDefinition[]> {
    return Promise.resolve(this.known.filter((a) => ids.includes(a.id)));
  }
}

class FakeReports implements Partial<DiagnosticReportRepository> {
  written: { report: NewReport; expected: readonly ExpectedAnalytes[] }[] = [];
  existing = new Map<string, DiagnosticReportView>();

  register(
    report: NewReport,
    expected: readonly ExpectedAnalytes[],
  ): Promise<DiagnosticReportView> {
    this.written.push({ report, expected });
    return Promise.resolve(
      aReport({
        id: `report-${this.written.length}`,
        status: report.status,
        supersedesId: report.supersedesId ?? null,
      }),
    );
  }
  byId(query: ReportQuery): Promise<DiagnosticReportView | undefined> {
    return Promise.resolve(this.existing.get(query.reportId));
  }
  ofOrder(): Promise<DiagnosticReportView[]> {
    return Promise.resolve([...this.existing.values()]);
  }
  patientOfOrder(orderId: string): Promise<OrderPatient | undefined> {
    return Promise.resolve(orderId === ORDER ? patient : undefined);
  }
  unmatched(): Promise<FlaggedResultEntry[]> {
    return Promise.resolve([]);
  }
  critical(): Promise<CriticalQueueRow[]> {
    return Promise.resolve([]);
  }
  sitesInHours(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set<string>());
  }

  /** ORD-043. The orphan result the queue is showing, or nothing. */
  orphan: MatchableResult | undefined = {
    resultId: ORPHAN,
    reportId: 'report-0',
    orderId: ORDER,
    orderItemId: null,
    abnormalFlag: null,
    observedAt: new Date(0),
    siteId: SITE,
    superseded: false,
  };
  matched: { command: MatchResultCommand; expected: ExpectedAnalytes }[] = [];

  resultById(query: ResultQuery): Promise<MatchableResult | undefined> {
    return Promise.resolve(
      query.resultId === this.orphan?.resultId ? this.orphan : undefined,
    );
  }
  match(
    command: MatchResultCommand,
    expected: ExpectedAnalytes,
  ): Promise<DiagnosticReportView> {
    this.matched.push({ command, expected });
    return Promise.resolve(aReport({ id: 'report-0' }));
  }
  recordNotice(): Promise<CriticalNoticeView> {
    return Promise.reject(new Error('not exercised here'));
  }
  safetyPolicies(): Promise<ReadonlyMap<string, SafetyPolicy>> {
    return Promise.resolve(new Map<string, SafetyPolicy>());
  }
}

const aReport = (
  overrides: Partial<DiagnosticReportView> & { id?: string } = {},
): DiagnosticReportView => ({
  id: overrides.id ?? 'report-0',
  serviceOrderId: ORDER,
  status: overrides.status ?? 'FINAL',
  performedById: null,
  conclusion: null,
  issuedAt: new Date('2026-09-16T13:00:00Z'),
  supersedesId: overrides.supersedesId ?? null,
  supersededById: overrides.supersededById ?? null,
  supersededAt: overrides.supersededAt ?? null,
  results: [],
});

describe('el registro y la corrección de un resultado', () => {
  let reports: FakeReports;
  let orders: FakeOrders;
  let catalogue: FakeCatalogue;
  let audit: AccessAuditRecorder & { entries: AccessAuditEntry[] };
  let service: DiagnosticReportService;

  beforeEach(() => {
    reports = new FakeReports();
    orders = new FakeOrders();
    catalogue = new FakeCatalogue();
    const entries: AccessAuditEntry[] = [];
    audit = {
      entries,
      record: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    };
    const logger = {
      setContext: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as PinoLogger;

    service = new DiagnosticReportService(
      reports,
      orders as unknown as ServiceOrderRepository,
      catalogue as unknown as ExamCatalogueRepository,
      audit,
      logger,
    );
  });

  const aRequest = (results: SubmittedResult[]) => ({
    orderId: ORDER,
    performedById: null,
    issuedAt: new Date('2026-09-16T13:00:00Z'),
    results,
  });

  it('ORD-035 rechaza la bandera enviada por el laboratorio en vez de ignorarla', async () => {
    // Descartarla en silencio dejaría a quien la tecleó creyendo que su marca
    // es la del expediente, y aquí esa marca decide si alguien llama esta noche.
    await expect(
      service.register(
        aRequest([
          { analyteDefinitionId: HAEMOGLOBIN.id, valueNumeric: 9, abnormalFlag: 'LOW' }, // prettier-ignore
        ]),
        requester,
      ),
    ).rejects.toMatchObject({ code: 'RESULT_FLAG_IS_DERIVED' });

    expect(reports.written).toEqual([]);
  });

  it('ORD-035 la rechaza ANTES de mirar si la orden existe', async () => {
    // Contestar `ORDER_NOT_FOUND` porque el id estaba viejo mandaría a quien
    // llama a perseguir el problema equivocado.
    await expect(
      service.register(
        { ...aRequest([{ analyteDefinitionId: HAEMOGLOBIN.id, valueNumeric: 9, abnormalFlag: 'LOW' }]), orderId: 'no-existe' }, // prettier-ignore
        requester,
      ),
    ).rejects.toMatchObject({ code: 'RESULT_FLAG_IS_DERIVED' });
  });

  it('ORD-035 y ORD-036 calculan la bandera con el sexo del paciente de la atención', async () => {
    await service.register(
      aRequest([{ analyteDefinitionId: HAEMOGLOBIN.id, valueNumeric: 12.5 }]),
      requester,
    );

    // 12,5 g/dL en una paciente: dentro de 12,0–15,5. En un paciente sería LOW.
    expect(reports.written[0]?.report.results[0]).toMatchObject({
      analyteDisplay: 'Hemoglobina',
      unit: 'g/dL',
      referenceLow: 12,
      referenceHigh: 15.5,
      abnormalFlag: 'NORMAL',
      orderItemId: ITEM_BH,
    });
  });

  it('ORD-040 guarda sin línea el valor que nadie pidió, y no lo descarta', async () => {
    // Un valor que llegó de más suele ser un panel que el laboratorio amplió y
    // a veces es el informe de otro paciente. Adivinar entre esas dos archiva
    // el resultado de un extraño en una ficha.
    await service.register(
      aRequest([
        { analyteDefinitionId: HAEMOGLOBIN.id, valueNumeric: 13 },
        { analyteDefinitionId: GLUCOSE.id, valueNumeric: 92 },
      ]),
      requester,
    );

    const written = reports.written[0]?.report.results ?? [];
    expect(written).toHaveLength(2);
    expect(written[1]).toMatchObject({
      analyteDisplay: 'Glucosa en ayunas',
      orderItemId: null,
    });
  });

  it('ORD-030 y ORD-039 derivan el estado del informe sin que nadie lo teclee', async () => {
    // La biometría de la siembra promete hemoglobina y un analito REFLEJO. Con
    // la hemoglobina basta: contar el reflejo dejaría la línea pendiente para
    // siempre.
    await service.register(
      aRequest([{ analyteDefinitionId: HAEMOGLOBIN.id, valueNumeric: 13 }]),
      requester,
    );

    expect(reports.written[0]?.report.status).toBe('FINAL');
    expect(reports.written[0]?.expected).toEqual([
      {
        orderItemId: ITEM_BH,
        analytes: [
          { analyteDisplay: 'Hemoglobina', isReflex: false },
          { analyteDisplay: 'Nitritos', isReflex: true },
        ],
      },
    ]);
  });

  it('ORD-030 deja el informe parcial mientras falta una determinación', async () => {
    // Un examen que promete dos determinaciones no reflejas y sólo recibe una.
    catalogue.byCodes = () =>
      Promise.resolve([
        {
          ...examBh,
          analytes: [
            { analyte: HAEMOGLOBIN, position: 1, isReflex: false },
            { analyte: GLUCOSE, position: 2, isReflex: false },
          ],
        },
      ]);

    await service.register(
      aRequest([{ analyteDefinitionId: HAEMOGLOBIN.id, valueNumeric: 13 }]),
      requester,
    );

    expect(reports.written[0]?.report.status).toBe('PARTIAL');
  });

  it('ORD-042 rechaza el informe ENTERO cuando una determinación no está catalogada', async () => {
    await expect(
      service.register(
        aRequest([
          { analyteDefinitionId: HAEMOGLOBIN.id, valueNumeric: 13 },
          { analyteDefinitionId: 'analito-inventado', valueNumeric: 1 },
        ]),
        requester,
      ),
    ).rejects.toMatchObject({ code: 'RESULT_ANALYTE_UNKNOWN' });

    expect(reports.written).toEqual([]);
  });

  it('ORD-050 corrige emitiendo un informe NUEVO que sustituye al anterior', async () => {
    reports.existing.set('report-0', aReport());

    await service.correct(
      {
        reportId: 'report-0',
        performedById: null,
        issuedAt: new Date('2026-09-18T13:00:00Z'),
        results: [{ analyteDefinitionId: HAEMOGLOBIN.id, valueNumeric: 9.1 }],
      },
      requester,
    );

    // Ninguna escritura sobre el informe anterior: sólo una nueva que lo nombra.
    expect(reports.written[0]?.report).toMatchObject({
      status: 'CORRECTED',
      supersedesId: 'report-0',
      serviceOrderId: ORDER,
    });
    expect(reports.written[0]?.report.results[0]?.abnormalFlag).toBe('LOW');
  });

  it('ORD-052 rechaza una segunda corrección del mismo informe', async () => {
    // Una cadena que se bifurca no tiene «versión vigente», y dos médicos
    // verían dos resultados finales del mismo tubo.
    reports.existing.set(
      'report-0',
      aReport({ supersededById: 'report-1', supersededAt: new Date() }),
    );

    await expect(
      service.correct(
        { reportId: 'report-0', performedById: null, issuedAt: new Date(), results: [{ analyteDefinitionId: HAEMOGLOBIN.id, valueNumeric: 9.1 }] }, // prettier-ignore
        requester,
      ),
    ).rejects.toMatchObject({ code: 'REPORT_ALREADY_CORRECTED' });
  });

  it('ORD-053 rechaza corregir un informe parcial: se completa, no se corrige', async () => {
    reports.existing.set('report-0', aReport({ status: 'PARTIAL' }));

    await expect(
      service.correct(
        { reportId: 'report-0', performedById: null, issuedAt: new Date(), results: [{ analyteDefinitionId: HAEMOGLOBIN.id, valueNumeric: 9.1 }] }, // prettier-ignore
        requester,
      ),
    ).rejects.toMatchObject({ code: 'REPORT_NOT_CORRECTABLE' });
  });

  it('ORD-051 responde que el informe no existe cuando está fuera del alcance', async () => {
    await expect(
      service.correct(
        { reportId: 'ajeno', performedById: null, issuedAt: new Date(), results: [] }, // prettier-ignore
        requester,
      ),
    ).rejects.toMatchObject({ code: 'REPORT_NOT_FOUND' });
  });

  it('ORD-091 deja fila de bitácora al leer los informes de una orden', async () => {
    await service.ofOrder(ORDER, requester);

    expect(audit.entries).toEqual([
      expect.objectContaining({
        resourceType: 'diagnostic_report',
        resourceId: ORDER,
        action: 'READ',
        userId: 'user-1',
      }),
    ]);
  });

  it('ORD-043 empareja un resultado huérfano con una línea de SU orden', async () => {
    // La salida que la cola no tenía. Nada adivina aquí: lo decide una persona,
    // y ORD-041 sigue prohibiendo el emparejamiento automático.
    await service.match({ resultId: ORPHAN, orderItemId: ITEM_BH }, requester);

    expect(reports.matched).toHaveLength(1);
    expect(reports.matched[0]?.command).toMatchObject({
      resultId: ORPHAN,
      // La orden viaja aunque el resultado ya la sepa: es lo que permite al
      // adaptador condicionar la escritura dentro de su transacción.
      orderId: ORDER,
      orderItemId: ITEM_BH,
    });
    // ORD-039. Lo que la línea promete se resuelve del catálogo AQUÍ, con la
    // misma regla que el registro: una línea cerrada por un emparejamiento y
    // otra cerrada por un informe no pueden discrepar sobre qué es «completa».
    expect(reports.matched[0]?.expected).toEqual({
      orderItemId: ITEM_BH,
      analytes: [
        { analyteDisplay: HAEMOGLOBIN.name, isReflex: false },
        { analyteDisplay: NITRITES.name, isReflex: true },
      ],
    });
  });

  it('ORD-043 rechaza emparejar un resultado que ya responde a una línea', async () => {
    // Dos personas trabajando la misma cola es lo normal. A la que pierde hay
    // que decírselo, no dejarla volver a apuntar una fila ya resuelta.
    reports.orphan = {
      resultId: ORPHAN,
      reportId: 'report-0',
      orderId: ORDER,
      orderItemId: ITEM_BH,
      abnormalFlag: null,
      observedAt: new Date(0),
      siteId: SITE,
      superseded: false,
    };

    await expect(
      service.match({ resultId: ORPHAN, orderItemId: ITEM_BH }, requester),
    ).rejects.toMatchObject({ code: 'RESULT_ALREADY_MATCHED' });
    expect(reports.matched).toEqual([]);
  });

  it('ORD-043 rechaza emparejar con una línea que no es de esa orden', async () => {
    // Emparejar contra la línea de OTRA orden cerraría una línea con la sangre
    // de otra persona, y no hay `CHECK` que lo impida: esta negativa es toda la
    // garantía.
    await expect(
      service.match({ resultId: ORPHAN, orderItemId: 'item-de-otra' }, requester), // prettier-ignore
    ).rejects.toMatchObject({ code: 'ORDER_ITEM_NOT_MATCHABLE' });
    expect(reports.matched).toEqual([]);
  });

  it('ORD-043 responde lo mismo por un resultado inexistente que por uno de otra sede', async () => {
    reports.orphan = undefined;

    await expect(
      service.match({ resultId: ORPHAN, orderItemId: ITEM_BH }, requester),
    ).rejects.toMatchObject({ code: 'RESULT_NOT_FOUND' });
  });

  it('ORD-091 deja fila de bitácora al emparejar, y es un UPDATE', async () => {
    // No se escribió ningún informe: una fila que ya existía responde ahora a
    // una línea. El recurso es el INFORME, que es lo que se puede abrir.
    await service.match({ resultId: ORPHAN, orderItemId: ITEM_BH }, requester);

    expect(audit.entries).toEqual([
      expect.objectContaining({
        resourceType: 'diagnostic_report',
        action: 'UPDATE',
        userId: 'user-1',
      }),
    ]);
  });

  it('ORD-092 no deja fila de bitácora por cada entrada de las dos colas', async () => {
    // Una lista que se refresca en una pantalla abierta produciría miles de
    // filas al día y enterraría las que importan. Misma decisión que EN-123.
    await service.unmatched(requester, 50, new Date());
    await service.critical(requester, 50, new Date());

    expect(audit.entries).toEqual([]);
  });
});
