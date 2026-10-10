import { beforeEach, describe, expect, it } from 'vitest';

import { PrismaPatientRepository } from '../../src/modules/patients/infrastructure/prisma-patient.repository';
import type { PatientSearchCriteria } from '../../src/modules/patients/domain/patient.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';

/**
 * PA-070. Several words find the chart whatever their order.
 *
 * AGAINST REAL POSTGRESQL: what is tested is what `search_name` stores (given
 * names first, accents stripped by `immutable_unaccent`) and how the query
 * meets it. A fake repository would answer whatever it was told.
 *
 * The negative control shares ONE word with the target («Juan»): a query that
 * matched any word instead of all of them would return it and fail here.
 */
const THIRTY_YEARS_MS = 30 * 365 * 24 * 60 * 60 * 1000;

const CHARTS = [
  { mrn: 'HC0000000701', givenName: 'Juan', familyName: 'Pérez' },
  { mrn: 'HC0000000702', givenName: 'Juan', familyName: 'Gómez' },
  { mrn: 'HC0000000703', givenName: 'María', familyName: 'Pérez' },
];

describe('PA-070 búsqueda por varias palabras', () => {
  const db = useDatabase();
  let repository: PrismaPatientRepository;

  beforeEach(async () => {
    const prisma = db();
    repository = new PrismaPatientRepository(
      prisma as unknown as PrismaService,
    );
    // Derived from the clock, never written by hand: the age plays no part
    // here, only that the date is a valid past one.
    const birthDate = new Date(Date.now() - THIRTY_YEARS_MS);
    for (const chart of CHARTS) {
      await prisma.patient.create({
        data: { ...chart, sex: 'MALE', birthDate },
      });
    }
  });

  const search = (query: string): PatientSearchCriteria => ({
    query,
    page: 1,
    pageSize: 20,
    includeMerged: false,
    sortBy: 'name',
    sortDirection: 'asc',
  });

  const mrnsFor = async (query: string): Promise<string[]> =>
    (await repository.search(search(query))).items.map((p) => p.mrn);

  it('PA-070 encuentra a Juan Pérez con el apellido primero y sin tildes', async () => {
    expect(await mrnsFor('perez juan')).toEqual(['HC0000000701']);
  });

  it('PA-070 encuentra a Juan Pérez con el nombre primero', async () => {
    expect(await mrnsFor('Juan Pérez')).toEqual(['HC0000000701']);
  });

  it('PA-070 NO devuelve la ficha a la que le falta una de las palabras', async () => {
    // Control: each word alone does find both charts that carry it.
    expect(await mrnsFor('juan')).toEqual(['HC0000000702', 'HC0000000701']);
    expect(await mrnsFor('pere')).toHaveLength(2);
    // Both words: only the chart that has both.
    expect(await mrnsFor('juan gom')).toEqual(['HC0000000702']);
    expect(await mrnsFor('gomez maria')).toEqual([]);
  });

  it('PA-070 cuenta el total con el mismo filtro que la página', async () => {
    const page = await repository.search(search('  perez   maria '));
    expect(page.items.map((p) => p.mrn)).toEqual(['HC0000000703']);
    expect(page.total).toBe(1);
  });
});
