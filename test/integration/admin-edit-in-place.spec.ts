import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { seedBilling } from '../../prisma/seed-billing.mts';
import '../../src/shared/http/record-version.constraints';
import { extractDatabaseProblem } from '../../src/shared/http/database-problem';

import { useDatabase } from './setup/database';
import { createUser } from './setup/fixtures';

/**
 * D-127 in administration — what only PostgreSQL can prove.
 *
 * - BI-230: correcting a price amount archives the previous row in
 *   `record_version`, and an unstamped correction is refused. Closing the row
 *   when the next one opens (BI-045) is NOT a correction and needs no stamp.
 * - AD-10 (AU-052, ST-052, OR-033, SP-029, BI-231, ORD-142): the audit
 *   whitelist admits before/after on administrative resources, and still
 *   refuses them on a patient resource.
 *
 * Every refusal has its positive control.
 */
const db = useDatabase();

const minutesAfter = (start: Date, minutes: number) =>
  new Date(start.getTime() + minutes * 60_000);

async function problemFrom(operation: Promise<unknown>) {
  try {
    await operation;
    throw new Error('the operation should have failed');
  } catch (error) {
    return extractDatabaseProblem(error);
  }
}

/** The seeded open-ended PARTICULAR price of a consultation. */
async function aPrice(prisma: PrismaClient) {
  await seedBilling(prisma);
  const service = await prisma.billableService.findUniqueOrThrow({
    where: { code: 'CONS-MG-PV' },
  });
  return prisma.price.findFirstOrThrow({
    where: { billableServiceId: service.id, validTo: null },
  });
}

function priceVersions(prisma: PrismaClient, priceId: string) {
  return prisma.$queryRawUnsafe<
    { version: number; amount: string; changed_by: string }[]
  >(
    `SELECT version, data ->> 'amount' AS amount, changed_by::text AS changed_by
       FROM record_version
      WHERE resource_type = 'price' AND resource_id = $1::uuid
      ORDER BY version`,
    priceId,
  );
}

describe('price: corregir el importe con versión (BI-230)', () => {
  it('BI-230 corregir el importe con sello archiva el anterior, con quién', async () => {
    const prisma = db();
    const price = await aPrice(prisma);
    const admin = await createUser(prisma);
    const before = price.amount.toString();

    await prisma.price.update({
      where: { id: price.id },
      data: {
        amount: '31.50',
        changedById: admin.id,
        changedAt: minutesAfter(new Date(), 1),
      },
    });

    const versions = await priceVersions(prisma, price.id);
    expect(versions).toHaveLength(1);
    expect(Number(versions[0]!.amount)).toBe(Number(before));
    expect(versions[0]!.changed_by).toBe(admin.id);
    const now = await prisma.price.findUniqueOrThrow({
      where: { id: price.id },
    });
    expect(now.amount.toString()).toBe('31.5');
  });

  it('BI-230 rechaza corregir el importe sin sello, y no archiva nada', async () => {
    const prisma = db();
    const price = await aPrice(prisma);

    const unstamped = await problemFrom(
      prisma.price.update({
        where: { id: price.id },
        data: { amount: '31.50' },
      }),
    );
    expect(unstamped).toMatchObject({ code: 'EDIT_NOT_STAMPED', status: 422 });
    expect(await priceVersions(prisma, price.id)).toHaveLength(0);
  });

  it('BI-230 cerrar la vigencia al abrir la siguiente no pide sello ni crea versión', async () => {
    const prisma = db();
    const price = await aPrice(prisma);
    const closesOn = new Date(price.validFrom.getTime() + 30 * 86_400_000);

    await prisma.price.update({
      where: { id: price.id },
      data: { validTo: closesOn },
    });

    expect(await priceVersions(prisma, price.id)).toHaveLength(0);
  });
});

describe('access_audit: antes y después en administración (AD-10)', () => {
  const insert = (prisma: PrismaClient, resourceType: string) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO access_audit (resource_type, resource_id, action, "before", "after")
       VALUES ($1, $2, 'UPDATE', $3::jsonb, $4::jsonb)`,
      resourceType,
      'some-resource-id',
      JSON.stringify({ name: 'antes' }),
      JSON.stringify({ name: 'después' }),
    );

  it.each([
    ['staff', 'ST-052'],
    ['organization', 'OR-033'],
    ['auth', 'AU-052'],
    ['billable_service', 'BI-231'],
    ['billable_service_category', 'BI-231'],
    ['price', 'BI-231'],
    ['payer', 'BI-231'],
    ['exam_definition', 'ORD-142'],
    ['analyte_definition', 'ORD-142'],
    ['configuration', 'SP-029'],
  ])('%s admite el antes y el después (%s)', async (resourceType) => {
    await expect(insert(db(), resourceType)).resolves.toBe(1);
  });

  it('AU-052 sigue rechazando el antes y el después en un recurso de paciente', async () => {
    await expect(insert(db(), 'patient')).rejects.toThrow(
      /access_audit_payload_only_for_declared_resources/,
    );
  });
});
