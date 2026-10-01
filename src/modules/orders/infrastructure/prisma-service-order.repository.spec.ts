import { describe, expect, it } from 'vitest';

import { PrismaServiceOrderRepository } from './prisma-service-order.repository';
import type { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';

/**
 * The order's write transaction, against a double of the Prisma client.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A DOUBLE CAN HONESTLY PROVE HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NOT the guarantees. `trg_service_order_item_pending`, the partial index the
 * worklist is built on and the `daterange @>` of the catalogue are exercised
 * against a real PostgreSQL in `test/integration/orders-lifecycle.spec.ts`,
 * and a double returning what we asked it for would prove none of them.
 *
 * What IS this adapter's own decision, and what an integration failure would
 * report from three layers away:
 *
 *  - that the SITE comes from the attention and never from the request;
 *  - that the professional who signs comes from the attention too (ORD-001);
 *  - that the code and the name written on the line are READ FROM THE
 *    DEFINITION in this same transaction, never values a caller supplied;
 *  - that the validity of the tariff concept is asked in `America/Guayaquil`;
 *  - that cancelling writes BOTH the status and `completed_at`, which is what
 *    takes the row out of the worklist;
 *  - and that the cedula lookup filters out the charts a merge absorbed.
 */

const ENCOUNTER = '00000000-0000-4000-8000-00000000000a';
const CONCEPT = '00000000-0000-4000-8000-00000000000b';
const EXAM = '00000000-0000-4000-8000-00000000000c';
const SITE = '00000000-0000-4000-8000-000000000001';
const PRACTITIONER = '00000000-0000-4000-8000-000000000002';

interface Call {
  method: string;
  args: unknown;
}

const anOrderRow = (items: unknown[] = []) => ({
  id: 'order-1',
  encounterId: ENCOUNTER,
  siteId: SITE,
  orderedById: PRACTITIONER,
  category: 'LABORATORY',
  priority: 'ROUTINE',
  clinicalNoteText: null,
  pendingItems: items.length,
  requestedAt: new Date('2026-09-15T13:00:00Z'),
  encounter: { patientId: 'chart-1' },
  items,
});

const anItemRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'item-1',
  testCode: 'EX-BH',
  testDisplay: 'Biometría hemática completa',
  conceptId: CONCEPT,
  status: 'REQUESTED',
  completedAt: null,
  createdAt: new Date('2026-09-15T13:00:00Z'),
  ...overrides,
});

function prismaDouble(
  options: {
    encounter?: Record<string, unknown> | null;
    exams?: Record<string, unknown>[];
    concepts?: Record<string, unknown>[];
    item?: Record<string, unknown> | null;
    orders?: Record<string, unknown>[];
    definitions?: Record<string, unknown>[];
    identifier?: Record<string, unknown> | null;
  } = {},
) {
  const calls: Call[] = [];
  const record = (method: string, args: unknown) =>
    calls.push({ method, args });

  const tx = {
    encounter: {
      findFirst: (args: unknown) => {
        record('encounter.findFirst', args);
        return Promise.resolve(
          options.encounter === undefined
            ? { id: ENCOUNTER, siteId: SITE, status: 'OPEN', practitionerId: PRACTITIONER } // prettier-ignore
            : options.encounter,
        );
      },
    },
    examDefinition: {
      findMany: (args: unknown) => {
        record('examDefinition.findMany', args);
        return Promise.resolve(
          options.exams ?? [{ id: EXAM, code: 'EX-BH', name: 'Biometría hemática completa', tariffCode: 'T-100' }], // prettier-ignore
        );
      },
    },
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      // The lock on the attention's row is its own call (the race with agenda's
      // annulment); the tariff lookup is the one these tests read.
      record(sql.includes('FOR UPDATE') ? '$queryRaw:lock' : '$queryRaw', {
        sql,
        values,
      });
      return Promise.resolve(
        options.concepts ?? [
          { id: CONCEPT, concept_code: 'T-100', system_code: 'TARIFF', in_force: true }, // prettier-ignore
        ],
      );
    },
    serviceOrder: {
      create: (args: unknown) => {
        record('serviceOrder.create', args);
        const data = (args as { data: Record<string, unknown> }).data;
        const created = (data.items as { create: Record<string, unknown>[] }).create; // prettier-ignore
        return Promise.resolve(
          anOrderRow(created.map((item) => anItemRow(item))),
        );
      },
      findFirstOrThrow: (args: unknown) => {
        record('serviceOrder.findFirstOrThrow', args);
        return Promise.resolve(
          anOrderRow([anItemRow({ status: 'CANCELLED' })]),
        );
      },
      findFirst: (args: unknown) => {
        record('serviceOrder.findFirst', args);
        return Promise.resolve(anOrderRow([anItemRow()]));
      },
      findMany: (args: unknown) => {
        record('serviceOrder.findMany', args);
        return Promise.resolve(options.orders ?? [anOrderRow([anItemRow()])]);
      },
    },
    serviceOrderItem: {
      findFirst: (args: unknown) => {
        record('serviceOrderItem.findFirst', args);
        return Promise.resolve(
          options.item === undefined
            ? { id: 'item-1', status: 'REQUESTED' }
            : options.item,
        );
      },
      update: (args: unknown) => {
        record('serviceOrderItem.update', args);
        return Promise.resolve({});
      },
    },
  };

  const prisma = {
    ...tx,
    $transaction: <T>(fn: (client: unknown) => Promise<T>) => fn(tx),
    examDefinition: {
      findMany: (args: unknown) => {
        record('examDefinition.findMany(outer)', args);
        return Promise.resolve(
          options.definitions ?? [{ code: 'EX-BH', turnaroundHours: 4 }],
        );
      },
    },
    patientIdentifier: {
      findFirst: (args: unknown) => {
        record('patientIdentifier.findFirst', args);
        return Promise.resolve(
          options.identifier === undefined
            ? { patientId: 'chart-1' }
            : options.identifier,
        );
      },
    },
  };

  return {
    calls,
    repository: new PrismaServiceOrderRepository(
      prisma as unknown as PrismaService,
    ),
    callTo: (method: string) => calls.find((call) => call.method === method),
  };
}

