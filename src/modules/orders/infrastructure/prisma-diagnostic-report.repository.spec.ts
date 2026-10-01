import { describe, expect, it } from 'vitest';

import { PrismaDiagnosticReportRepository } from './prisma-diagnostic-report.repository';
import type { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { NewReport } from '../domain/diagnostic-report.repository';

/**
 * The report's write transaction, against a double of the Prisma client.
 *
 * NOT the guarantees: the `UNIQUE` on `supersedes_id`, the trigger that keeps
 * `pending_items` in step and the old row surviving a correction are exercised
 * against a real PostgreSQL in `test/integration/orders-results.spec.ts`.
 *
 * What IS this adapter's own decision:
 *
 *  - that the order's scope is re-checked INSIDE the transaction;
 *  - that `analyte_concept_id` is written `null` rather than pointing at a
 *    catalogue that does not contain analytes (the schema gap of ORD-031);
 *  - that a line is closed only when EVERYTHING the order received covers it,
 *    and that closing it is idempotent;
 *  - and that NOTHING here computes a flag: it writes the one the domain
 *    resolved.
 */

const ORDER = '00000000-0000-4000-8000-00000000000a';
const ITEM = '00000000-0000-4000-8000-00000000000b';

interface Call {
  method: string;
  args: unknown;
}

const aReportRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'report-1',
  serviceOrderId: ORDER,
  status: 'FINAL',
  performedById: null,
  conclusion: null,
  issuedAt: new Date('2026-09-16T13:00:00Z'),
  supersedesId: null,
  supersededBy: null,
  results: [],
  ...overrides,
});

function prismaDouble(
  options: {
    order?: { id: string } | null;
    reported?: { analyteDisplay: string }[];
    report?: Record<string, unknown>;
    orderRow?: Record<string, unknown> | null;
    worklist?: Record<string, unknown>[];
  } = {},
) {
  const calls: Call[] = [];
  const record = (method: string, args: unknown) =>
    calls.push({ method, args });

  const tx = {
    serviceOrder: {
      findFirst: (args: unknown) => {
        record('serviceOrder.findFirst', args);
        return Promise.resolve(
          options.order === undefined ? { id: ORDER } : options.order,
        );
      },
    },
    diagnosticReport: {
      create: (args: unknown) => {
        record('diagnosticReport.create', args);
        return Promise.resolve({ id: 'report-1' });
      },
      findFirstOrThrow: (args: unknown) => {
        record('diagnosticReport.findFirstOrThrow', args);
        return Promise.resolve(aReportRow(options.report));
      },
    },
    observationResult: {
      findMany: (args: unknown) => {
        record('observationResult.findMany', args);
        return Promise.resolve(options.reported ?? []);
      },
    },
    serviceOrderItem: {
      updateMany: (args: unknown) => {
        record('serviceOrderItem.updateMany', args);
        return Promise.resolve({ count: 1 });
      },
    },
  };

  const prisma = {
    $transaction: <T>(fn: (client: unknown) => Promise<T>) => fn(tx),
    diagnosticReport: {
      findFirst: (args: unknown) => {
        record('diagnosticReport.findFirst', args);
        return Promise.resolve(aReportRow(options.report));
      },
      findMany: (args: unknown) => {
        record('diagnosticReport.findMany', args);
        return Promise.resolve([aReportRow(options.report)]);
      },
    },
    serviceOrder: {
      findFirst: (args: unknown) => {
        record('serviceOrder.findFirst(outer)', args);
        return Promise.resolve(
          options.orderRow === undefined
            ? {
                siteId: 'site-1',
                encounter: {
                  patientId: 'chart-1',
                  ageDays: 12_000,
                  patient: { sex: 'FEMALE' },
                },
              }
            : options.orderRow,
        );
      },
    },
    observationResult: {
      findMany: (args: unknown) => {
        record('observationResult.findMany(outer)', args);
        return Promise.resolve(options.worklist ?? []);
      },
    },
  };

  return {
    calls,
    repository: new PrismaDiagnosticReportRepository(
      prisma as unknown as PrismaService,
    ),
    callTo: (method: string) => calls.find((call) => call.method === method),
  };
}

const aReport = (overrides: Partial<NewReport> = {}): NewReport => ({
  serviceOrderId: ORDER,
  status: 'FINAL',
  performedById: null,
  issuedAt: new Date('2026-09-16T13:00:00Z'),
  sites: 'all',
  results: [
    {
      analyteId: 'analyte-1',
      analyteDisplay: 'Hemoglobina',
      valueNumeric: 13.4,
      valueCode: null,
      valueText: null,
      unit: 'g/dL',
      referenceLow: 12,
      referenceHigh: 15.5,
      referenceText: null,
      abnormalFlag: 'NORMAL',
      orderItemId: ITEM,
    },
  ],
  ...overrides,
});

const promises = [
  { orderItemId: ITEM, analytes: [{ analyteDisplay: 'Hemoglobina', isReflex: false }] }, // prettier-ignore
];

