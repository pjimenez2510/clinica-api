import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { DiagnosticReportService } from '../../src/modules/orders/application/diagnostic-report.service';
import type { Requester } from '../../src/modules/orders/application/service-order.service';
import { PrismaDiagnosticReportRepository } from '../../src/modules/orders/infrastructure/prisma-diagnostic-report.repository';
import { PrismaExamCatalogueRepository } from '../../src/modules/orders/infrastructure/prisma-exam-catalogue.repository';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import type { AccessAuditRecorder } from '../../src/shared/audit/access-audit.port';
import { InProcessLiveEventBus } from '../../src/shared/events/live-event-bus';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { aScene, placeIssued } from './orders-fixtures';
import { useDatabase } from './setup/database';

/**
 * ORD-170 (D-168 §1) against PostgreSQL: a report that corrects nothing does
 * not repeat a determination that already stands on the order.
 *
 * The service refuses it with the sentence; what only the database shows is
 * that `trg_observation_result_one_standing_per_analyte` refuses the row that
 * arrives by any other road —an import, a psql, two submissions at once—.
 */
const db = useDatabase();

const silentAudit: AccessAuditRecorder = { record: () => Promise.resolve() };
const requester: Requester = { userId: 'user-1', sites: 'all' };
const noopLogger = {
  setContext: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const HOUR = 3_600_000;

function serviceOf(prisma: PrismaClient) {
  const client = prisma as unknown as PrismaService;
  return {
    reports: new DiagnosticReportService(
      new PrismaDiagnosticReportRepository(client),
      new PrismaServiceOrderRepository(client),
      new PrismaExamCatalogueRepository(client),
      silentAudit,
      noopLogger as never,
      new InProcessLiveEventBus(),
    ),
    orders: new PrismaServiceOrderRepository(client),
  };
}

/** A blood count and a fasting glucose, issued, with a haemoglobin reported. */
async function aReportedHaemoglobin(prisma: PrismaClient) {
  const scene = await aScene(prisma);
  const { orders, reports } = serviceOf(prisma);
  const order = await placeIssued(orders, {
    encounterId: scene.encounter.id,
    category: 'LABORATORY',
    priority: 'ROUTINE',
    lines: [{ serviceId: scene.bh.id }, { serviceId: scene.glucose.id }],
    sites: 'all',
  });
  const issuedAt = new Date(Date.now() - 2 * HOUR);
  const first = await reports.register(
    {
      orderId: order.id,
      performedById: null,
      issuedAt,
      results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 13 }],
    },
    requester,
  );
  return { ...scene, order, first, issuedAt, reports };
}

