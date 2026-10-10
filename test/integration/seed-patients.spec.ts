import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedPatients } from '../../prisma/seed-patients.mts';
import { formatMrn } from '../../src/modules/patients/domain/mrn';

import { useDatabase } from './setup/database';

/**
 * The development patient seed, run again over a base that already has data.
 *
 * WHY AGAINST THE BASE. The 10-10-2026 run on the author's base deleted every
 * `patient_identifier` and then had its patient delete refused by the agenda's
 * RESTRICT foreign key: what broke was the order of two statements and a
 * sequence, which only PostgreSQL can show.
 */
const db = useDatabase();

let prisma: PrismaClient;

beforeEach(() => {
  prisma = db();
});

/** Indices 0, 7 and 14 have no document: 12 of 15 carry a cedula. */
const TOTAL = 15;
const WITH_CEDULA = 12;

/** A chart registered at the front desk: its number comes from the sequence. */
async function registerAtDesk(): Promise<number> {
  const [row] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT nextval('patient_mrn_seq') AS n`;
  const number = Number(row!.n);
  const mrn = formatMrn(number);
  await prisma.patient.create({
    data: {
      mrn,
      familyName: 'Mostrador',
      givenName: 'Registrada',
      sex: 'FEMALE',
      birthDate: new Date(),
      isProvisional: true,
    },
  });
  return number;
}

describe('la semilla de pacientes sobre una base con datos', () => {
  it('una segunda corrida no borra ni duplica nada', async () => {
    const first = await seedPatients(prisma, TOTAL);
    // Positive control: the same call does write on an empty base.
    expect(first).toMatchObject({ created: TOTAL, repaired: 0, foreign: 0 });

    const second = await seedPatients(prisma, TOTAL);

    expect(second).toMatchObject({ created: 0, repaired: 0, foreign: 0, skipped: 0 }); // prettier-ignore
    expect(await prisma.patient.count()).toBe(TOTAL);
    expect(await prisma.patientIdentifier.count()).toBe(WITH_CEDULA);
  });

  it('PA-001 la secuencia nunca retrocede por debajo de una historia registrada en pantalla', async () => {
    await seedPatients(prisma, TOTAL);
    const desk = await registerAtDesk();
    // The seeded numbers are behind the desk's, whatever the suite left.
    expect(desk).toBeGreaterThan(TOTAL);

    const again = await seedPatients(prisma, TOTAL);

    expect(again.nextMrn).toBe(formatMrn(desk + 1));
    // And the desk really gets it: the number is free.
    expect(await registerAtDesk()).toBe(desk + 1);
  });

  it('repone la cédula de la historia sembrada que la perdió, y sólo de esa', async () => {
    await seedPatients(prisma, TOTAL);
    const [renamed, taken, ...rest] = await prisma.patient.findMany({
      where: { identifiers: { some: {} } },
      orderBy: { mrn: 'asc' },
      select: { id: true, identifiers: { select: { value: true } } },
    });
    // The damage of the old seed: every identifier gone.
    await prisma.patientIdentifier.deleteMany({});
    // Edited from the screen: no longer the seed's chart.
    await prisma.patient.update({
      where: { id: renamed!.id },
      data: { givenName: 'Otra' },
    });
    // Somebody else registered that cedula meanwhile.
    const holder = await prisma.patient.findFirstOrThrow({
      where: { mrn: formatMrn(1) },
      select: { id: true },
    });
    await prisma.patientIdentifier.create({
      data: {
        patientId: holder.id,
        type: 'CEDULA',
        issuingCountry: 'ECU',
        value: taken!.identifiers[0]!.value,
      },
    });

    const result = await seedPatients(prisma, TOTAL);

    // Positive control: the untouched charts get theirs back.
    expect(result).toMatchObject({ created: 0, repaired: rest.length, foreign: 1 }); // prettier-ignore
    for (const chart of rest) {
      expect(
        await prisma.patientIdentifier.findFirst({
          where: { patientId: chart.id, value: chart.identifiers[0]!.value },
        }),
      ).not.toBeNull();
    }
    expect(await prisma.patientIdentifier.count({ where: { patientId: renamed!.id } })).toBe(0); // prettier-ignore
    expect(await prisma.patientIdentifier.count({ where: { patientId: taken!.id } })).toBe(0); // prettier-ignore
  });
});