const aRequest = {
  encounterId: ENCOUNTER,
  category: 'LABORATORY' as const,
  priority: 'ROUTINE' as const,
  lines: [{ examDefinitionId: EXAM }],
  sites: 'all' as const,
};

describe('el adaptador de la orden', () => {
  it('ORD-001 toma la sede y el profesional de la ATENCIÓN, no de la petición', async () => {
    const { repository, callTo } = prismaDouble();

    await repository.place(aRequest);

    const data = (callTo('serviceOrder.create')?.args as { data: Record<string, unknown> }).data; // prettier-ignore
    expect(data.siteId).toBe(SITE);
    expect(data.orderedById).toBe(PRACTITIONER);
  });

  it('ORD-002 congela el código y el nombre leídos de la definición', async () => {
    const { repository, callTo } = prismaDouble();

    await repository.place(aRequest);

    const data = (callTo('serviceOrder.create')?.args as { data: Record<string, unknown> }).data; // prettier-ignore
    const lines = (data.items as { create: Record<string, unknown>[] }).create;
    expect(lines[0]).toMatchObject({
      testCode: 'EX-BH',
      testDisplay: 'Biometría hemática completa',
      conceptId: CONCEPT,
    });
  });

  it('ORD-001 responde que la atención no existe cuando está fuera del alcance', async () => {
    const { repository } = prismaDouble({ encounter: null });

    await expect(repository.place(aRequest)).rejects.toMatchObject({
      code: 'ORDER_ENCOUNTER_NOT_FOUND',
    });
  });

  it('ORD-005 rechaza pedir en una atención que ya no admite contenido', async () => {
    const { repository } = prismaDouble({
      encounter: { id: ENCOUNTER, siteId: SITE, status: 'COMPLETED', practitionerId: PRACTITIONER }, // prettier-ignore
    });

    await expect(repository.place(aRequest)).rejects.toMatchObject({
      code: 'ORDER_ENCOUNTER_NOT_OPEN',
    });
  });

  it('ORD-003 vuelve a comprobar el catálogo DENTRO de la transacción', async () => {
    // El servicio ya rechazó un examen retirado, y esto no es ceremonia: una
    // edición del catálogo puede aterrizar entre las dos, y la fila que se
    // escribe es la que importa.
    const { repository, callTo } = prismaDouble({ exams: [] });

    await expect(repository.place(aRequest)).rejects.toMatchObject({
      code: 'EXAM_NOT_ORDERABLE',
    });
    expect((callTo('examDefinition.findMany')?.args as { where: { active: boolean } }).where.active).toBe(true); // prettier-ignore
    expect(callTo('serviceOrder.create')).toBeUndefined();
  });

  it('ORD-004 rechaza igual el examen sin prestación y la prestación ausente del tarifario', async () => {
    // Distinguirlos convertiría el endpoint en un oráculo del catálogo entero.
    const absent = prismaDouble({ concepts: [] });
    await expect(absent.repository.place(aRequest)).rejects.toMatchObject({
      code: 'CATALOG_CONCEPT_NOT_FOUND',
    });

    const withoutTariff = prismaDouble({
      exams: [{ id: EXAM, code: 'EX-BH', name: 'Biometría hemática completa', tariffCode: null }], // prettier-ignore
    });
    await expect(
      withoutTariff.repository.place(aRequest),
    ).rejects.toMatchObject({
      code: 'CATALOG_CONCEPT_NOT_FOUND',
    });
  });

  it('ORD-005 bloquea la fila de la atención antes de leer su estado', async () => {
    const { repository, calls } = prismaDouble();

    await repository.place(aRequest);

    const methods = calls.map((call) => call.method);
    expect(methods.indexOf('$queryRaw:lock')).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf('$queryRaw:lock')).toBeLessThan(
      methods.indexOf('encounter.findFirst'),
    );
  });

  it('ORD-004 sólo busca la prestación en el TARIFARIO, nunca en otro catálogo', async () => {
    const { repository, callTo } = prismaDouble();

    await repository.place(aRequest);

    const query = callTo('$queryRaw')?.args as { values: unknown[] };
    expect(query.values).toContain('TARIFF');
  });

  it('ORD-004 la línea guarda la versión VIGENTE de la prestación, no la retirada', async () => {
    const { repository, callTo } = prismaDouble({
      concepts: [
        { id: 'concept-old', concept_code: 'T-100', system_code: 'TARIFF', in_force: false }, // prettier-ignore
        { id: CONCEPT, concept_code: 'T-100', system_code: 'TARIFF', in_force: true }, // prettier-ignore
      ],
    });

    await repository.place(aRequest);

    const data = (callTo('serviceOrder.create')?.args as { data: Record<string, unknown> }).data; // prettier-ignore
    const lines = (data.items as { create: Record<string, unknown>[] }).create;
    expect(lines[0]?.conceptId).toBe(CONCEPT);
  });

  it('ORD-004 rechaza el concepto que no estaba vigente en la fecha de la atención', async () => {
    const { repository } = prismaDouble({
      concepts: [{ id: CONCEPT, concept_code: 'T-100', system_code: 'TARIFF', in_force: false }], // prettier-ignore
    });

    await expect(repository.place(aRequest)).rejects.toMatchObject({
      code: 'CATALOG_CONCEPT_NOT_IN_FORCE',
    });
  });

  it('ORD-004 resuelve la vigencia en America/Guayaquil y no en el huso de la sesión', async () => {
    // Un `::date` desnudo sobre un `timestamptz` a las 21:00 cae al día
    // siguiente, y el último día de vigencia de un código dejaría de poder
    // usarse cinco horas antes de tiempo.
    const { repository, callTo } = prismaDouble();
    await repository.place(aRequest);

    const raw = callTo('$queryRaw')?.args as { sql: string; values: unknown[] };
    expect(raw.sql).toContain('AT TIME ZONE');
    expect(raw.values).toContain('America/Guayaquil');
  });

  it('ORD-009 sirve la orden con su ficha y sus líneas', async () => {
    const { repository } = prismaDouble();

    const order = await repository.byId({ orderId: 'order-1', sites: 'all' });

    expect(order).toMatchObject({ id: 'order-1', patientId: 'chart-1' });
    expect(order?.items[0]?.testCode).toBe('EX-BH');
  });

  it('ORD-090 estrecha por las sedes del alcance, y no filtra cuando es total', async () => {
    const scoped = prismaDouble();
    await scoped.repository.byId({ orderId: 'order-1', sites: [SITE] });
    expect(scoped.callTo('serviceOrder.findFirst')?.args).toMatchObject({
      where: { siteId: { in: [SITE] } },
    });

    const unrestricted = prismaDouble();
    await unrestricted.repository.ofEncounter(ENCOUNTER, 'all');
    const where = (unrestricted.callTo('serviceOrder.findMany')?.args as { where: Record<string, unknown> }).where; // prettier-ignore
    expect(where.siteId).toBeUndefined();
  });

  it('ORD-020 y ORD-022 aplanan la cola a una entrada por línea, con su plazo', async () => {
    const { repository } = prismaDouble();

    const worklist = await repository.pending({
      sites: 'all',
      now: new Date('2026-09-25T13:00:00Z'),
      limit: 50,
    });

    expect(worklist).toHaveLength(1);
    expect(worklist[0]).toMatchObject({
      orderId: 'order-1',
      itemId: 'item-1',
      patientId: 'chart-1',
      testCode: 'EX-BH',
    });
    expect(worklist[0]?.ageing.overdue).toBe(true);
    expect(worklist[0]?.ageing.waitingDays).toBe(10);
  });

  it('ORD-022 responde «no hay plazo» cuando el examen no tiene definición que lo prometa', async () => {
    // Un plazo por defecto diría «va bien» o «lleva retraso» de un examen del
    // que nadie prometió nada, y las dos cosas son mentira.
    const { repository } = prismaDouble({ definitions: [] });

    const worklist = await repository.pending({
      sites: 'all',
      now: new Date('2026-09-25T13:00:00Z'),
      limit: 50,
    });

    expect(worklist[0]?.ageing.overdue).toBeNull();
    expect(worklist[0]?.ageing.dueAt).toBeNull();
  });

  it('ORD-025 y ORD-093 llevan el filtro de examen a las dos mitades y la ficha por el alcance', async () => {
    const { repository, callTo } = prismaDouble();

    await repository.pending({
      sites: 'all',
      examCode: 'EX-BH',
      chartId: 'chart-1',
      now: new Date(),
      limit: 50,
    });

    const args = callTo('serviceOrder.findMany')?.args as {
      where: Record<string, unknown>;
      select: { items: { where: Record<string, unknown> } };
    };
    // El filtro va tanto al `some` que elige la orden como al `items` que se
    // trae: sin la segunda mitad, filtrar por examen devolvería la orden
    // entera y la cola enseñaría líneas que nadie pidió ver.
    expect(args.select.items.where).toMatchObject({ testCode: 'EX-BH' });
    // Y la ficha se resuelve por el enlace de la fusión, nunca por id desnudo.
    expect(args.where.encounter).toEqual({
      patient: { OR: [{ id: 'chart-1' }, { mergedIntoId: 'chart-1' }] },
    });
  });

  it('ORD-007 escribe el estado Y el instante que saca la línea de la cola', async () => {
    const { repository, callTo } = prismaDouble();

    await repository.cancelItem({ orderId: 'order-1', itemId: 'item-1', sites: 'all' }); // prettier-ignore

    const data = (callTo('serviceOrderItem.update')?.args as { data: Record<string, unknown> }).data; // prettier-ignore
    expect(data.status).toBe('CANCELLED');
    expect(data.completedAt).toBeInstanceOf(Date);
  });

  it('ORD-008 y ORD-009 distinguen la línea inexistente de la que ya no está pendiente', async () => {
    const missing = prismaDouble({ item: null });
    await expect(
      missing.repository.cancelItem({ orderId: 'order-1', itemId: 'x', sites: 'all' }), // prettier-ignore
    ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });

    const done = prismaDouble({ item: { id: 'item-1', status: 'COMPLETED' } });
    await expect(
      done.repository.cancelItem({ orderId: 'order-1', itemId: 'item-1', sites: 'all' }), // prettier-ignore
    ).rejects.toMatchObject({ code: 'ORDER_ITEM_NOT_PENDING' });
  });

  it('ORD-081 busca la cédula ECU oficial sólo en las fichas que ninguna fusión absorbió', async () => {
    const { repository, callTo } = prismaDouble();

    expect(await repository.chartByCedula('1710034065')).toBe('chart-1');
    expect(callTo('patientIdentifier.findFirst')?.args).toMatchObject({
      where: {
        type: 'CEDULA',
        issuingCountry: 'ECU',
        value: '1710034065',
        use: 'OFFICIAL',
        patientMerged: false,
      },
    });

    const none = prismaDouble({ identifier: null });
    expect(await none.repository.chartByCedula('1713175071')).toBeUndefined();
  });
});
