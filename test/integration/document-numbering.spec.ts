import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { aScene } from './orders-fixtures';
import { useDatabase } from './setup/database';
import { createEncounter, createSite } from './setup/fixtures';

/**
 * The consecutive number every printed clinical document carries, against a
 * real PostgreSQL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY ONLY THE DATABASE CAN SHOW THIS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «Consecutive and without gaps» is a property of concurrent transactions and
 * of rollbacks. A double that hands out `n + 1` proves the addition. What has
 * to be shown is that two emissions at once do not collide, that one that
 * rolls back gives its number back, and that a raw `INSERT` — an import, a
 * `psql`, a use case written in two years — gets a number too, because the
 * trigger assigns it and not the repository.
 */
const db = useDatabase();

/** One order inserted the way any writer can: raw SQL, no repository. */
async function insertOrder(
  prisma: PrismaClient,
  scene: { encounterId: string; siteId: string; practitionerId: string },
): Promise<number> {
  const [row] = await prisma.$queryRaw<{ number: number }[]>`
    INSERT INTO service_order (encounter_id, site_id, ordered_by_id, category, updated_at)
    VALUES (${scene.encounterId}::uuid, ${scene.siteId}::uuid,
            ${scene.practitionerId}::uuid, 'LABORATORY', now())
    RETURNING number
  `;
  return row!.number;
}

async function sceneOf(prisma: PrismaClient) {
  const scene = await aScene(prisma);
  return {
    ...scene,
    ids: {
      encounterId: scene.encounter.id,
      siteId: scene.site.id,
      practitionerId: scene.practitioner.id,
    },
  };
}

describe('ORD-006 el número de orden: propio, consecutivo, sin huecos e inmutable', () => {
  it('ORD-006 dos órdenes de la misma sede llevan 1 y 2, aunque se inserten por SQL directo', async () => {
    const prisma = db();
    const { ids } = await sceneOf(prisma);

    expect(await insertOrder(prisma, ids)).toBe(1);
    expect(await insertOrder(prisma, ids)).toBe(2);
  });

  it('ORD-006 cada sede numera desde 1 (D-074, por sede)', async () => {
    const prisma = db();
    const { ids, practitioner, patient } = await sceneOf(prisma);
    const other = await createSite(prisma);
    const otherEncounter = await createEncounter(prisma, {
      siteId: other.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    });

    expect(await insertOrder(prisma, ids)).toBe(1);
    expect(
      await insertOrder(prisma, {
        encounterId: otherEncounter.id,
        siteId: other.id,
        practitionerId: practitioner.id,
      }),
    ).toBe(1);
  });

  it('ORD-006 una emisión que se revierte devuelve su número: no queda hueco', async () => {
    const prisma = db();
    const { ids } = await sceneOf(prisma);

    await expect(
      prisma.$transaction(async (tx) => {
        await insertOrder(tx as PrismaClient, ids);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await insertOrder(prisma, ids)).toBe(1);
  });

  it('ORD-006 diez emisiones concurrentes reciben 1 a 10, sin repetir ni saltar', async () => {
    const prisma = db();
    const { ids } = await sceneOf(prisma);

    const numbers = await Promise.all(
      Array.from({ length: 10 }, () => insertOrder(prisma, ids)),
    );

    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
  });

  it('ORD-006 el número no se puede cambiar después', async () => {
    const prisma = db();
    const { ids } = await sceneOf(prisma);
    await insertOrder(prisma, ids);

    await expect(
      prisma.$executeRaw`UPDATE service_order SET number = 99`,
    ).rejects.toThrow(/service_order_number_immutable/);
  });

  it('ORD-006 el número no lo elige quien inserta: el disparador lo pisa', async () => {
    const prisma = db();
    const { ids } = await sceneOf(prisma);

    const [row] = await prisma.$queryRaw<{ number: number }[]>`
      INSERT INTO service_order (encounter_id, site_id, ordered_by_id, category, number, updated_at)
      VALUES (${ids.encounterId}::uuid, ${ids.siteId}::uuid,
              ${ids.practitionerId}::uuid, 'LABORATORY', 500, now())
      RETURNING number
    `;

    expect(row!.number).toBe(1);
  });

  it('ORD-006 control positivo: la unicidad por sede existe y rechaza un duplicado', async () => {
    const prisma = db();
    const { ids } = await sceneOf(prisma);
    await insertOrder(prisma, ids);
    await insertOrder(prisma, ids);

    // Sin pasar por el disparador de UPDATE no se puede tocar `number`, así
    // que la unicidad se prueba desactivándolo dentro de la transacción: lo
    // que se demuestra es que, si el disparador faltara, la base seguiría
    // diciendo que no.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`ALTER TABLE service_order DISABLE TRIGGER service_order_number_immutable`;
        await tx.$executeRaw`UPDATE service_order SET number = 1 WHERE number = 2`;
      }),
    ).rejects.toThrow(/service_order_site_number_unique/);
  });
});
