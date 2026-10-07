import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { importCie10 } from '../../prisma/seed-cie10.mts';
import { PrismaCatalogRepository } from '../../src/modules/catalogs/infrastructure/prisma-catalog.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createDiagnosis,
  createUser,
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * EN-233, EN-234. The WHO's CIE-10 replacing the development list, against a
 * real PostgreSQL: retiring, never deleting, and an attention of before the
 * cut-over still coding with its own edition — which only the database's
 * `valid_period` and `trg_diagnosis_concept_in_force` can prove.
 */
const db = useDatabase();

const catalogOf = (prisma: PrismaClient) =>
  new PrismaCatalogRepository(prisma as unknown as PrismaService);

/** The development edition as a base that has used it holds it. */
async function previousEdition(prisma: PrismaClient) {
  const system = await prisma.catalogSystem.create({
    data: { code: 'CIE10', name: 'CIE-10', hierarchical: true },
  });
  for (const code of ['J02', 'A00']) {
    await prisma.catalogConcept.create({
      data: {
        systemId: system.id,
        code,
        display: `Desarrollo ${code}`,
        validFrom: new Date('2019-01-01'), // fecha-fija: vigente desde siempre
        attributes: { level: 2, chapter: 'X' },
      },
    });
  }
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  await createDiagnosis(prisma, encounter.id, 'J02');
  await createDiagnosis(prisma, encounter.id, 'A00');
  return encounter;
}

describe('the WHO CIE-10 import (EN-233, EN-234)', () => {
  it('EN-233: from the cut-over only WHO codes are offered; the day before, the old edition', async () => {
    const encounter = await previousEdition(db());
    const now = new Date();

    const result = await importCie10(db(), { now });
    const cutover = result.effectiveFrom!;
    const catalog = catalogOf(db());

    // The cut-over is the clinic day after the import.
    expect(cutover.getTime()).toBeGreaterThan(now.getTime() - 86_400_000);

    const pharyngitis = await catalog.findByCode('CIE10', 'J02.9', cutover);
    expect(pharyngitis).toMatchObject({
      code: 'J02.9',
      display: 'Faringitis aguda, no especificada',
      selectable: true,
      chapter: 'J00-J99',
      chapterDisplay: 'Enfermedades del sistema respiratorio',
    });
    expect(await catalog.findByCode('CIE10', 'J02', cutover)).toBeNull();

    const offered = await catalog.search({
      systemCode: 'CIE10',
      query: 'J02',
      on: cutover,
      limit: 10,
      onlySelectable: true,
      parentId: null,
    });
    expect(offered.map((concept) => concept.code)).toEqual(['J02.0', 'J02.8', 'J02.9']); // prettier-ignore

    // Positive control: on the attention's own date the old code still rules.
    expect(
      await catalog.findByCode('CIE10', 'J02', encounter.startedAt),
    ).toMatchObject({ code: 'J02', display: 'Desarrollo J02' });
  });

  it('EN-233: retires the old concepts without deleting one, and their diagnoses can still be corrected', async () => {
    const encounter = await previousEdition(db());
    const before = await db().catalogConcept.count();

    const result = await importCie10(db(), { now: new Date() });

    const old = await db().catalogConcept.findMany({
      where: { code: { in: ['J02', 'A00'] } },
    });
    expect(old).toHaveLength(2);
    for (const concept of old)
      expect(concept.validTo).toEqual(result.effectiveFrom);
    expect(await db().catalogConcept.count()).toBe(before + result.inserted);

    // `trg_diagnosis_concept_in_force` checks the concept against the
    // attention's date, before the cut-over: correcting it still passes.
    const diagnosis = await db().encounterDiagnosis.findFirstOrThrow({
      where: { encounterId: encounter.id, cie10Code: 'J02' },
    });
    await expect(
      db().encounterDiagnosis.update({
        where: { id: diagnosis.id },
        data: {
          note: 'Corregido tras la carga',
          editedById: (await createUser(db())).id,
          editedAt: new Date(),
        },
      }),
    ).resolves.toMatchObject({ conceptId: diagnosis.conceptId });
  });

  it('EN-233: a base with no edition takes the WHO list as in force since always', async () => {
    const result = await importCie10(db(), { now: new Date() });

    expect(result.status).toBe('imported');
    expect(result.inserted).toBe(12_548 + 22);
    expect(result.effectiveFrom!.getUTCFullYear()).toBeLessThan(
      new Date().getUTCFullYear(),
    );
    expect(await importCie10(db(), { now: new Date() })).toMatchObject({
      status: 'unchanged',
      inserted: 0,
    });
  });

  it('EN-234: lists the registered codes the WHO list lacks, with the codes that begin like them', async () => {
    await previousEdition(db());

    const result = await importCie10(db(), { now: new Date() });

    expect(result.missing).toEqual([
      { code: 'A00', proposals: ['A00.0', 'A00.1', 'A00.9'] },
      { code: 'J02', proposals: ['J02.0', 'J02.8', 'J02.9'] },
    ]);
    // Nothing registered was rewritten.
    expect(
      (
        await db().encounterDiagnosis.findMany({ orderBy: { rank: 'asc' } })
      ).map((diagnosis) => diagnosis.cie10Code),
    ).toEqual(['J02', 'A00']);
  });
});
