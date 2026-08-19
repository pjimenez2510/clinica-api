import { beforeEach, describe, expect, it } from 'vitest';

import { seedCountries } from '../../prisma/seed-countries.mts';
import { PrismaCatalogRepository } from '../../src/modules/catalogs/infrastructure/prisma-catalog.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';

/**
 * Recorrer el catálogo por niveles, contra PostgreSQL real.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ SE PRUEBA AQUÍ Y NO SE PUEDE PROBAR EN OTRO SITIO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Tres cosas que viven en la base y sólo en la base: la colación española
 * —sin ella `Ñ` cae detrás de todo, incluidas las minúsculas—, el rango de
 * vigencia generado, y el recorrido recursivo por `parent_id` que acota una
 * búsqueda a una rama. Un repositorio simulado devolvería lo que se le dijera y
 * el orden sería el del array que escribió la prueba.
 *
 * El árbol es el del DPA porque es el que tiene el problema de verdad: 1401
 * parroquias que no caben en una búsqueda de 50 filas, y una persona que sabe
 * su provincia y su cantón mucho antes que el nombre exacto de su parroquia.
 */
const HOY = new Date('2026-08-08T00:00:00Z');
const ANTES = new Date('2015-06-01T00:00:00Z');
const DESDE = new Date('2010-01-01T00:00:00Z');

/**
 * Las 24 provincias del DPA con su código y su nombre.
 *
 * Datos públicos del clasificador del INEC, no de ninguna persona. Están las 24
 * y no tres de mentira porque lo que se comprueba es que las raíces del
 * catálogo SON las provincias — y un total de 24 sólo significa algo si hay 24.
 */
const PROVINCIAS: readonly (readonly [string, string])[] = [
  ['01', 'Azuay'],
  ['02', 'Bolívar'],
  ['03', 'Cañar'],
  ['04', 'Carchi'],
  ['05', 'Cotopaxi'],
  ['06', 'Chimborazo'],
  ['07', 'El Oro'],
  ['08', 'Esmeraldas'],
  ['09', 'Guayas'],
  ['10', 'Imbabura'],
  ['11', 'Loja'],
  ['12', 'Los Ríos'],
  ['13', 'Manabí'],
  ['14', 'Morona Santiago'],
  ['15', 'Napo'],
  ['16', 'Pastaza'],
  ['17', 'Pichincha'],
  ['18', 'Tungurahua'],
  ['19', 'Zamora Chinchipe'],
  ['20', 'Galápagos'],
  ['21', 'Sucumbíos'],
  ['22', 'Orellana'],
  ['23', 'Santo Domingo de los Tsáchilas'],
  ['24', 'Santa Elena'],
];

