import { beforeEach, describe, expect, it } from 'vitest';

import { PrismaCatalogRepository } from '../../src/modules/catalogs/infrastructure/prisma-catalog.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';

/**
 * CAT-001: what starts like the typed text comes first.
 *
 * Against real PostgreSQL because the order is SQL: `word_similarity` scores
 * the best-matching WORD, so «Puerto San Miguel» and «San Antonio» tie for
 * «san», and the code tie-break used to put the first one ahead. The codes are
 * chosen so that, without the description-prefix rank, the test fails.
 */
const DAY_MS = 86_400_000;

describe('orden de la búsqueda en catálogos', () => {
  const db = useDatabase();
  let repository: PrismaCatalogRepository;
  let today: Date;

  beforeEach(async () => {
    const prisma = db();
    repository = new PrismaCatalogRepository(
      prisma as unknown as PrismaService,
    );
    today = new Date();
    const since = new Date(today.getTime() - 365 * DAY_MS);

    const system = await prisma.catalogSystem.create({
      data: { code: 'DPA', name: 'División política', hierarchical: false },
    });

    for (const [code, display] of [
      ['100', 'Puerto San Miguel'],
      ['200', 'San Antonio'],
      ['300', 'Santa Rosa'],
      ['400', 'Ambato'],
      // A code that starts with the text still goes before any description.
      ['SAN1', 'Otro lugar'],
    ] as const) {
      await prisma.catalogConcept.create({
        data: { systemId: system.id, code, display, validFrom: since },
      });
    }
  });

  const search = (query: string) =>
    repository.search({
      systemCode: 'DPA',
      query,
      on: today,
      onlySelectable: false,
      parentId: null,
      limit: 20,
    });

  it('CAT-001 pone primero las descripciones que empiezan por lo escrito', async () => {
    const found = (await search('san')).map((concept) => concept.display);

    expect(found).toEqual([
      'Otro lugar',
      'San Antonio',
      'Santa Rosa',
      'Puerto San Miguel',
    ]);
  });

  it('CAT-001 compara el principio sin tildes ni mayúsculas', async () => {
    const found = (await search('SÁN')).map((concept) => concept.display);

    expect(found.indexOf('San Antonio')).toBeLessThan(
      found.indexOf('Puerto San Miguel'),
    );
  });

  it('CAT-001 un «%» o un «_» tecleado es un carácter, no un comodín que sube todo', async () => {
    expect(await search('%%')).toEqual([]);
    // Control positivo: el mismo largo con letras sí encuentra.
    expect((await search('sa')).length).toBeGreaterThan(0);
  });
});
