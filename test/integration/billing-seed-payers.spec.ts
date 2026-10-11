import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedBilling } from '../../prisma/seed-billing.mts';

import { useDatabase } from './setup/database';

/**
 * BI-300 (D-229 §2). The public network is born inactive: the clinic switches
 * it on when it signs with it, and until then neither its price columns nor
 * the «Código MSP» show. Against the real seed.
 */
const db = useDatabase();

let prisma: PrismaClient;

beforeEach(() => {
  prisma = db();
});

const payers = async () =>
  Object.fromEntries(
    (await prisma.payer.findMany({ select: { code: true, active: true } })).map(
      (payer) => [payer.code, payer.active],
    ),
  );

describe('BI-300 los pagadores de arranque', () => {
  it('BI-300 IESS, ISSFA, ISSPOL y MSP nacen inactivos; el particular y los convenios de ejemplo, activos (control)', async () => {
    await seedBilling(prisma);

    expect(await payers()).toEqual({
      PARTICULAR: true,
      IESS: false,
      ISSFA: false,
      ISSPOL: false,
      MSP: false,
      'SEGURO-PRIVADO-EJEMPLO': true,
      'CONVENIO-EMPRESA-EJEMPLO': true,
    });
  });

  it('BI-300 sembrar de nuevo no apaga la red pública que la clínica activó', async () => {
    await seedBilling(prisma);
    await prisma.payer.update({
      where: { code: 'IESS' },
      data: { active: true },
    });

    await seedBilling(prisma);

    expect((await payers()).IESS).toBe(true);
    expect((await payers()).ISSFA).toBe(false);
  });
});
