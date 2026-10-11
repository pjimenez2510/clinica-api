import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaDocumentSourceReader } from '../../src/modules/documents/infrastructure/prisma-document-source.reader';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { aScene } from './orders-fixtures';
import { useDatabase } from './setup/database';
import { createDiagnosis, createUser } from './setup/fixtures';

/**
 * ORD-121 (D-117.5): the exam order FREEZES its diagnoses when it is issued,
 * as the receta does (PR-026) and the certificate (CER-027). Until now it read
 * the attention's diagnoses live, so EN-182 had to forbid correcting the
 * attention while an order with live exams existed — and the only way out was
 * to cancel exams the laboratory already had.
 *
 * Proved against PostgreSQL: the copy is written by a trigger at the issue,
 * whoever issues, and an issued order does not rewrite it. Every refusal has
 * its positive control beside it.
 */
const db = useDatabase();

function adapters(prisma: PrismaClient) {
  const client = prisma as unknown as PrismaService;
  return {
    orders: new PrismaServiceOrderRepository(client),
    documents: new PrismaDocumentSourceReader(
      client,
      'http://localhost/verificar',
    ),
  };
}

/** An attention with J02 (principal) and R50, and a draft order of one exam. */
async function aDraftOrder(prisma: PrismaClient) {
  const scene = await aScene(prisma);
  await createDiagnosis(prisma, scene.encounter.id, 'J02', 'Faringitis aguda');
  await createDiagnosis(prisma, scene.encounter.id, 'R50', 'Fiebre');
  const { orders } = adapters(prisma);
  const draft = await orders.compose({
    encounterId: scene.encounter.id,
    category: 'LABORATORY',
    priority: 'ROUTINE',
    lines: [{ serviceId: scene.bh.id }],
    sites: 'all',
  });
  return { scene, draft };
}

const frozenOf = async (prisma: PrismaClient, orderId: string) =>
  (
    await prisma.serviceOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { diagnoses: true },
    })
  ).diagnoses;

const FROZEN = [
  { code: 'J02', display: 'Faringitis aguda' },
  { code: 'R50', display: 'Fiebre' },
];

