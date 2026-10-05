import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { aScene } from './orders-fixtures';
import { useDatabase } from './setup/database';
import { createUser } from './setup/fixtures';

/**
 * The order in draft, against a real PostgreSQL (ORD-095 to ORD-099).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT ONLY THE DATABASE CAN SHOW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That an ISSUED order cannot be rewritten by any writer — a repository bug, a
 * `psql`, an import — and that the number of the art. 43 series is taken at the
 * issue and never by a draft, so a discarded draft leaves no gap. A double
 * that refuses what we told it to refuse proves neither.
 */
const db = useDatabase();

type Scene = Awaited<ReturnType<typeof aScene>>;

/** A draft with one line, written the way any writer can: raw SQL. */
async function aDraft(prisma: PrismaClient, scene: Scene): Promise<string> {
  const [order] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO service_order (encounter_id, site_id, ordered_by_id, category, status, updated_at)
    VALUES (${scene.encounter.id}::uuid, ${scene.site.id}::uuid,
            ${scene.practitioner.id}::uuid, 'LABORATORY', 'DRAFT', now())
    RETURNING id
  `;
  await anItem(prisma, scene, order!.id);
  return order!.id;
}

async function anItem(prisma: PrismaClient, scene: Scene, orderId: string) {
  await prisma.$executeRaw`
    INSERT INTO service_order_item (service_order_id, concept_id, test_code, test_display)
    VALUES (${orderId}::uuid, ${scene.concept.id}::uuid, 'EX-BH', 'Biometría hemática completa')
  `;
}

async function numberOf(prisma: PrismaClient, orderId: string) {
  const [row] = await prisma.$queryRaw<{ number: number | null }[]>`
    SELECT number FROM service_order WHERE id = ${orderId}::uuid`;
  return row!.number;
}

const issue = (prisma: PrismaClient, orderId: string) =>
  prisma.$executeRaw`UPDATE service_order SET status = 'ISSUED' WHERE id = ${orderId}::uuid`;

describe('ORD-095 a ORD-099 la orden en borrador contra PostgreSQL', () => {
  it('ORD-095 un borrador nace sin número', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    const draft = await aDraft(prisma, scene);

    expect(await numberOf(prisma, draft)).toBeNull();
  });

  it('ORD-098 el número se toma al emitir, y un borrador descartado antes no consume ninguno', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const user = await createUser(prisma);
    const discarded = await aDraft(prisma, scene);
    const kept = await aDraft(prisma, scene);

    await prisma.$executeRaw`
      UPDATE service_order
         SET status = 'DISCARDED', discarded_at = now(), discarded_by_id = ${user.id}::uuid
       WHERE id = ${discarded}::uuid`;
    await issue(prisma, kept);

    expect(await numberOf(prisma, kept)).toBe(1);
    expect(await numberOf(prisma, discarded)).toBeNull();
  });

  it('ORD-096 el borrador se corrige; la orden emitida no, ni su tipo, ni su prioridad, ni su indicación', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const order = await aDraft(prisma, scene);

    // Control positivo: en borrador, todo se cambia.
    await expect(
      prisma.$executeRaw`
        UPDATE service_order
           SET priority = 'URGENT', category = 'IMAGING', clinical_note_text = 'Dolor'
         WHERE id = ${order}::uuid`,
    ).resolves.toBe(1);
    await prisma.$executeRaw`UPDATE service_order SET category = 'LABORATORY' WHERE id = ${order}::uuid`;
    await issue(prisma, order);

    for (const change of [
      prisma.$executeRaw`UPDATE service_order SET priority = 'STAT' WHERE id = ${order}::uuid`,
      prisma.$executeRaw`UPDATE service_order SET category = 'IMAGING' WHERE id = ${order}::uuid`,
      prisma.$executeRaw`UPDATE service_order SET clinical_note_text = 'Otra' WHERE id = ${order}::uuid`,
    ]) {
      await expect(change).rejects.toThrow(/service_order_frozen_once_issued/);
    }
  });

  it('ORD-096 las líneas del borrador se quitan y se añaden; las de la orden emitida no', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const order = await aDraft(prisma, scene);

    // Control positivo: en borrador se sustituyen.
    await expect(
      prisma.$executeRaw`DELETE FROM service_order_item WHERE service_order_id = ${order}::uuid`,
    ).resolves.toBe(1);
    await anItem(prisma, scene, order);
    await issue(prisma, order);

    await expect(anItem(prisma, scene, order)).rejects.toThrow(
      /service_order_item_frozen_once_issued/,
    );
    await expect(
      prisma.$executeRaw`DELETE FROM service_order_item WHERE service_order_id = ${order}::uuid`,
    ).rejects.toThrow(/service_order_item_frozen_once_issued/);
    await expect(
      prisma.$executeRaw`UPDATE service_order_item SET test_code = 'EX-OTRO' WHERE service_order_id = ${order}::uuid`,
    ).rejects.toThrow(/service_order_item_frozen_once_issued/);
    // Control positivo: anular una línea emitida (ORD-007) sigue funcionando.
    await expect(
      prisma.$executeRaw`
        UPDATE service_order_item SET status = 'CANCELLED', completed_at = now()
         WHERE service_order_id = ${order}::uuid`,
    ).resolves.toBe(1);
  });

  it('ORD-099 una orden emitida o descartada no vuelve a borrador, y la emitida no se descarta', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const user = await createUser(prisma);
    const issued = await aDraft(prisma, scene);
    const discarded = await aDraft(prisma, scene);
    await issue(prisma, issued);
    await prisma.$executeRaw`
      UPDATE service_order
         SET status = 'DISCARDED', discarded_at = now(), discarded_by_id = ${user.id}::uuid
       WHERE id = ${discarded}::uuid`;

    await expect(
      prisma.$executeRaw`UPDATE service_order SET status = 'DRAFT' WHERE id = ${issued}::uuid`,
    ).rejects.toThrow(/service_order_status_transition/);
    await expect(
      prisma.$executeRaw`UPDATE service_order SET status = 'ISSUED' WHERE id = ${discarded}::uuid`,
    ).rejects.toThrow(/service_order_status_transition/);
    await expect(
      prisma.$executeRaw`
        UPDATE service_order
           SET status = 'DISCARDED', discarded_at = now(), discarded_by_id = ${user.id}::uuid
         WHERE id = ${issued}::uuid`,
    ).rejects.toThrow(/service_order_status_transition/);
  });

  it('ORD-099 descartar exige quién y cuándo', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const order = await aDraft(prisma, scene);

    await expect(
      prisma.$executeRaw`UPDATE service_order SET status = 'DISCARDED' WHERE id = ${order}::uuid`,
    ).rejects.toThrow(/service_order_discard_states_who_and_when/);
  });

  it('ORD-098 nadie se pone número en un borrador, ni se lo cambia a una emitida', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const order = await aDraft(prisma, scene);

    await expect(
      prisma.$executeRaw`UPDATE service_order SET number = 7 WHERE id = ${order}::uuid`,
    ).rejects.toThrow(/service_order_number_immutable/);
    await issue(prisma, order);
    await expect(
      prisma.$executeRaw`UPDATE service_order SET number = 7 WHERE id = ${order}::uuid`,
    ).rejects.toThrow(/service_order_number_immutable/);
    expect(await numberOf(prisma, order)).toBe(1);
  });

  it('ORD-097 cada examen tiene tipo, y lo que ya había es de laboratorio', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    const rows = await prisma.$queryRaw<{ category: string }[]>`
      SELECT category::text FROM exam_definition WHERE id = ${scene.bh.id}::uuid`;

    expect(rows[0]!.category).toBe('LABORATORY');
  });
});
