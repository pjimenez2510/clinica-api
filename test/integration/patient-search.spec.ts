import { beforeEach, describe, expect, it } from 'vitest';

import { PrismaPatientRepository } from '../../src/modules/patients/infrastructure/prisma-patient.repository';
import type {
  PatientSearchCriteria,
  PatientSortField,
  SortDirection,
} from '../../src/modules/patients/domain/patient.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';

/**
 * Cómo se ordena y se busca el registro de pacientes.
 *
 * CONTRA POSTGRESQL DE VERDAD, y no puede ser de otra forma: lo que se prueba
 * aquí es la colación española, el índice trigram y la construcción del
 * ORDER BY. Un repositorio simulado devolvería lo que se le dijera y no
 * demostraría nada.
 *
 * Los apellidos están elegidos para que el orden por bytes —el de la colación
 * `C` con la que está creada la base— dé un resultado DISTINTO del correcto.
 * Con nombres como «Perez» y «Ramos» cualquier implementación pasa.
 */
const APELLIDOS = [
  // Minúscula inicial: por bytes cae detrás de todas las mayúsculas.
  { familyName: 'alvarez', givenName: 'Ana' },
  { familyName: 'Bravo', givenName: 'Beatriz' },
  { familyName: 'Nuñez', givenName: 'Nelson' },
  // La Ñ: por bytes va detrás de todo, incluidas las minúsculas.
  { familyName: 'Ñaupa', givenName: 'Nayeli' },
  { familyName: 'Ozorio', givenName: 'Oscar' },
  { familyName: 'Zambrano', givenName: 'Zoila' },
];

describe('búsqueda y ordenación de pacientes', () => {
  const db = useDatabase();
  let repository: PrismaPatientRepository;

  beforeEach(async () => {
    const prisma = db();
    repository = new PrismaPatientRepository(
      prisma as unknown as PrismaService,
    );

    let sequence = 0;
    for (const nombre of APELLIDOS) {
      sequence += 1;
      await prisma.patient.create({
        data: {
          mrn: `HC${String(sequence).padStart(10, '0')}`,
          familyName: nombre.familyName,
          givenName: nombre.givenName,
          sex: 'FEMALE',
          birthDate: new Date(`19${80 + sequence}-01-15T00:00:00Z`),
        },
      });
    }
  });

  const criteria = (
    sortBy: PatientSortField,
    sortDirection: SortDirection,
  ): PatientSearchCriteria => ({
    page: 1,
    pageSize: 20,
    includeMerged: false,
    sortBy,
    sortDirection,
  });

  it('ordena los apellidos como se archiva en español', async () => {
    // Ñ ENTRE N Y O, y la minúscula junto a las mayúsculas. Con la colación de
    // la base —`C`, por bytes— saldría `Bravo, Nuñez, Ozorio, Zambrano,
    // alvarez, Ñaupa`: los Ñaupa al final de la lista, que es un apellido que
    // nadie encuentra.
    const { items } = await repository.search(criteria('name', 'asc'));

    expect(items.map((p) => p.familyName)).toEqual([
      'alvarez',
      'Bravo',
      'Nuñez',
      'Ñaupa',
      'Ozorio',
      'Zambrano',
    ]);
  });

  it('DESCENDENTE devuelve realmente el orden inverso', async () => {
    /**
     * LA REGRESIÓN. El ORDER BY se construía concatenando la dirección al final
     * de una lista de columnas:
     *
     *     ORDER BY p.family_name, p.given_name DESC
     *
     * En SQL la dirección afecta a UNA expresión, no a la lista: eso ordenaba
     * el apellido ascendente y sólo el nombre descendente. Como los apellidos
     * casi siempre difieren, «descendente» devolvía exactamente lo mismo que
     * «ascendente» y la cabecera de la tabla parecía no hacer nada.
     */
    const ascendente = await repository.search(criteria('name', 'asc'));
    const descendente = await repository.search(criteria('name', 'desc'));

    expect(descendente.items.map((p) => p.familyName)).toEqual(
      [...ascendente.items.map((p) => p.familyName)].reverse(),
    );
  });

  it('ordena por número de historia en ambos sentidos', async () => {
    const ascendente = await repository.search(criteria('mrn', 'asc'));
    const descendente = await repository.search(criteria('mrn', 'desc'));

    expect(ascendente.items[0]?.mrn).toBe('HC0000000001');
    expect(descendente.items[0]?.mrn).toBe('HC0000000006');
  });

  it('ordena por fecha de nacimiento en ambos sentidos', async () => {
    const ascendente = await repository.search(criteria('birthDate', 'asc'));
    const descendente = await repository.search(criteria('birthDate', 'desc'));

    expect(ascendente.items[0]?.familyName).toBe('alvarez');
    expect(descendente.items[0]?.familyName).toBe('Zambrano');
  });

  it('pagina sin repetir ni perder filas', async () => {
    // Con `LIMIT/OFFSET` y sin un orden TOTAL, dos filas equivalentes pueden
    // intercambiarse entre consultas: una aparece en dos páginas y otra en
    // ninguna. El desempate por id es lo que lo impide.
    const primera = await repository.search({
      ...criteria('name', 'asc'),
      pageSize: 3,
      page: 1,
    });
    const segunda = await repository.search({
      ...criteria('name', 'asc'),
      pageSize: 3,
      page: 2,
    });

    const ids = [...primera.items, ...segunda.items].map((p) => p.id);
    expect(new Set(ids).size).toBe(APELLIDOS.length);
  });

  it('encuentra un apellido escrito sin tilde', async () => {
    // Se teclea «naupa» y se espera encontrar a «Ñaupa». La columna generada
    // guarda la forma sin acentos y la consulta llama a la misma función de la
    // base, así que no hay dos implementaciones que puedan discrepar.
    const { items } = await repository.search({
      ...criteria('name', 'asc'),
      query: 'naupa',
    });

    expect(items.map((p) => p.familyName)).toEqual(['Ñaupa']);
  });

  it('no busca por documento con menos de cuatro caracteres', async () => {
    // Un prefijo corto sobre documentos convierte el buscador en un oráculo
    // para enumerar el registro.
    const { total } = await repository.search({
      ...criteria('name', 'asc'),
      query: '171',
    });

    expect(total).toBe(0);
  });
});
