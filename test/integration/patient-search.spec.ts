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

/**
 * Una cédula sintética con el dígito verificador CALCULADO, nunca copiado.
 *
 * `patient_identifier_cedula_valid` la comprueba en la base, así que un número
 * compuesto a ojo se rechaza al sembrar y la prueba falla por el motivo
 * equivocado.
 */
function cedulaFor(firstNine: string): string {
  const digits = [...firstNine].map(Number);
  const total = digits.reduce((sum, digit, index) => {
    if (index % 2 !== 0) return sum + digit;
    const doubled = digit * 2;
    return sum + (doubled > 9 ? doubled - 9 : doubled);
  }, 0);
  return `${firstNine}${(10 - (total % 10)) % 10}`;
}

/** La cédula de «Ñaupa», la única del registro sembrado. */
const CEDULA_NAUPA = cedulaFor('171234567');

describe('búsqueda y ordenación de pacientes', () => {
  const db = useDatabase();
  let repository: PrismaPatientRepository;
  /** La ficha absorbida por una fusión, que PA-020 mantiene fuera del listado. */
  let fusionadaId: string;

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
          // UN SOLO DOCUMENTO EN TODO EL REGISTRO, y es deliberado: lo que
          // PA-018 comprueba es qué encuentra y qué NO encuentra un prefijo,
          // y con dos cédulas parecidas un fallo se confundiría con un acierto.
          identifiers:
            nombre.familyName === 'Ñaupa'
              ? { create: { type: 'CEDULA', value: CEDULA_NAUPA } }
              : undefined,
        },
      });
    }

    /**
     * PA-020. Una ficha ABSORBIDA por una fusión.
     *
     * Su apellido la pondría la primera del listado ordenado, así que si
     * apareciera se vería en cualquiera de las pruebas de orden de arriba —
     * y ninguna la ve, que es media garantía. La otra media la afirma su
     * propia prueba, en los dos sentidos.
     */
    const superviviente = await prisma.patient.findUniqueOrThrow({
      where: { mrn: 'HC0000000001' },
      select: { id: true },
    });
    const absorbida = await prisma.patient.create({
      data: {
        mrn: 'HC0000000099',
        familyName: 'Abad',
        givenName: 'Aurora',
        sex: 'FEMALE',
        birthDate: new Date('1979-01-15T00:00:00Z'),
        mergedIntoId: superviviente.id,
        mergedAt: new Date('2026-08-17T12:00:00Z'),
      },
      select: { id: true },
    });
    fusionadaId = absorbida.id;
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

  it('PA-017 ordena los apellidos como se archiva en español', async () => {
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

  it('PA-017 DESCENDENTE devuelve realmente el orden inverso', async () => {
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

  it('PA-017 ordena por número de historia en ambos sentidos', async () => {
    const ascendente = await repository.search(criteria('mrn', 'asc'));
    const descendente = await repository.search(criteria('mrn', 'desc'));

    expect(ascendente.items[0]?.mrn).toBe('HC0000000001');
    expect(descendente.items[0]?.mrn).toBe('HC0000000006');
  });

  it('PA-017 ordena por fecha de nacimiento en ambos sentidos', async () => {
    const ascendente = await repository.search(criteria('birthDate', 'asc'));
    const descendente = await repository.search(criteria('birthDate', 'desc'));

    expect(ascendente.items[0]?.familyName).toBe('alvarez');
    expect(descendente.items[0]?.familyName).toBe('Zambrano');
  });

  it('PA-017 ordena TOTALMENTE: cuatro homónimos salen siempre en el mismo orden', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * SIN HOMÓNIMOS, EL DESEMPATE NO SE EJERCITA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Los seis apellidos del fixture son DISTINTOS, así que la comparación por
     * apellido resolvía siempre y `p.id` nunca llegaba a decidir nada: una
     * auditoría por mutación cambió el desempate por `family_name` —que entre
     * homónimos no desempata— y la suite siguió en verde.
     *
     * ⚠️ LOS IDENTIFICADORES SE ESCRIBEN A MANO Y EN DESORDEN. Con `uuidv7()`
     * el id crece con el instante de inserción, así que sembrar en orden haría
     * que el orden por id coincidiera con el del montón y la prueba pasaría
     * con el desempate roto. Se insertan `a3, a1, a4, a2` y se exige `a1..a4`:
     * el único orden que produce eso es el que el desempate declara.
     */
    const HOMONIMOS = [
      { id: '00000000-0000-4000-8000-0000000000a3', mrn: 'HC0000000903' },
      { id: '00000000-0000-4000-8000-0000000000a1', mrn: 'HC0000000901' },
      { id: '00000000-0000-4000-8000-0000000000a4', mrn: 'HC0000000904' },
      { id: '00000000-0000-4000-8000-0000000000a2', mrn: 'HC0000000902' },
    ];

    const prisma = db();
    for (const homonimo of HOMONIMOS) {
      await prisma.patient.create({
        data: {
          id: homonimo.id,
          mrn: homonimo.mrn,
          // MISMO APELLIDO Y MISMO NOMBRE: es el caso real —dos «María
          // Guamán» en el mismo cantón— y el único en el que el desempate
          // decide.
          familyName: 'Guamán',
          givenName: 'María',
          sex: 'FEMALE',
          birthDate: new Date('1992-05-20T00:00:00Z'),
        },
      });
    }

    const esperados = [...HOMONIMOS]
      .map((homonimo) => homonimo.id)
      .sort((a, b) => a.localeCompare(b));

    const listado = await repository.search({
      ...criteria('name', 'asc'),
      pageSize: 20,
    });
    const homonimosListados = listado.items
      .filter((patient) => patient.familyName === 'Guamán')
      .map((patient) => patient.id);

    expect(homonimosListados).toEqual(esperados);

    /**
     * Y AHORA PAGINADO, que es donde el orden parcial hace daño de verdad: con
     * `LIMIT/OFFSET` dos filas equivalentes pueden intercambiarse entre dos
     * consultas, y entonces una sale en dos páginas y otra en ninguna.
     */
    const total = APELLIDOS.length + HOMONIMOS.length;
    const paginas: string[] = [];
    for (let page = 1; page * 2 <= total; page += 1) {
      const { items } = await repository.search({
        ...criteria('name', 'asc'),
        pageSize: 2,
        page,
      });
      expect(items, `página ${page}`).toHaveLength(2);
      paginas.push(...items.map((patient) => patient.id));
    }

    // Ni una fila repetida, ni una perdida...
    expect(new Set(paginas).size).toBe(total);
    // ...y el recorrido paginado es EXACTAMENTE el listado entero, en el mismo
    // orden. Contar filas distintas no basta: dos páginas podrían traer diez
    // ids únicos en un orden que ninguna consulta reproduce.
    expect(paginas).toEqual(listado.items.map((patient) => patient.id));

    // La misma pregunta, dos veces, la misma respuesta: eso es lo que hace
    // utilizable el número de página.
    const repetida = await repository.search({
      ...criteria('name', 'asc'),
      pageSize: 2,
      page: 2,
    });
    expect(repetida.items.map((patient) => patient.id)).toEqual(
      paginas.slice(2, 4),
    );
  });

  it('PA-016 encuentra un apellido escrito sin tilde', async () => {
    // Se teclea «naupa» y se espera encontrar a «Ñaupa». La columna generada
    // guarda la forma sin acentos y la consulta llama a la misma función de la
    // base, así que no hay dos implementaciones que puedan discrepar.
    const { items } = await repository.search({
      ...criteria('name', 'asc'),
      query: 'naupa',
    });

    expect(items.map((p) => p.familyName)).toEqual(['Ñaupa']);
  });

  it('PA-019 encuentra la historia como se dicta, no como se imprime', async () => {
    // `HC0000000003` es lo que hay en la carpeta; en el mostrador se dice «la
    // tres». Exigir el prefijo y los diez dígitos convertía el buscador en un
    // ejercicio de transcripción.
    for (const escrito of ['3', '003', 'HC3', 'hc0000000003', 'HC0000000003']) {
      const { items } = await repository.search({
        ...criteria('name', 'asc'),
        query: escrito,
      });
      expect(
        items.map((p) => p.mrn),
        `buscando «${escrito}»`,
      ).toEqual(['HC0000000003']);
    }
  });

  it('PA-019 la historia se busca EXACTA, no por prefijo', async () => {
    // `1` no debe listar la 1, la 10 y la 100: el número identifica una
    // historia concreta, y un prefijo convertiría el buscador en un listado.
    const { items } = await repository.search({
      ...criteria('name', 'asc'),
      query: '1',
    });
    expect(items.map((p) => p.mrn)).toEqual(['HC0000000001']);
  });

  it('PA-018 encuentra el documento tecleando sólo sus primeros dígitos', async () => {
    // En el mostrador se teclean los primeros dígitos mientras el paciente
    // sigue leyendo la cédula en voz alta. Exigir los diez completos hace que
    // se abandone la búsqueda y se registre un duplicado.
    const { items } = await repository.search({
      ...criteria('name', 'asc'),
      query: CEDULA_NAUPA.slice(0, 4),
    });

    expect(items.map((p) => p.familyName)).toEqual(['Ñaupa']);
  });

  it('PA-018 NO encuentra el documento por un trozo de su interior', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * UN `%valor%` SOBRE DOCUMENTOS CONVIERTE EL BUSCADOR EN UN ORÁCULO.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Es la mitad del requisito que el mínimo de cuatro caracteres NO cubre:
     * cuatro dígitos del INTERIOR de la cédula pasan esa puerta de sobra, y con
     * una coincidencia parcial interna bastaría con recorrer combinaciones para
     * enumerar el registro. El nombre sí va con `%…%` porque no identifica a
     * nadie por sí solo; un documento sí.
     */
    const interior = CEDULA_NAUPA.slice(3, 7);
    expect(interior).toHaveLength(4);

    const { total, items } = await repository.search({
      ...criteria('name', 'asc'),
      query: interior,
    });

    expect(items.map((p) => p.familyName)).toEqual([]);
    expect(total).toBe(0);
  });

  it('PA-020 deja fuera del listado la ficha que absorbió una fusión', async () => {
    // No se borra nunca —documentos impresos siguen citando su número—, pero
    // quien busca en el mostrador no debe tropezar con ella: abrirla lleva a
    // una historia que se corta.
    const listado = await repository.search(criteria('name', 'asc'));

    expect(listado.items.map((p) => p.id)).not.toContain(fusionadaId);
    expect(listado.total).toBe(APELLIDOS.length);
  });

  it('PA-020 la devuelve cuando se piden explícitamente las fusionadas', async () => {
    // «Salvo que se pidan explícitamente» es la otra mitad del requisito, y sin
    // ella la prueba de arriba pasaría igual con la ficha borrada del registro.
    const listado = await repository.search({
      ...criteria('name', 'asc'),
      includeMerged: true,
    });

    expect(listado.items.map((p) => p.id)).toContain(fusionadaId);
    expect(listado.total).toBe(APELLIDOS.length + 1);
  });

  it('PA-018 no busca por documento con menos de cuatro caracteres', async () => {
    // Un prefijo corto sobre documentos convierte el buscador en un oráculo
    // para enumerar el registro.
    const { total } = await repository.search({
      ...criteria('name', 'asc'),
      query: '171',
    });

    expect(total).toBe(0);
  });

  it('PA-009 encuentra al recién nacido por la madre DESPUÉS de fusionar la ficha de ella', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL RECIÉN NACIDO NO PUEDE DESAPARECER PORQUE SU MADRE ESTUVIERA
     * DUPLICADA (PA-009 + PA-055)
     * ═══════════════════════════════════════════════════════════════════════
     *
     * El escenario es corriente, no rebuscado:
     *
     *   1. Alta de la madre → ficha `A`.
     *   2. Alta del recién nacido SIN documento, con `motherPatientId: A`. Es
     *      el caso normal de PA-003 y PA-009: tiene historia clínica veinte
     *      minutos después de nacer y no tendrá cédula en semanas.
     *   3. Admisión descubre que la madre tenía la ficha duplicada y fusiona
     *      `A→B`.
     *
     * Antes de PA-055 el filtro era `p.mother_patient_id = :motherId` a secas,
     * así que `motherId=B` devolvía CERO — y `GET /patients/A` responde 409
     * con el MRN de `B` (PA-045), de modo que NADIE podía llegar a `A`. El
     * neonato quedaba fuera del único camino que lo alcanzaba, se le volvía a
     * registrar, y su historia se partía en dos: el duplicado que PA-009
     * existe para evitar, causado por la operación que existe para arreglarlos.
     *
     * CONTRA POSTGRESQL DE VERDAD, y no puede ser de otra forma: `merged_into_id`
     * y la resolución del `IN` sólo existen en la base. Un doble devolvería lo
     * que se le dijera.
     *
     * Y SE AFIRMAN LOS DOS SENTIDOS. Que `motherId=B` traiga al bebé es la
     * mitad; la otra es que `motherId=A` lo siga trayendo, porque los papeles
     * impresos y las pantallas abiertas siguen citando la ficha absorbida y
     * PA-043 no la borra nunca.
     */
    const prisma = db();

    const madreAbsorbida = await prisma.patient.findUniqueOrThrow({
      where: { mrn: 'HC0000000003' },
      select: { id: true },
    });
    const madreSuperviviente = await prisma.patient.findUniqueOrThrow({
      where: { mrn: 'HC0000000004' },
      select: { id: true },
    });

    const bebe = await prisma.patient.create({
      data: {
        mrn: 'HC0000000098',
        familyName: 'Nuñez',
        givenName: 'Recién nacido',
        sex: 'MALE',
        birthDate: new Date('2026-08-18T00:00:00Z'),
        // SIN NINGÚN DOCUMENTO: es lo que hace del vínculo con la madre el
        // único camino que lleva a esta ficha.
        isProvisional: true,
        motherPatientId: madreAbsorbida.id,
      },
      select: { id: true },
    });

    const porLaMadre = async (motherId: string): Promise<string[]> =>
      (
        await repository.search({ ...criteria('name', 'asc'), motherId })
      ).items.map((p) => p.id);

    // Antes de fusionar: se le encuentra por su madre, que es PA-009 a secas.
    expect(await porLaMadre(madreAbsorbida.id)).toEqual([bebe.id]);
    expect(await porLaMadre(madreSuperviviente.id)).toEqual([]);

    await prisma.patient.update({
      where: { id: madreAbsorbida.id },
      data: {
        mergedIntoId: madreSuperviviente.id,
        mergedAt: new Date('2026-08-18T15:00:00Z'),
      },
    });

    // Y DESPUÉS DE FUSIONAR SIGUE ESTANDO, preguntando por la ficha vigente
    // —que es la única a la que el mostrador puede llegar— y por la absorbida.
    expect(await porLaMadre(madreSuperviviente.id)).toEqual([bebe.id]);
    expect(await porLaMadre(madreAbsorbida.id)).toEqual([bebe.id]);
  });

  it('PA-009 el filtro por madre no arrastra a los hijos de OTRA ficha fusionada', async () => {
    /**
     * La otra mitad de «rompiéndolo»: un filtro que devolviera de más pasaría
     * la prueba de arriba y uniría a los hijos de dos personas distintas —el
     * peor incidente que este módulo puede producir (D-030)—. Así que se
     * afirma que el alcance llega hasta donde llega el enlace y ni un paso
     * más: una tercera ficha fusionada hacia OTRA superviviente no entra.
     */
    const prisma = db();

    const otraMadre = await prisma.patient.findUniqueOrThrow({
      where: { mrn: 'HC0000000005' },
      select: { id: true },
    });
    const otraSuperviviente = await prisma.patient.findUniqueOrThrow({
      where: { mrn: 'HC0000000006' },
      select: { id: true },
    });
    const preguntada = await prisma.patient.findUniqueOrThrow({
      where: { mrn: 'HC0000000002' },
      select: { id: true },
    });

    await prisma.patient.create({
      data: {
        mrn: 'HC0000000097',
        familyName: 'Ozorio',
        givenName: 'Recién nacida',
        sex: 'FEMALE',
        birthDate: new Date('2026-08-18T00:00:00Z'),
        isProvisional: true,
        motherPatientId: otraMadre.id,
      },
    });
    await prisma.patient.update({
      where: { id: otraMadre.id },
      data: {
        mergedIntoId: otraSuperviviente.id,
        mergedAt: new Date('2026-08-18T15:00:00Z'),
      },
    });

    const { items, total } = await repository.search({
      ...criteria('name', 'asc'),
      motherId: preguntada.id,
    });

    expect(items).toEqual([]);
    expect(total).toBe(0);
  });
});
