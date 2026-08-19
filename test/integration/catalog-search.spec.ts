import { beforeEach, describe, expect, it } from 'vitest';

import { PrismaCatalogRepository } from '../../src/modules/catalogs/infrastructure/prisma-catalog.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';

/**
 * Búsqueda en un catálogo clínico, contra PostgreSQL real.
 *
 * NO PUEDE SER DE OTRA FORMA: lo que se prueba es el índice trigram, la columna
 * generada `search_display` y el rango de vigencia — tres cosas que existen en
 * SQL y no en `schema.prisma`. Un repositorio simulado devolvería lo que se le
 * dijera.
 *
 * Los conceptos están elegidos para cubrir lo que de verdad falla: un capítulo
 * que NO debe poder registrarse, un código retirado, y descripciones con tildes
 * que se teclean sin ellas.
 */
const HOY = new Date('2026-08-08T00:00:00Z');
const AYER_LEJANO = new Date('2015-06-01T00:00:00Z');

describe('búsqueda en catálogos', () => {
  const db = useDatabase();
  let repository: PrismaCatalogRepository;

  beforeEach(async () => {
    const prisma = db();
    repository = new PrismaCatalogRepository(
      prisma as unknown as PrismaService,
    );

    const sistema = await prisma.catalogSystem.create({
      data: {
        code: 'CIE10',
        name: 'Clasificación Internacional de Enfermedades',
        hierarchical: true,
      },
    });

    const desde = new Date('2010-01-01T00:00:00Z');

    // Capítulo: NO diagnosticable.
    const capitulo = await prisma.catalogConcept.create({
      data: {
        systemId: sistema.id,
        code: 'J00-J99',
        display: 'Enfermedades del sistema respiratorio',
        validFrom: desde,
        attributes: { level: 0, chapter: 'J00-J99' },
      },
    });

    // Grupo: tampoco.
    const grupo = await prisma.catalogConcept.create({
      data: {
        systemId: sistema.id,
        code: 'J30-J39',
        display: 'Otras enfermedades de las vías respiratorias superiores',
        parentId: capitulo.id,
        validFrom: desde,
        attributes: { level: 1, chapter: 'J00-J99' },
      },
    });

    const categoria = await prisma.catalogConcept.create({
      data: {
        systemId: sistema.id,
        code: 'J30',
        display: 'Rinitis alérgica y vasomotora',
        parentId: grupo.id,
        validFrom: desde,
        attributes: { level: 2, chapter: 'J00-J99' },
      },
    });

    await prisma.catalogConcept.create({
      data: {
        systemId: sistema.id,
        code: 'J30.1',
        display: 'Rinitis alérgica debida al polen',
        parentId: categoria.id,
        validFrom: desde,
        attributes: { level: 3, chapter: 'J00-J99' },
      },
    });

    await prisma.catalogConcept.create({
      data: {
        systemId: sistema.id,
        code: 'J18.9',
        display: 'Neumonía, no especificada',
        parentId: capitulo.id,
        validFrom: desde,
        attributes: { level: 3, chapter: 'J00-J99' },
      },
    });

    // RETIRADO en 2018: existió, y una historia de 2015 que lo use es válida.
    await prisma.catalogConcept.create({
      data: {
        systemId: sistema.id,
        code: 'J99.8',
        display: 'Trastorno respiratorio en enfermedades clasificadas aparte',
        parentId: capitulo.id,
        validFrom: desde,
        validTo: new Date('2018-12-31T00:00:00Z'),
        attributes: { level: 3, chapter: 'J00-J99' },
      },
    });

    /**
     * UN CATÁLOGO PLANO AL LADO DEL JERÁRQUICO, y las dos ramas de
     * `selectable` ejercidas en la misma suite.
     *
     * Etnia, nacionalidad e identidad de género no tienen capítulos ni grupos:
     * sus conceptos están en el nivel 0 y son exactamente lo que hay que
     * elegir. Filtrando por profundidad sin mirar si el sistema es jerárquico,
     * `/catalogs/ETHNICITY` devolvía SIEMPRE la lista vacía y sin fallar, que
     * es la forma más cara de romperse: el selector aparece vacío y parece que
     * falta sembrar.
     *
     * ⚠️ Se siembra AQUÍ y no con `pnpm db:seed`: qué lista oficial carga cada
     * uno de los tres sistemas es una decisión pendiente (D-034), y lo que esta
     * prueba necesita es un catálogo plano cualquiera.
     */
    const plano = await prisma.catalogSystem.create({
      data: {
        code: 'ETHNICITY',
        name: 'Autoidentificación étnica',
        hierarchical: false,
      },
    });
    await prisma.catalogConcept.create({
      data: {
        systemId: plano.id,
        code: 'MONTUBIO',
        display: 'Montubio/a',
        validFrom: desde,
        // Sin `level`: el `COALESCE` lo lee como 0, que es el caso real de una
        // lista sin jerarquía y el que devolvía lista vacía.
      },
    });
  });

  const buscar = (query: string, extra = {}) =>
    repository.search({
      systemCode: 'CIE10',
      query,
      on: HOY,
      onlySelectable: true,
      parentId: null,
      limit: 20,
      ...extra,
    });

  it('encuentra por código y por sus subcategorías', async () => {
    // Quien teclea «J30» está navegando hacia el código específico que exige el
    // RDACAA, así que tiene que ver la categoría Y lo que cuelga de ella.
    const items = await buscar('J30');
    expect(items.map((c) => c.code)).toEqual(['J30', 'J30.1']);
  });

  it('da igual el punto: J301 y J30.1 son lo mismo', async () => {
    for (const escrito of ['J30.1', 'J301', 'j30.1', ' J30 1 ']) {
      const items = await buscar(escrito);
      expect(
        items.map((c) => c.code),
        `buscando «${escrito}»`,
      ).toContain('J30.1');
    }
  });

  it('encuentra una descripción escrita SIN tildes', async () => {
    // «Neumonía» se teclea «neumonia» todo el tiempo. La columna generada
    // guarda la forma sin acentos y la consulta llama a la misma función.
    const items = await buscar('neumonia');
    expect(items.map((c) => c.code)).toContain('J18.9');
  });

  it('tolera una errata en la descripción', async () => {
    // La similitud trigram es la razón de ser del índice: con un `LIKE` esto
    // no devolvería nada, y quien busca a las once de la mañana con la sala
    // llena escribe así.
    const items = await buscar('nuemonia');
    expect(items.map((c) => c.code)).toContain('J18.9');
  });

  it('NO ofrece capítulos ni grupos como diagnóstico', async () => {
    /**
     * `J00-J99` es un título —«Enfermedades del sistema respiratorio»—, no una
     * enfermedad. Registrarlo produce un dato que el ministerio rechaza, así
     * que la caja de diagnóstico no debe llegar a ofrecerlo.
     */
    const items = await buscar('respiratori');
    expect(items.map((c) => c.code)).not.toContain('J00-J99');
    expect(items.map((c) => c.code)).not.toContain('J30-J39');
  });

  it('sí los ofrece cuando se exploran a propósito', async () => {
    const items = await buscar('respiratori', { onlySelectable: false });
    expect(items.map((c) => c.code)).toContain('J00-J99');
  });

  it('oculta un código retirado, pero sólo desde su retirada', async () => {
    // El caso que no puede fallar: una historia de 2015 con un código retirado
    // en 2018 sigue siendo válida, y su diagnóstico tiene que resolverse.
    expect((await buscar('J99')).map((c) => c.code)).not.toContain('J99.8');

    const entonces = await buscar('J99', { on: AYER_LEJANO });
    expect(entonces.map((c) => c.code)).toContain('J99.8');
  });

  it('marca qué es seleccionable y qué no', async () => {
    const [capitulo] = await buscar('J00-J99', { onlySelectable: false });
    expect(capitulo?.selectable).toBe(false);

    const [hoja] = await buscar('J30.1');
    expect(hoja?.selectable).toBe(true);
  });

  it('en un catálogo PLANO, el concepto de nivel 0 sí es seleccionable', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * LA RAMA QUE `selectable: !hierarchical || nivel >= 2` AÑADIÓ, EJERCIDA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * En un catálogo jerárquico el nivel 0 es un título de navegación; en uno
     * plano es el dato. Sin esta prueba la rama nueva no la ejercía nadie, y su
     * fallo —la lista entera declarada no elegible— sale como un combobox vacío
     * que parece falta de siembra.
     *
     * Y el otro lado del mismo condicional: `hierarchical` es `@default(false)`,
     * así que una fila `CIE10` que se quedara en `false` haría diagnosticable
     * TODO capítulo de la CIE-10. Los dos sembradores fijan ahora la bandera
     * también al actualizar, y la prueba de arriba es la que lo delataría.
     */
    const items = await repository.search({
      systemCode: 'ETHNICITY',
      query: 'montubio',
      on: HOY,
      onlySelectable: true,
      parentId: null,
      limit: 20,
    });

    expect(items.map((c) => c.code)).toEqual(['MONTUBIO']);
    expect(items[0]?.level).toBe(0);
    expect(items[0]?.selectable).toBe(true);
  });

  it('devuelve la cadena de ancestros de capítulo a padre', async () => {
    const [hoja] = await buscar('J30.1');
    const ancestros = await repository.ancestorsOf(hoja!.id);

    // De más general a más específico: es el orden en que se lee una miga de
    // pan, y el que sitúa el código en su rama.
    expect(ancestros.map((a) => a.code)).toEqual(['J00-J99', 'J30-J39', 'J30']);
  });

  it('resuelve un código por su forma exacta', async () => {
    const concepto = await repository.findByCode('CIE10', 'J301', HOY);
    expect(concepto?.code).toBe('J30.1');
    expect(concepto?.display).toBe('Rinitis alérgica debida al polen');
  });

  it('no resuelve un código fuera de vigencia', async () => {
    expect(await repository.findByCode('CIE10', 'J99.8', HOY)).toBeNull();
    expect(
      (await repository.findByCode('CIE10', 'J99.8', AYER_LEJANO))?.code,
    ).toBe('J99.8');
  });

  it('una búsqueda vacía no devuelve el catálogo entero', async () => {
    // Sin esto, una caja de búsqueda recién abierta pediría catorce mil filas.
    expect(await buscar('   ')).toEqual([]);
  });
});