describe('ORD-121 la orden congela sus diagnósticos al emitirse', () => {
  it('ORD-121 el borrador no congela nada; emitida, la BASE copia los diagnósticos con el principal primero y no deja reescribirlos', async () => {
    const prisma = db();
    const { draft } = await aDraftOrder(prisma);

    expect(await frozenOf(prisma, draft.id)).toBeNull();
    await adapters(prisma).orders.issue({ orderId: draft.id, sites: 'all' });
    expect(await frozenOf(prisma, draft.id)).toEqual(FROZEN);

    await expect(
      prisma.$executeRaw`UPDATE service_order SET diagnoses = '[]'::jsonb WHERE id = ${draft.id}::uuid`,
    ).rejects.toThrow(/service_order_frozen_once_issued/);
    // Positive control: what an issued order may still change, its lines'
    // state, does not touch the copy.
    expect(await frozenOf(prisma, draft.id)).toEqual(FROZEN);
  });

  it('ORD-121 EN-182 con exámenes vivos ya se quita y se edita el diagnóstico —con el motivo de un papel entregado—, y la orden sigue diciendo el que tenía', async () => {
    const prisma = db();
    const { scene, draft } = await aDraftOrder(prisma);
    await adapters(prisma).orders.issue({ orderId: draft.id, sites: 'all' });
    const remover = await createUser(prisma);
    const [principal, second] = await prisma.encounterDiagnosis.findMany({
      where: { encounterId: scene.encounter.id },
      orderBy: { rank: 'asc' },
    });
    const archive = (id: string, reason: string | null) =>
      prisma.$executeRaw`
        INSERT INTO encounter_diagnosis_retraction
          (id, encounter_id, concept_id, cie10_code, cie10_display, certainty,
           occurrence, rank, notifiable, note, recorded_at, retracted_by_id, reason)
        SELECT id, encounter_id, concept_id, cie10_code, cie10_display, certainty,
               occurrence, rank, notifiable, note, recorded_at, ${remover.id}::uuid, ${reason}
          FROM encounter_diagnosis WHERE id = ${id}::uuid`;

    // The laboratory holds a paper that printed R50 (EN-214).
    await expect(archive(second!.id, null)).rejects.toThrow(
      /encounter_diagnosis_retraction_reason/,
    );
    // Positive control: with the reason it goes, though the exam is alive.
    await archive(second!.id, 'Diagnóstico descartado');
    await prisma.$executeRaw`DELETE FROM encounter_diagnosis WHERE id = ${second!.id}::uuid`;

    // And the principal's code is edited and its rank moved, stamped.
    const k21 = await prisma.catalogConcept.create({
      data: {
        systemId: (await prisma.catalogSystem.findUniqueOrThrow({ where: { code: 'CIE10' } })).id, // prettier-ignore
        code: 'K21',
        display: 'Reflujo gastroesofágico',
        validFrom: new Date('2019-01-01'), // fecha-fija: vigente desde siempre
      },
    });
    await prisma.$executeRaw`
      UPDATE encounter_diagnosis
         SET concept_id = ${k21.id}::uuid, cie10_code = 'K21', rank = 3,
             edited_by_id = ${remover.id}::uuid, edited_at = ${new Date()},
             edit_reason = 'Código mal elegido'
       WHERE id = ${principal!.id}::uuid`;

    expect(await frozenOf(prisma, draft.id)).toEqual(FROZEN);
    // The paper the laboratory reads says it too.
    const subject = await adapters(prisma).documents.findSubject({
      kind: 'SERVICE_ORDER',
      subjectId: draft.id,
      sites: 'all',
    });
    expect(subject?.kind === 'SERVICE_ORDER' && subject.data.diagnoses).toEqual(
      FROZEN,
    );
  });

  it('ORD-121 un diagnóstico registrado DESPUÉS de emitir no entra en la orden emitida; en una emitida después, sí', async () => {
    const prisma = db();
    const { scene, draft } = await aDraftOrder(prisma);
    const { orders } = adapters(prisma);
    await orders.issue({ orderId: draft.id, sites: 'all' });

    await createDiagnosis(prisma, scene.encounter.id, 'R51', 'Cefalea');
    expect(await frozenOf(prisma, draft.id)).toEqual(FROZEN);

    // Positive control: an order issued now copies the attention as it is.
    const next = await orders.compose({
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ serviceId: scene.bh.id }],
      sites: 'all',
    });
    await orders.issue({ orderId: next.id, sites: 'all' });
    expect(await frozenOf(prisma, next.id)).toEqual([
      ...FROZEN,
      { code: 'R51', display: 'Cefalea' },
    ]);
  });

  it('ORD-121 la BASE sólo admite diagnósticos congelados en la orden emitida, y como lista (service_order_diagnoses_frozen_when_issued)', async () => {
    const prisma = db();
    const { draft } = await aDraftOrder(prisma);

    // A draft printed nothing: it carries no copy.
    await expect(
      prisma.$executeRaw`UPDATE service_order SET diagnoses = '[]'::jsonb WHERE id = ${draft.id}::uuid`,
    ).rejects.toThrow(/service_order_diagnoses_frozen_when_issued/);
    await expect(
      prisma.$executeRaw`UPDATE service_order SET diagnoses = '{"code":"J02"}'::jsonb WHERE id = ${draft.id}::uuid`,
    ).rejects.toThrow(/service_order_diagnoses_frozen_when_issued/);
    expect(await frozenOf(prisma, draft.id)).toBeNull();

    // Positive control: issued, the copy is there and is a list.
    await adapters(prisma).orders.issue({ orderId: draft.id, sites: 'all' });
    expect(await frozenOf(prisma, draft.id)).toEqual(FROZEN);
  });
});