describe('el adaptador del informe', () => {
  it('ORD-090 vuelve a comprobar el alcance de la orden dentro de la transacción', async () => {
    const { repository } = prismaDouble({ order: null });

    await expect(
      repository.register(aReport(), promises),
    ).rejects.toMatchObject({
      // prettier-ignore
      code: 'ORDER_NOT_FOUND',
    });
  });

  it('ORD-031 escribe la determinación con su texto congelado y sin concepto inventado', async () => {
    // `observation_result` no tiene `analyte_definition_id`, y su único puntero
    // apunta a un catálogo que no contiene analitos: poner un id ahí sería una
    // referencia falsa. La nota está en ORD-031.
    const { repository, callTo } = prismaDouble();

    await repository.register(aReport(), promises);

    const data = (callTo('diagnosticReport.create')?.args as { data: Record<string, unknown> }).data; // prettier-ignore
    const rows = (data.results as { create: Record<string, unknown>[] }).create;
    expect(rows[0]).toMatchObject({
      analyteConceptId: null,
      analyteDisplay: 'Hemoglobina',
      unit: 'g/dL',
      abnormalFlag: 'NORMAL',
      orderItemId: ITEM,
    });
  });

  it('ORD-039 cierra la línea sólo cuando la orden ya recibió todo lo que promete', async () => {
    const complete = prismaDouble({ reported: [{ analyteDisplay: 'Hemoglobina' }] }); // prettier-ignore
    await complete.repository.register(aReport(), promises);

    const update = complete.callTo('serviceOrderItem.updateMany')?.args as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(update.data).toMatchObject({ status: 'COMPLETED' });
    expect(update.data.completedAt).toBeInstanceOf(Date);
    // Idempotente: un segundo informe sobre una línea ya cerrada no puede
    // mover el instante en que se respondió.
    expect(update.where).toMatchObject({ id: ITEM, completedAt: null });

    const partial = prismaDouble({ reported: [] });
    await partial.repository.register(aReport(), promises);
    expect(partial.callTo('serviceOrderItem.updateMany')).toBeUndefined();
  });

  it('ORD-051 dice cuándo y por cuál informe fue corregido el que se lee', async () => {
    const { repository } = prismaDouble({
      report: {
        supersededBy: {
          id: 'report-2',
          issuedAt: new Date('2026-09-18T13:00:00Z'),
          createdAt: new Date('2026-09-19T13:00:00Z'),
        },
      },
    });

    const report = await repository.byId({
      reportId: 'report-1',
      sites: 'all',
    });

    expect(report?.supersededById).toBe('report-2');
    expect(report?.supersededAt).toEqual(new Date('2026-09-18T13:00:00Z'));
  });

  it('ORD-051 cae en el instante de la fila cuando la corrección no declara emisión', async () => {
    // «Corregido el …» es una fecha que lee una persona: un blanco al lado de
    // un número sobre el que alguien pudo actuar no es una respuesta.
    const { repository } = prismaDouble({
      report: {
        supersededBy: {
          id: 'report-2',
          issuedAt: null,
          createdAt: new Date('2026-09-19T13:00:00Z'),
        },
      },
    });

    const report = await repository.byId({
      reportId: 'report-1',
      sites: 'all',
    });
    expect(report?.supersededAt).toEqual(new Date('2026-09-19T13:00:00Z'));
  });

  it('ORD-036 lee la edad de la ATENCIÓN y el sexo de la ficha', async () => {
    // `encounter.age_days` está congelado por disparador; derivar la edad de
    // `birth_date` al transcribir reclasificaría un resultado de hace dos años.
    const { repository } = prismaDouble();

    expect(await repository.patientOfOrder(ORDER, 'all')).toEqual({
      patientId: 'chart-1',
      siteId: 'site-1',
      sex: 'FEMALE',
      ageDays: 12_000,
    });

    const missing = prismaDouble({ orderRow: null });
    expect(await missing.repository.patientOfOrder(ORDER, 'all')).toBeUndefined(); // prettier-ignore
  });

  it('ORD-040 pide a la base exactamente los resultados sin línea, dentro del alcance', async () => {
    const { repository, callTo } = prismaDouble();

    await repository.unmatched({ sites: ['site-1'], limit: 25 });

    expect(callTo('observationResult.findMany(outer)')?.args).toMatchObject({
      where: {
        orderItemId: null,
        report: { serviceOrder: { siteId: { in: ['site-1'] } } },
      },
      take: 25,
    });
  });

  it('ORD-060 pide sólo las dos banderas críticas, y no lo que el laboratorio marcó', async () => {
    const { repository, callTo } = prismaDouble({
      worklist: [
        {
          id: 42n,
          reportId: 'report-1',
          analyteDisplay: 'Glucosa en ayunas',
          valueNumeric: null,
          valueCode: null,
          unit: 'mg/dL',
          abnormalFlag: 'CRITICAL_LOW',
          observedAt: new Date('2026-09-16T13:00:00Z'),
          report: {
            serviceOrderId: ORDER,
            serviceOrder: {
              siteId: 'site-1',
              encounter: { patientId: 'chart-1' },
              orderedBy: { id: 'pr-1', user: { firstName: 'Ana', lastName: 'Villacís' } }, // prettier-ignore
            },
          },
        },
      ],
    });

    const critical = await repository.critical({ sites: 'all', limit: 25 });

    expect(callTo('observationResult.findMany(outer)')?.args).toMatchObject({
      where: { abnormalFlag: { in: ['CRITICAL_LOW', 'CRITICAL_HIGH'] } },
    });
    // `observation_result.id` es `bigint`: sale como cadena para que ningún
    // cliente tenga que adivinar si su lector de JSON conservó los dígitos.
    expect(critical[0]?.resultId).toBe('42');
    expect(critical[0]?.patientId).toBe('chart-1');
  });

  it('ORD-051 lista los informes de una orden dentro del alcance', async () => {
    const { repository, callTo } = prismaDouble();

    const reports = await repository.ofOrder(ORDER, ['site-1']);

    expect(reports).toHaveLength(1);
    expect(callTo('diagnosticReport.findMany')?.args).toMatchObject({
      where: {
        serviceOrderId: ORDER,
        serviceOrder: { siteId: { in: ['site-1'] } },
      },
    });
  });
});
