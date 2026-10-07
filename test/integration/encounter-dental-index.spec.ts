import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import '../../src/modules/encounter/infrastructure/encounter.constraints';
import { PrismaDentalIndexRepository } from '../../src/modules/encounter/infrastructure/prisma-dental-index.repository';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { extractDatabaseProblem } from '../../src/shared/http/database-problem';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * EN-052 (D-160) against a real PostgreSQL: `trg_encounter_dental_index_applies`
 * with the age FROZEN on the attention, the CHECKs on the counts, and the
 * correction versioned in `record_version`.
 *
 * The ages are derived from the attention's own clinical date — never a date
 * written by hand — and chosen away from the edge of a month, so the frozen
 * age is the one named whatever day the suite runs.
 */
const db = useDatabase();

const dentalOf = (prisma: PrismaClient) =>
  new PrismaDentalIndexRepository(prisma as unknown as PrismaService);

/** An attention an hour ago of a patient of exactly that age then. */
async function anAttentionAged(
  prisma: PrismaClient,
  age: { years: number; months?: number },
) {
  const startedAt = new Date(Date.now() - 3_600_000);
  const [y, m, d] = clinicalDateOf(startedAt).split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma, {
    birthDate: new Date(Date.UTC(y - age.years, m - 1 - (age.months ?? 0), d)),
  });
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
    startedAt,
  });
  const author = await createUser(prisma);
  return { encounter, author, query: { encounterId: encounter.id, sites: [site.id] } }; // prettier-ignore
}

type Counts = {
  decayed: number | null;
  extracted: number | null;
  filled: number | null;
  missing: number | null;
};

/** A raw INSERT, the way an import writes. */
function insert(
  prisma: PrismaClient,
  encounterId: string,
  authorId: string,
  counts: Counts,
) {
  return prisma.$executeRaw`
    INSERT INTO encounter_dental_index
      (encounter_id, decayed, extracted, filled, missing, recorded_by_id, recorded_at)
    VALUES (${encounterId}::uuid, ${counts.decayed}::smallint, ${counts.extracted}::smallint,
            ${counts.filled}::smallint, ${counts.missing}::smallint,
            ${authorId}::uuid, ${new Date()})`;
}

async function problemFrom(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    return extractDatabaseProblem(error);
  }
  throw new Error('the operation should have failed');
}

const CEO_D = { decayed: 2, extracted: 1, filled: 3, missing: null };
const CPO_D = { decayed: 4, extracted: null, filled: 6, missing: 1 };
const NOT_APPLICABLE = { status: 422, code: 'DENTAL_INDEX_NOT_APPLICABLE' };