/** A report row and one value written by hand, as an import would. */
async function insertByHand(
  prisma: PrismaClient,
  orderId: string,
  analyteDisplay: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const [report] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "diagnostic_report" ("service_order_id", "status", "issued_at", "updated_at")
      VALUES (${orderId}::uuid, 'PARTIAL', now(), now())
      RETURNING "id"::text AS "id"`;
    await tx.$executeRaw`
      INSERT INTO "observation_result" ("report_id", "analyte_display", "value_numeric", "unit")
      VALUES (${report?.id}::uuid, ${analyteDisplay}, 1, 'mg/dL')`;
  });
}

describe('ORD-170, el informe que repite una determinación vigente', () => {
  it('ORD-170 el servicio lo rechaza y admite lo que aún no tiene valor', async () => {
    const prisma = db();
    const scene = await aReportedHaemoglobin(prisma);
    const second = (analyteDefinitionId: string, valueNumeric: number) =>
      scene.reports.register(
        {
          orderId: scene.order.id,
          performedById: null,
          issuedAt: new Date(scene.issuedAt.getTime() + HOUR),
          results: [{ analyteDefinitionId, valueNumeric }],
        },
        requester,
      );

    await expect(second(scene.hb.id, 9)).rejects.toMatchObject({
      code: 'RESULT_ALREADY_REPORTED',
    });
    // Control positivo: el segundo envío del laboratorio con la glucosa.
    await expect(second(scene.glu.id, 92)).resolves.toMatchObject({
      serviceOrderId: scene.order.id,
    });
    expect(
      await prisma.observationResult.count({
        where: { report: { serviceOrderId: scene.order.id } },
      }),
    ).toBe(2);
  });

  it('ORD-170 la base rechaza el valor repetido que llega sin pasar por el servicio', async () => {
    const prisma = db();
    const scene = await aReportedHaemoglobin(prisma);

    await expect(
      insertByHand(prisma, scene.order.id, 'Hemoglobina'),
    ).rejects.toThrow(/observation_result_one_standing_per_analyte/);
    // Control positivo: el mismo camino con una determinación sin valor.
    await expect(
      insertByHand(prisma, scene.order.id, 'Glucosa en ayunas'),
    ).resolves.toBeUndefined();
  });

  it('ORD-170 la corrección del informe vigente sí vuelve a escribir la determinación', async () => {
    const prisma = db();
    const scene = await aReportedHaemoglobin(prisma);

    const corrected = await scene.reports.correct(
      {
        reportId: scene.first.id,
        performedById: null,
        issuedAt: new Date(scene.issuedAt.getTime() + HOUR),
        results: [{ analyteDefinitionId: scene.hb.id, valueNumeric: 9 }],
      },
      requester,
    );

    expect(corrected.supersedesId).toBe(scene.first.id);
    // Y tras ella, el valor vigente es el de la corrección: repetirlo en un
    // informe nuevo se rechaza igual.
    await expect(
      insertByHand(prisma, scene.order.id, 'Hemoglobina'),
    ).rejects.toThrow(/observation_result_one_standing_per_analyte/);
  });

  it('ORD-170 de dos informes nuevos a la vez con la misma determinación gana uno', async () => {
    const prisma = db();
    const scene = await aReportedHaemoglobin(prisma);
    const glucose = () =>
      scene.reports.register(
        {
          orderId: scene.order.id,
          performedById: null,
          issuedAt: new Date(scene.issuedAt.getTime() + HOUR),
          results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 92 }],
        },
        requester,
      );

    const outcomes = await Promise.allSettled([glucose(), glucose()]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.observationResult.count({
        where: {
          analyteDisplay: 'Glucosa en ayunas',
          report: { serviceOrderId: scene.order.id },
        },
      }),
    ).toBe(1);
  });

  it('ORD-170 la corrección de un informe no añade una determinación que tiene valor en otro informe vigente', async () => {
    // Revisión clínica G2: la Hb en un informe, la glucosa 25 en el segundo
    // envío; «corregir» el primero añadiendo la glucosa 95 dejaba dos vigentes.
    const prisma = db();
    const scene = await aReportedHaemoglobin(prisma);
    await scene.reports.register(
      {
        orderId: scene.order.id,
        performedById: null,
        issuedAt: new Date(scene.issuedAt.getTime() + HOUR),
        results: [{ analyteDefinitionId: scene.glu.id, valueNumeric: 25 }],
      },
      requester,
    );
    const correction = (
      results: { analyteDefinitionId: string; valueNumeric: number }[],
    ) =>
      // prettier-ignore
      scene.reports.correct(
        { reportId: scene.first.id, performedById: null, issuedAt: new Date(scene.issuedAt.getTime() + HOUR), results }, // prettier-ignore
        requester,
      );

    await expect(
      correction([
        { analyteDefinitionId: scene.hb.id, valueNumeric: 13 },
        { analyteDefinitionId: scene.glu.id, valueNumeric: 95 },
      ]),
    ).rejects.toMatchObject({ code: 'RESULT_ALREADY_REPORTED' });
    // Y la base, por un INSERT directo en una corrección del primero.
    await expect(
      prisma.$transaction(async (tx) => {
        const [report] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "diagnostic_report" ("service_order_id", "status", "issued_at", "supersedes_id", "updated_at")
          VALUES (${scene.order.id}::uuid, 'CORRECTED', now(), ${scene.first.id}::uuid, now())
          RETURNING "id"::text AS "id"`;
        await tx.$executeRaw`
          INSERT INTO "observation_result" ("report_id", "analyte_display", "value_numeric", "unit")
          VALUES (${report?.id}::uuid, 'Glucosa en ayunas', 95, 'mg/dL')`;
      }),
    ).rejects.toThrow(/observation_result_one_standing_per_analyte/);
    // Control positivo: la corrección que reescribe lo suyo entra.
    await expect(
      correction([{ analyteDefinitionId: scene.hb.id, valueNumeric: 9 }]),
    ).resolves.toMatchObject({ supersedesId: scene.first.id });
  });

  it('ORD-170 un informe anulado no cuenta como vigente', async () => {
    const prisma = db();
    const scene = await aReportedHaemoglobin(prisma);
    await prisma.$executeRaw`UPDATE "diagnostic_report" SET "status" = 'CANCELLED' WHERE "id" = ${scene.first.id}::uuid`; // prettier-ignore

    await expect(
      insertByHand(prisma, scene.order.id, 'Hemoglobina'),
    ).resolves.toBeUndefined();
  });
});
