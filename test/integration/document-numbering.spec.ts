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
    INSERT INTO service_order (encounter_id, site_id, ordered_by_id, category, status, updated_at)
    VALUES (${scene.encounterId}::uuid, ${scene.siteId}::uuid,
            ${scene.practitionerId}::uuid, 'LABORATORY', 'ISSUED', now())
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

    // Control positivo: otra columna de la misma orden sí se actualiza.
    await expect(
      prisma.$executeRaw`UPDATE service_order SET updated_at = now()`,
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRaw`UPDATE service_order SET number = 99`,
    ).rejects.toThrow(/service_order_number_immutable/);
  });

  it('ORD-006 cada orden nace con su propio codigo de verificacion, y la base no admite dos iguales', async () => {
    const prisma = db();
    const { ids } = await sceneOf(prisma);
    await insertOrder(prisma, ids);
    await insertOrder(prisma, ids);

    const codes = await prisma.$queryRaw<{ verification_code: string }[]>`
      SELECT verification_code FROM service_order ORDER BY number`;
    // Control positivo: los dos tienen código, y distinto.
    expect(codes[0]!.verification_code).toMatch(/^[0-9A-F]{16}$/);
    expect(codes[0]!.verification_code).not.toBe(codes[1]!.verification_code);

    await expect(
      prisma.$executeRaw`
        UPDATE service_order SET verification_code = ${codes[0]!.verification_code}
         WHERE verification_code = ${codes[1]!.verification_code}`,
    ).rejects.toThrow(/verification_code/);
  });

  it('ST-049 la base rechaza un telefono de contacto que no es un numero, aunque no pase por la API', async () => {
    const prisma = db();
    const { ids } = await sceneOf(prisma);

    // Control positivo: un número móvil ecuatoriano pasa por el mismo CHECK.
    await expect(
      prisma.$executeRaw`UPDATE practitioner SET emergency_contact_phone = '0991234567' WHERE id = ${ids.practitionerId}::uuid`,
    ).resolves.toBe(1);
    await expect(
      prisma.$executeRaw`UPDATE practitioner SET emergency_contact_phone = 'llamar a casa' WHERE id = ${ids.practitionerId}::uuid`,
    ).rejects.toThrow(/practitioner_emergency_contact_phone_format/);
  });

  it('ORD-006 el número no lo elige quien inserta: el disparador lo pisa', async () => {
    const prisma = db();
    const { ids } = await sceneOf(prisma);

    const [row] = await prisma.$queryRaw<{ number: number }[]>`
      INSERT INTO service_order (encounter_id, site_id, ordered_by_id, category, status, number, updated_at)
      VALUES (${ids.encounterId}::uuid, ${ids.siteId}::uuid,
              ${ids.practitionerId}::uuid, 'LABORATORY', 'ISSUED', 500, now())
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

/** A draft prescription inserted the way any writer can: raw SQL. */
async function insertDraft(
  prisma: PrismaClient,
  ids: { encounterId: string; practitionerId: string },
): Promise<string> {
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO prescription (encounter_id, prescriber_id, status, updated_at)
    VALUES (${ids.encounterId}::uuid, ${ids.practitionerId}::uuid, 'DRAFT', now())
    RETURNING id
  `;
  return row!.id;
}

/** The issue as the database sees it: `DRAFT → ACTIVE` with its instant. */
async function issueRaw(prisma: PrismaClient, id: string): Promise<number> {
  const [row] = await prisma.$queryRaw<{ sequence_number: number }[]>`
    UPDATE prescription
       SET status = 'ACTIVE', issued_at = now(), verification_code = left(md5(id::text), 12)
     WHERE id = ${id}::uuid
    RETURNING sequence_number
  `;
  return row!.sequence_number;
}

describe('PR-020 la numeración secuencial de la receta: al emitir, por sede, sin huecos', () => {
  it('PR-020 un borrador no tiene número; al emitirse recibe el siguiente de su sede', async () => {
    const prisma = db();
    const { ids } = await sceneOf(prisma);
    const first = await insertDraft(prisma, ids);
    const second = await insertDraft(prisma, ids);

    const [draft] = await prisma.$queryRaw<{ sequence_number: number | null; site_id: string }[]>`
      SELECT sequence_number, site_id FROM prescription WHERE id = ${first}::uuid
    `; // prettier-ignore
    expect(draft!.sequence_number).toBeNull();
    // La sede la pone la base desde la atención: nadie la elige.
    expect(draft!.site_id).toBe(ids.siteId);

    // Se numera en el orden en que se EMITEN, no en el que se compusieron.
    expect(await issueRaw(prisma, second)).toBe(1);
    expect(await issueRaw(prisma, first)).toBe(2);
  });

  it('PR-020 un borrador descartado no consume número', async () => {
    const prisma = db();
    const { ids, practitioner } = await sceneOf(prisma);
    const discarded = await insertDraft(prisma, ids);
    const user = await prisma.practitioner.findUniqueOrThrow({
      where: { id: practitioner.id },
      select: { userId: true },
    });
    await prisma.$executeRaw`
      UPDATE prescription
         SET status = 'DISCARDED', discarded_at = now(),
             discarded_by_id = ${user.userId}::uuid, discard_reason = 'Se tecleó mal'
       WHERE id = ${discarded}::uuid
    `;

    expect(await issueRaw(prisma, await insertDraft(prisma, ids))).toBe(1);
  });

  it('PR-020 una emisión que se revierte devuelve su número', async () => {
    const prisma = db();
    const { ids } = await sceneOf(prisma);
    const draft = await insertDraft(prisma, ids);

    await expect(
      prisma.$transaction(async (tx) => {
        await issueRaw(tx as PrismaClient, draft);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await issueRaw(prisma, draft)).toBe(1);
  });

  it('PR-020 el número de una receta emitida no se cambia', async () => {
    const prisma = db();
    const { ids } = await sceneOf(prisma);
    await issueRaw(prisma, await insertDraft(prisma, ids));

    await expect(
      prisma.$executeRaw`UPDATE prescription SET sequence_number = 99`,
    ).rejects.toThrow(/prescription_(frozen|number_immutable)/);
  });

  it('PR-020 control positivo: un borrador con número y una emitida sin él los rechaza la base', async () => {
    const prisma = db();
    const { ids } = await sceneOf(prisma);
    const draft = await insertDraft(prisma, ids);

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`ALTER TABLE prescription DISABLE TRIGGER prescription_number_immutable`;
        await tx.$executeRaw`UPDATE prescription SET sequence_number = 7 WHERE id = ${draft}::uuid`;
      }),
    ).rejects.toThrow(/prescription_number_only_when_issued/);
  });
});