describe('EN-052 el índice CEO-D / CPO-D contra la base', () => {
  it('EN-052 la BASE acepta el CEO-D a los 8 años y el CPO-D a los 30', async () => {
    const prisma = db();
    const child = await anAttentionAged(prisma, { years: 8 });
    const adult = await anAttentionAged(prisma, { years: 30 });

    await insert(prisma, child.encounter.id, child.author.id, CEO_D);
    await insert(prisma, adult.encounter.id, adult.author.id, CPO_D);

    expect(await prisma.encounterDentalIndex.count()).toBe(2);
  });

  it('EN-052 D-160 la BASE rechaza los dos índices a los 11 años, y el CEO-D a los 7 meses sí entra', async () => {
    const prisma = db();
    const eleven = await anAttentionAged(prisma, { years: 11, months: 3 });
    const frozen = await prisma.encounter.findUniqueOrThrow({ where: { id: eleven.encounter.id } }); // prettier-ignore
    expect(frozen.ageYears).toBe(11);

    expect(await problemFrom(insert(prisma, eleven.encounter.id, eleven.author.id, CEO_D))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await problemFrom(insert(prisma, eleven.encounter.id, eleven.author.id, CPO_D))).toMatchObject(NOT_APPLICABLE); // prettier-ignore

    // Positive control: past six months, the CEO-D goes in.
    const baby = await anAttentionAged(prisma, { years: 0, months: 7 });
    await insert(prisma, baby.encounter.id, baby.author.id, CEO_D);
    expect(await prisma.encounterDentalIndex.count()).toBe(1);
  });

  it('EN-052 D-160 la BASE rechaza el CEO-D con 6 meses o menos, y sin edad congelada', async () => {
    const prisma = db();
    const six = await anAttentionAged(prisma, { years: 0, months: 6 });
    const frozen = await prisma.encounter.findUniqueOrThrow({ where: { id: six.encounter.id } }); // prettier-ignore
    // Six months, or a day or two short of them at the end of a month.
    expect(frozen.ageYears).toBe(0);
    expect(frozen.ageMonths! * 31 + frozen.ageDays!).toBeLessThanOrEqual(6 * 31); // prettier-ignore

    expect(await problemFrom(insert(prisma, six.encounter.id, six.author.id, CEO_D))).toMatchObject(NOT_APPLICABLE); // prettier-ignore

    const unknown = await anAttentionAged(prisma, { years: 8 });
    // An attention whose age was never frozen (a row older than EN-008). The
    // age cannot be changed (`trg_encounter_age_frozen`), so the trigger is
    // set aside for this one statement, inside its own transaction.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`ALTER TABLE encounter DISABLE TRIGGER trg_encounter_age_frozen`;
      await tx.$executeRaw`
        UPDATE encounter SET age_years = NULL, age_months = NULL, age_days = NULL
         WHERE id = ${unknown.encounter.id}::uuid`;
      await tx.$executeRaw`ALTER TABLE encounter ENABLE TRIGGER trg_encounter_age_frozen`;
    });
    expect(await problemFrom(insert(prisma, unknown.encounter.id, unknown.author.id, CEO_D))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await prisma.encounterDentalIndex.count()).toBe(0);
  });

  it('EN-052 la BASE rechaza los extraídos en el CPO-D y los perdidos en el CEO-D', async () => {
    const prisma = db();
    const child = await anAttentionAged(prisma, { years: 8 });
    const adult = await anAttentionAged(prisma, { years: 30 });

    expect(await problemFrom(insert(prisma, child.encounter.id, child.author.id, { ...CEO_D, missing: 1 }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await problemFrom(insert(prisma, adult.encounter.id, adult.author.id, { ...CPO_D, extracted: 1 }))).toMatchObject(NOT_APPLICABLE); // prettier-ignore
    expect(await prisma.encounterDentalIndex.count()).toBe(0);

    // Positive control: each with its own counts.
    await insert(prisma, child.encounter.id, child.author.id, CEO_D);
    await insert(prisma, adult.encounter.id, adult.author.id, CPO_D);
    expect(await prisma.encounterDentalIndex.count()).toBe(2);
  });

  it('EN-052 la BASE acota cada cuenta a los dientes que hay: 21 en el CEO-D y 33 en el CPO-D no entran; 20 y 32, sí', async () => {
    const prisma = db();
    const child = await anAttentionAged(prisma, { years: 8 });
    const adult = await anAttentionAged(prisma, { years: 30 });

    expect(await problemFrom(insert(prisma, child.encounter.id, child.author.id, { ...CEO_D, decayed: 21 }))).toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ field: 'decayed' })],
    }); // prettier-ignore
    expect(await problemFrom(insert(prisma, adult.encounter.id, adult.author.id, { ...CPO_D, filled: 33 }))).toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ field: 'filled' })],
    }); // prettier-ignore
    expect(await problemFrom(insert(prisma, adult.encounter.id, adult.author.id, { ...CPO_D, decayed: -1 }))).toMatchObject({ code: 'VALIDATION_FAILED' }); // prettier-ignore

    await insert(prisma, child.encounter.id, child.author.id, { ...CEO_D, decayed: 20 }); // prettier-ignore
    await insert(prisma, adult.encounter.id, adult.author.id, { ...CPO_D, filled: 32 }); // prettier-ignore
    expect(await prisma.encounterDentalIndex.count()).toBe(2);
  });

  it('EN-052 EN-210 corregir deja el índice anterior entero en record_version, y sin sello no se corrige', async () => {
    const prisma = db();
    const adult = await anAttentionAged(prisma, { years: 30 });
    const dental = dentalOf(prisma);

    const first = await dental.save(adult.query, CPO_D, adult.author.id);
    expect(first).toMatchObject({ ...CPO_D, editedAt: null });

    // Without a stamp nobody edits.
    await expect(
      prisma.$executeRaw`UPDATE encounter_dental_index SET decayed = 5 WHERE encounter_id = ${adult.encounter.id}::uuid`,
    ).rejects.toThrow(/record_version_change_is_stamped/);

    const corrected = await dental.save(adult.query, { ...CPO_D, decayed: 5 }, adult.author.id); // prettier-ignore
    expect(corrected.decayed).toBe(5);
    expect(corrected.editedAt).not.toBeNull();
    // The same counts again are not an edit.
    await dental.save(adult.query, { ...CPO_D, decayed: 5 }, adult.author.id);

    const versions = await prisma.recordVersion.findMany({
      where: { resourceType: 'encounter_dental_index', resourceId: adult.encounter.id }, // prettier-ignore
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      changedById: adult.author.id,
      data: expect.objectContaining({ decayed: 4, missing: 1, filled: 6, extracted: null }), // prettier-ignore
    });
  });

  it('EN-052 el adaptador no escribe en una atención con el alta, y sí mientras está viva', async () => {
    const prisma = db();
    const adult = await anAttentionAged(prisma, { years: 30 });
    const dental = dentalOf(prisma);
    // Positive control: alive, it is recorded.
    await dental.save(adult.query, CPO_D, adult.author.id);

    await prisma.encounter.update({
      where: { id: adult.encounter.id },
      data: { status: 'DISCHARGED', endedAt: new Date(), dischargeCondition: 'ALIVE' }, // prettier-ignore
    });
    await expect(
      dental.save(adult.query, { ...CPO_D, decayed: 9 }, adult.author.id),
    ).rejects.toMatchObject({ code: 'ENCOUNTER_ALREADY_CLOSED' });
    expect((await dental.find(adult.query))?.decayed).toBe(4);
  });
});