describe('recorrer un catálogo por niveles', () => {
  const db = useDatabase();
  let repository: PrismaCatalogRepository;
  /** Id del concepto, por su código. Las pruebas hablan en códigos. */
  let idDe: Map<string, string>;

  beforeEach(async () => {
    const prisma = db();
    repository = new PrismaCatalogRepository(
      prisma as unknown as PrismaService,
    );
    idDe = new Map();

    const dpa = await prisma.catalogSystem.create({
      data: {
        code: 'DPA',
        name: 'División Política Administrativa del Ecuador (INEC)',
        hierarchical: true,
      },
    });

    const crear = async (
      code: string,
      display: string,
      nivel: number,
      padre: string | null,
      validTo: Date | null = null,
    ): Promise<void> => {
      const fila = await prisma.catalogConcept.create({
        data: {
          systemId: dpa.id,
          code,
          display,
          parentId: padre === null ? undefined : idDe.get(padre),
          validFrom: DESDE,
          validTo,
          attributes: { level: nivel, chapter: code.slice(0, 2) },
        },
      });
      idDe.set(code, fila.id);
    };

    for (const [code, nombre] of PROVINCIAS) await crear(code, nombre, 0, null);

    // Dos cantones de Pichincha y uno de Guayas, para tener más de una rama.
    await crear('1701', 'Quito', 1, '17');
    await crear('1702', 'Cayambe', 1, '17');
    await crear('0901', 'Guayaquil', 1, '09');

    /**
     * Parroquias de Quito elegidas por lo que ordenan, no por lo que son.
     *
     * `Ñucanchi Llacta` es una parroquia real de Orellana; aquí cuelga de Quito
     * porque lo que importa es dónde cae la `Ñ` entre `Nono` y `Olmedo`. Con la
     * colación `C` de la base cae detrás de las dos.
     */
    await crear('170150', 'Nono', 2, '1701');
    await crear('170151', 'Ñucanchi Llacta', 2, '1701');
    await crear('170152', 'Olmedo', 2, '1701');
    await crear('170153', 'Santa Prisca', 2, '1701');
    // RETIRADA en 2018: existió, y una ficha de 2015 sigue siendo válida.
    await crear('170154', 'Santa Bárbara', 2, '1701', new Date('2018-12-31'));

    await crear('090150', 'Santa Rosa', 2, '0901');
  });

  const criterios = { on: HOY, limit: 100, offset: 0 };

  // -------------------------------------------------------------------------
  // Las raíces y los hijos
  // -------------------------------------------------------------------------

  it('las raíces del DPA son las 24 provincias, y ninguna otra cosa', async () => {
    // El caso que motiva la ruta: el primer desplegable de la pantalla de
    // residencia se llena sin que nadie teclee nada.
    const pagina = await repository.rootsOf('DPA', criterios);

    expect(pagina.total).toBe(24);
    expect(pagina.items).toHaveLength(24);
    // Ni cantones ni parroquias: las raíces son las que no tienen padre.
    expect(pagina.items.every((c) => c.code.length === 2)).toBe(true);
  });

  it('los cantones de una provincia son sus hijos, y sólo los suyos', async () => {
    const pagina = await repository.childrenOf(idDe.get('17')!, criterios);

    expect(pagina.items.map((c) => c.code)).toEqual(['1702', '1701']);
    expect(pagina.total).toBe(2);
    // Guayaquil cuelga de Guayas y no puede aparecer aquí.
    expect(pagina.items.map((c) => c.code)).not.toContain('0901');
  });

  it('las parroquias de un cantón son las que se pueden elegir', async () => {
    const pagina = await repository.childrenOf(idDe.get('1701')!, criterios);

    expect(pagina.total).toBe(4);
    // `selectable` es lo que la pantalla mira para saber qué se guarda: en el
    // DPA una provincia es navegación y una parroquia es la residencia.
    expect(pagina.items.every((c) => c.selectable)).toBe(true);
  });

  it('una provincia no se ofrece como residencia aunque se pueda abrir', async () => {
    const raices = await repository.rootsOf('DPA', criterios);
    expect(raices.items.every((c) => c.selectable)).toBe(false);
  });

  it('el capítulo de una parroquia llega resuelto a nombre de provincia', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * ADR-005 §5. «17» NO LE DICE NADA A NADIE, Y ES LO QUE DESAMBIGUABA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * El capítulo está en el contrato para distinguir dos conceptos de texto
     * parecido —y en el DPA los hay: dos parroquias pueden llamarse igual en
     * provincias distintas—. Con el código a secas no distingue nada: quien lee
     * la lista no sabe que `17` es Pichincha.
     *
     * SE RESUELVE AL CONSULTAR Y NO AL SEMBRAR, y ésa es la parte que esta
     * prueba fija: guardar el nombre en `attributes` obligaría a resembrar cada
     * catálogo ya cargado —14 498 conceptos de la CIE-10 que son destino de
     * claves foráneas— y congelaría el nombre de una provincia renombrada en la
     * siguiente edición. El código sigue viajando entero.
     */
    const pagina = await repository.childrenOf(idDe.get('1701')!, criterios);

    expect(pagina.items[0]).toMatchObject({
      chapter: '17',
      chapterDisplay: 'Pichincha',
    });
    expect(pagina.items.every((c) => c.chapterDisplay === 'Pichincha')).toBe(
      true,
    );
  });

  it('una hoja no tiene hijos, y eso no es un error', async () => {
    const pagina = await repository.childrenOf(idDe.get('170150')!, criterios);

    expect(pagina.items).toEqual([]);
    expect(pagina.total).toBe(0);
  });

  // -------------------------------------------------------------------------
  // El orden, que es la mitad de que una lista sirva
  // -------------------------------------------------------------------------

  it('ordena por nombre con colación española: la Ñ va entre la N y la O', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * SIN ESTO, LAS PARROQUIAS CON Ñ ESTÁN AL FINAL DE LA LISTA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * La base está creada con colación `C`, que ordena por byte: `Ñ` es 0xD1 en
     * Latin-1 y cae detrás de todas las mayúsculas Y de todas las minúsculas.
     * En una lista de 65 parroquias, la que empieza por Ñ aparece después de
     * las que empiezan por Z, que es donde nadie la busca. En Ecuador no es un
     * caso raro.
     */
    const pagina = await repository.childrenOf(idDe.get('1701')!, criterios);

    expect(pagina.items.map((c) => c.display)).toEqual([
      'Nono',
      'Ñucanchi Llacta',
      'Olmedo',
      'Santa Prisca',
    ]);
  });

  // -------------------------------------------------------------------------
  // Vigencia y paginación
  // -------------------------------------------------------------------------

  it('no ofrece una parroquia retirada, pero sí la ofrecía entonces', async () => {
    // Mismo criterio que la búsqueda: elegir residencia HOY no puede ofrecer lo
    // que el INEC retiró, y una ficha de 2015 tiene que seguir resolviéndose.
    const hoy = await repository.childrenOf(idDe.get('1701')!, criterios);
    expect(hoy.items.map((c) => c.display)).not.toContain('Santa Bárbara');
    expect(hoy.total).toBe(4);

    const entonces = await repository.childrenOf(idDe.get('1701')!, {
      ...criterios,
      on: ANTES,
    });
    expect(entonces.items.map((c) => c.display)).toContain('Santa Bárbara');
    expect(entonces.total).toBe(5);
  });

  it('el total no depende de la página, que es para lo que sirve', async () => {
    /**
     * LA CARENCIA QUE ORIGINA TODO ESTO: la búsqueda devuelve como mucho 50
     * filas y no dice cuántas hay, así que quien no encuentra la suya no sabe
     * si es que no existe o si es que no cupo. Aquí el cliente sabe siempre que
     * le faltan filas y puede pedirlas.
     */
    const primera = await repository.rootsOf('DPA', {
      ...criterios,
      limit: 10,
    });
    expect(primera.items).toHaveLength(10);
    expect(primera.total).toBe(24);

    const tercera = await repository.rootsOf('DPA', {
      ...criterios,
      limit: 10,
      offset: 20,
    });
    expect(tercera.items).toHaveLength(4);
    expect(tercera.total).toBe(24);

    // Una página más allá del final sigue diciendo cuántas hay. Con un
    // `COUNT(*) OVER ()` esto respondería total 0 —el total viaja en las filas,
    // y aquí no hay filas— y el cliente concluiría que la lista está vacía.
    const cuarta = await repository.rootsOf('DPA', {
      ...criterios,
      limit: 10,
      offset: 30,
    });
    expect(cuarta.items).toEqual([]);
    expect(cuarta.total).toBe(24);
  });

  // -------------------------------------------------------------------------
  // Buscar dentro de una rama
  // -------------------------------------------------------------------------

  it('acota la búsqueda a una rama, y alcanza a los nietos', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * TODA LA DESCENDENCIA, NO LOS HIJOS DIRECTOS.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Una parroquia es NIETA de una provincia. Acotando por hijos directos,
     * «Santa dentro de Pichincha» devolvería cantones —y con `onlySelectable`,
     * que es el valor por defecto, la lista vacía—: exactamente lo contrario de
     * lo que se pidió.
     */
    const enPichincha = await repository.search({
      systemCode: 'DPA',
      query: 'Santa',
      on: HOY,
      onlySelectable: true,
      parentId: idDe.get('17')!,
      limit: 20,
    });
    expect(enPichincha.map((c) => c.display)).toEqual(['Santa Prisca']);

    // La misma búsqueda acotada al OTRO lado del árbol da la otra parroquia, y
    // eso es lo que demuestra que el filtro filtra.
    const enGuayas = await repository.search({
      systemCode: 'DPA',
      query: 'Santa',
      on: HOY,
      onlySelectable: true,
      parentId: idDe.get('09')!,
      limit: 20,
    });
    expect(enGuayas.map((c) => c.display)).toEqual(['Santa Rosa']);
  });

  it('sin rama busca en todo el catálogo', async () => {
    const todas = await repository.search({
      systemCode: 'DPA',
      query: 'Santa',
      on: HOY,
      onlySelectable: true,
      parentId: null,
      limit: 20,
    });

    expect(todas.map((c) => c.display).sort()).toEqual([
      'Santa Prisca',
      'Santa Rosa',
    ]);
  });

  it('la rama no incluye al propio padre', async () => {
    // Quien busca DENTRO del cantón Quito no está buscando el cantón Quito.
    const dentroDeQuito = await repository.search({
      systemCode: 'DPA',
      query: 'Quito',
      on: HOY,
      onlySelectable: false,
      parentId: idDe.get('1701')!,
      limit: 20,
    });

    expect(dentroDeQuito).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // El catálogo de países: plano, y por eso sus raíces son la lista entera
  // -------------------------------------------------------------------------

  describe('el catálogo de países', () => {
    beforeEach(async () => {
      await seedCountries(db());
    });

    it('siembra los 249 países con su alpha-3 y su nombre', async () => {
      /**
       * ═════════════════════════════════════════════════════════════════════
       * PARA QUE NADIE TENGA QUE TECLEAR «ECU».
       * ═════════════════════════════════════════════════════════════════════
       *
       * `patient_identifier.issuing_country` sigue guardando alpha-3 — es lo
       * que viaja al ministerio— pero la PREGUNTA deja de ser un código. El
       * formulario pedía «tres letras: ECU, COL, VEN», y en el mostrador eso
       * acaba en un código inventado o en una ficha provisional creada para
       * poder seguir: el duplicado que PA-015 existe para evitar.
       */
      const pagina = await repository.rootsOf('COUNTRY', {
        on: HOY,
        limit: 500,
        offset: 0,
      });

      expect(pagina.total).toBe(249);

      const porCodigo = new Map(pagina.items.map((c) => [c.code, c.display]));
      expect(porCodigo.get('ECU')).toBe('Ecuador');
      expect(porCodigo.get('COL')).toBe('Colombia');
      expect(porCodigo.get('PER')).toBe('Perú');
      // El artículo protocolario entre paréntesis se quita —«Ecuador (el)»—,
      // pero el nombre entre paréntesis NO: eso es cómo se llama el país.
      expect(porCodigo.get('VEN')).toBe('Venezuela (República Bolivariana de)');
    });

    it('en una lista plana todo es elegible, y viene ordenada por nombre', async () => {
      // Un país no cuelga de nada: `hierarchical` en `false` es lo que hace que
      // sus 249 conceptos de nivel 0 sean seleccionables en vez de leerse como
      // títulos de navegación, que dejaría el selector vacío.
      const pagina = await repository.rootsOf('COUNTRY', {
        on: HOY,
        limit: 500,
        offset: 0,
      });

      expect(pagina.items.every((c) => c.selectable)).toBe(true);
      expect(pagina.items[0]?.display).toBe('Afganistán');
      expect(pagina.items.at(-1)?.display).toBe('Zimbabwe');
    });

    it('sembrar dos veces no duplica nada', async () => {
      // La release con su checksum es la que decide, y por eso `seed.mts` puede
      // llamarla en cada `pnpm db:reset` sin pensarlo.
      await seedCountries(db());

      const pagina = await repository.rootsOf('COUNTRY', {
        on: HOY,
        limit: 500,
        offset: 0,
      });
      expect(pagina.total).toBe(249);
    });

    it('deja constancia de qué archivo produjo las filas', async () => {
      // Provenance, no versionado: cuando la ONU republique la lista bajo el
      // mismo número, el checksum es lo que lo delata.
      const release = await db().catalogRelease.findFirstOrThrow({
        where: { system: { code: 'COUNTRY' } },
      });

      expect(release.version).toBe('un-m49-2024');
      expect(release.sourceUrl).toBe(
        'https://unstats.un.org/unsd/methodology/m49/',
      );
      expect(release.sourceChecksum).toBe(
        '3abcc223f2812daea07f3ecc0127dc64259f8d3a444d0af8a9db427c48232333',
      );
    });
  });
});
