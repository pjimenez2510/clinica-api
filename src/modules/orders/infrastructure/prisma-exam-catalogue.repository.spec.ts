import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaExamCatalogueRepository } from './prisma-exam-catalogue.repository';
import type { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';

/**
 * The two catalogues, against a double of the Prisma client.
 *
 * What is this adapter's own decision: that a `jsonb` payload which is not a
 * list of strings becomes «no list» rather than an empty one, that a `Decimal`
 * bound becomes a number, and that an empty request never reaches the database
 * at all — `IN ()` is a statement with no answer and a round trip nobody needs.
 */

const analyteRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'analyte-1',
  code: 'HB',
  name: 'Hemoglobina',
  unit: 'g/dL',
  valueType: 'NUMERIC',
  decimals: 1,
  allowedValues: null,
  referenceRanges: [
    {
      rangeKind: 'REFERENCE',
      sex: 'FEMALE',
      ageMinDays: null,
      ageMaxDays: null,
      low: new Prisma.Decimal('12.0'),
      high: new Prisma.Decimal('15.5'),
      text: null,
    },
  ],
  ...overrides,
});

// BI-284. The orderable IS the service, with its order extension.
const examRow = (
  analyte: Record<string, unknown>,
  isReflex = false,
  overrides: Record<string, unknown> = {},
) => ({
  id: 'service-1',
  code: 'LAB-BH',
  name: 'Biometría hemática completa',
  kind: 'LAB_EXAM',
  mspCode: '360010',
  active: true,
  exam: {
    form010Section: 'HEMATOLOGÍA',
    specimenType: 'Sangre total con EDTA',
    patientPreparation: 'No requiere ayuno.',
    turnaroundHours: 4,
    requiresFasting: false,
    fastingHours: null,
    performedExternally: true,
    externalLabName: null,
    externalLabCode: null,
    analytes: [{ position: 1, isReflex, analyteDefinition: analyte }],
  },
  ...overrides,
});

function prismaDouble(
  analyte: Record<string, unknown> = analyteRow(),
  isReflex = false,
  serviceOverrides: Record<string, unknown> = {},
) {
  const calls: { method: string; args: unknown }[] = [];

  const prisma = {
    service: {
      findMany: (args: unknown) => {
        calls.push({ method: 'service.findMany', args });
        return Promise.resolve([examRow(analyte, isReflex, serviceOverrides)]);
      },
    },
    analyteDefinition: {
      findMany: (args: unknown) => {
        calls.push({ method: 'analyteDefinition.findMany', args });
        return Promise.resolve([analyte]);
      },
    },
  };

  return {
    calls,
    repository: new PrismaExamCatalogueRepository(
      prisma as unknown as PrismaService,
    ),
  };
}

describe('el adaptador del catálogo de exámenes', () => {
  it('ORD-011 sirve las determinaciones con su rango convertido a número', async () => {
    const { repository } = prismaDouble();

    const [exam] = await repository.active();

    expect(exam?.analytes[0]?.analyte.ranges[0]).toEqual({
      rangeKind: 'REFERENCE',
      sex: 'FEMALE',
      ageMinDays: null,
      ageMaxDays: null,
      low: 12,
      high: 15.5,
      text: null,
    });
    expect(exam?.analytes[0]?.position).toBe(1);
  });

  it('ORD-010 publica el servicio como ordenable: su id, su código, su nombre y la categoría de su tipo', async () => {
    const { repository, calls } = prismaDouble();

    const [exam] = await repository.active();

    expect(exam).toMatchObject({
      id: 'service-1',
      code: 'LAB-BH',
      name: 'Biometría hemática completa',
      category: 'LABORATORY',
      form010Section: 'HEMATOLOGÍA',
    });
    // Only services with an order extension, and only the active ones.
    expect(calls[0]?.args).toMatchObject({
      where: { exam: { isNot: null }, active: true },
    });
  });

  it('ORD-004 publica el código MSP del servicio, o nada si no lo tiene', async () => {
    const [withCode] = await prismaDouble().repository.active();
    const [without] = await prismaDouble(analyteRow(), false, {
      mspCode: null,
    }).repository.active();

    expect(withCode?.mspCode).toBe('360010');
    expect(without?.mspCode).toBeNull();
  });

  it('ORD-097 la categoría de un estudio de imagen o un procedimiento sale de su tipo', async () => {
    const [imaging] = await prismaDouble(analyteRow(), false, {
      kind: 'IMAGING',
    }).repository.active();
    const [procedure] = await prismaDouble(analyteRow(), false, {
      kind: 'PROCEDURE',
    }).repository.active();

    expect(imaging?.category).toBe('IMAGING');
    expect(procedure?.category).toBe('PROCEDURE');
  });

  it('ORD-012 publica como reflejo el analito marcado is_reflex, y como no reflejo el que no', async () => {
    const reflex = await prismaDouble(analyteRow(), true).repository.active();
    const plain = await prismaDouble(analyteRow(), false).repository.active();

    expect(reflex[0]?.analytes[0]?.isReflex).toBe(true);
    expect(plain[0]?.analytes[0]?.isReflex).toBe(false);
  });

  it('ORD-033 lee la lista de valores admitidos y descarta cualquier payload que no lo sea', async () => {
    const good = prismaDouble(analyteRow({ allowedValues: ['Negativo', 'Positivo'] })); // prettier-ignore
    const [withList] = await good.repository.active();
    expect(withList?.analytes[0]?.analyte.allowedValues).toEqual([
      'Negativo',
      'Positivo',
    ]);

    // Una lista vacía significaría «ningún valor es admisible» y dejaría el
    // analito intranscribible; `null` es «el catálogo aún no lo dice».
    for (const malformed of [[], [1, 2], 'Negativo', { a: 1 }]) {
      const bad = prismaDouble(analyteRow({ allowedValues: malformed }));
      const [exam] = await bad.repository.active();
      expect(exam?.analytes[0]?.analyte.allowedValues, JSON.stringify(malformed)).toBeNull(); // prettier-ignore
    }
  });

  it('ORD-003 pide sólo los activos por id, y por código los pide activos o no', async () => {
    // Un resultado puede llegar semanas después de que la clínica deshabilitara
    // el examen, y la línea congeló el código justo para que resolverlo no
    // dependa del catálogo de hoy.
    const byId = prismaDouble();
    await byId.repository.activeByIds(['service-1']);
    expect(byId.calls[0]?.args).toMatchObject({
      where: { exam: { isNot: null }, active: true },
    });

    const byCode = prismaDouble();
    await byCode.repository.byCodes(['LAB-BH']);
    expect(byCode.calls[0]?.args).toMatchObject({
      where: { exam: { isNot: null }, code: { in: ['LAB-BH'] } },
    });
    expect(
      (byCode.calls[0]?.args as { where: Record<string, unknown> }).where
        .active,
    ).toBeUndefined();
  });

  it('ORD-042 no consulta la base cuando no se pregunta por nada', async () => {
    const { repository, calls } = prismaDouble();

    expect(await repository.activeByIds([])).toEqual([]);
    expect(await repository.byCodes([])).toEqual([]);
    expect(await repository.analytesByIds([])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('ORD-042 resuelve los analitos por id, también los desactivados: lo ya pedido los sigue esperando', async () => {
    const { repository, calls } = prismaDouble();

    const analytes = await repository.analytesByIds(['analyte-1']);

    expect(analytes[0]?.code).toBe('HB');
    const where = (calls[0]?.args as { where: Record<string, unknown> }).where;
    expect(where).not.toHaveProperty('active');
  });
});
