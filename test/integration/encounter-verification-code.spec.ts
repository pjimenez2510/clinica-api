import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * EN-219. The code the printed summary of an attention is verified with
 * (DOC-112), against PostgreSQL: the database puts it, it is unique and it
 * does not change.
 */
const db = useDatabase();

describe('el código de verificación de la atención contra PostgreSQL', () => {
  it('EN-219 cada atención nace con su código aleatorio, distinto del de otra', async () => {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);
    const scene = { siteId: site.id, practitionerId: practitioner.id, patientId: patient.id }; // prettier-ignore

    const first = await createEncounter(prisma, scene);
    const second = await createEncounter(prisma, scene);
    const codes = await prisma.encounter.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { verificationCode: true },
    });

    expect(codes).toHaveLength(2);
    expect(codes.every((row) => /^[0-9A-F]{16}$/.test(row.verificationCode))).toBe(true); // prettier-ignore
    expect(codes[0]!.verificationCode).not.toBe(codes[1]!.verificationCode);
  });

  it('EN-219 la base no deja cambiarlo ni repetirlo; otra columna de la atención sí cambia (control positivo)', async () => {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);
    const scene = { siteId: site.id, practitionerId: practitioner.id, patientId: patient.id }; // prettier-ignore
    const first = await createEncounter(prisma, scene);
    const { verificationCode } = await prisma.encounter.findUniqueOrThrow({
      where: { id: first.id },
      select: { verificationCode: true },
    });

    await expect(
      prisma.$executeRaw`UPDATE "encounter" SET "verification_code" = 'ABCDEF0123456789' WHERE "id" = ${first.id}::uuid`,
    ).rejects.toThrow(/EN-219/);
    await expect(
      prisma.encounter.create({
        data: {
          ...scene,
          startedAt: new Date(),
          careModality: 'MORBIDITY',
          visitSequence: 'SUBSEQUENT',
          verificationCode,
        },
      }),
    ).rejects.toThrow(/verification_code|Unique constraint/i);

    await prisma.encounter.update({
      where: { id: first.id },
      data: {
        medicoDelBarrio: true,
        correctedById: await correctorId(prisma),
        correctedAt: new Date(),
      },
    });
  });
});

/**
 * The stamp a correction of the attention's coding demands
 * (`trg_encounter_record_version`): the positive controls above change
 * `medico_del_barrio`, a column of the attention the frozen ones do not cover.
 */
async function correctorId(prisma: PrismaClient): Promise<string> {
  return (await createUser(prisma)).id;
}
