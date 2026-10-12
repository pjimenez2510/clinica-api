import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaOrderingContextReader } from '../../src/shared/infrastructure/clinical/prisma-ordering-context.reader';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createExamService,
  createPatient,
  createPractitioner,
  createService,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * AS-104, AS-106, AS-109 against PostgreSQL: what the assistant reads of the
 * clinic's orderable catalogue and of the attention's orders. Every «not
 * offered» has its positive control through the same path.
 */
const db = useDatabase();

const reader = (prisma: PrismaClient) =>
  new PrismaOrderingContextReader(prisma as unknown as PrismaService);

async function anAttention(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  return { site, practitioner, patient, encounter };
}

async function anOrder(
  prisma: PrismaClient,
  attention: Awaited<ReturnType<typeof anAttention>>,
  lines: { code: string; cancelled?: boolean }[],
  category: 'LABORATORY' | 'IMAGING' = 'LABORATORY',
) {
  const order = await prisma.serviceOrder.create({
    data: {
      encounterId: attention.encounter.id,
      siteId: attention.site.id,
      orderedById: attention.practitioner.id,
      category,
      items: {
        create: lines.map(({ code }) => ({
          testCode: code,
          testDisplay: code,
        })),
      },
    },
    include: { items: true },
  });
  if (!lines.some((line) => line.cancelled)) return order;
  // ORD-007. A line is annulled on an issued order, saying who.
  await prisma.serviceOrder.update({
    where: { id: order.id },
    data: { status: 'ISSUED' },
  });
  const canceller = await createUser(prisma);
  for (const [at, line] of lines.entries()) {
    if (!line.cancelled) continue;
    await prisma.serviceOrderItem.update({
      where: { id: order.items[at]!.id },
      data: { status: 'CANCELLED', completedAt: new Date(), cancelledById: canceller.id }, // prettier-ignore
    });
  }
  return order;
}

/** ORD-099. A discard says who and when. */
async function discard(prisma: PrismaClient, orderId: string) {
  await prisma.serviceOrder.update({
    where: { id: orderId },
    data: {
      status: 'DISCARDED',
      discardedAt: new Date(),
      discardedById: (await createUser(prisma)).id,
    },
  });
}

describe('the catalogue the assistant offers (AS-104)', () => {
  it('AS-104 offers the active laboratory and imaging services that are ordered, by name, with their category — never a procedure, an inactive one or a consultation', async () => {
    const prisma = db();
    const bh = await createExamService(prisma, { code: 'LAB-BH', name: 'Biometría hemática completa' }); // prettier-ignore
    const rx = await createExamService(prisma, { code: 'IMG-RX-TORAX', name: 'Radiografía de tórax', kind: 'IMAGING' }); // prettier-ignore
    await createExamService(prisma, { code: 'PROC-ECG', name: 'Electrocardiograma', kind: 'PROCEDURE' }); // prettier-ignore
    await createExamService(prisma, { code: 'LAB-VIEJO', name: 'Aglutinaciones febriles', active: false }); // prettier-ignore
    // A laboratory service without its order extension is not orderable (BI-284).
    await createService(prisma, { code: 'LAB-SIN-ORDEN', name: 'Toma de muestra', kind: 'LAB_EXAM' }); // prettier-ignore

    expect(await reader(prisma).orderableExams()).toEqual([
      { serviceId: bh.id, code: 'LAB-BH', name: 'Biometría hemática completa', category: 'LABORATORY' }, // prettier-ignore
      { serviceId: rx.id, code: 'IMG-RX-TORAX', name: 'Radiografía de tórax', category: 'IMAGING' }, // prettier-ignore
    ]);

    // Positive control: activated again, the same reader offers it.
    await prisma.service.update({ where: { code: 'LAB-VIEJO' }, data: { active: true } }); // prettier-ignore
    const codes = (await reader(prisma).orderableExams()).map((each) => each.code); // prettier-ignore
    expect(codes).toContain('LAB-VIEJO');
  });
});

describe('what the attention already orders (AS-106)', () => {
  it('AS-106 the codes of every order not discarded, without the annulled lines and without other attentions', async () => {
    const prisma = db();
    const attention = await anAttention(prisma);
    const other = await anAttention(prisma);
    await anOrder(prisma, attention, [{ code: 'LAB-BH' }, { code: 'LAB-EMO', cancelled: true }]); // prettier-ignore
    await anOrder(prisma, attention, [{ code: 'IMG-RX-TORAX' }], 'IMAGING');
    const dropped = await anOrder(prisma, attention, [{ code: 'LAB-GLUCOSA' }]);
    await discard(prisma, dropped.id);
    await anOrder(prisma, other, [{ code: 'LAB-TSH' }]);

    const codes = await reader(prisma).orderedCodes(attention.encounter.id);
    expect([...codes].sort()).toEqual(['IMG-RX-TORAX', 'LAB-BH']);
  });
});

describe('one order of the attention, read to link (AS-109)', () => {
  it('AS-109 the live codes of an order of this attention; null for an order of another one or a discarded one', async () => {
    const prisma = db();
    const attention = await anAttention(prisma);
    const other = await anAttention(prisma);
    const own = await anOrder(prisma, attention, [{ code: 'LAB-BH' }, { code: 'LAB-EMO', cancelled: true }]); // prettier-ignore
    const theirs = await anOrder(prisma, other, [{ code: 'LAB-BH' }]);
    const dropped = await anOrder(prisma, attention, [{ code: 'LAB-BH' }]);
    await discard(prisma, dropped.id);

    expect(await reader(prisma).orderCodes(attention.encounter.id, own.id)).toEqual(['LAB-BH']); // prettier-ignore
    expect(await reader(prisma).orderCodes(attention.encounter.id, theirs.id)).toBeNull(); // prettier-ignore
    expect(await reader(prisma).orderCodes(attention.encounter.id, dropped.id)).toBeNull(); // prettier-ignore
    // Positive control: the other attention reads its own order.
    expect(await reader(prisma).orderCodes(other.encounter.id, theirs.id)).toEqual(['LAB-BH']); // prettier-ignore
  });
});
