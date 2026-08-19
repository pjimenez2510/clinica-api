import { beforeEach, describe, expect, it } from 'vitest';

import { seedRdacaa } from '../../prisma/seed-rdacaa.mts';
import { PrismaCatalogRepository } from '../../src/modules/catalogs/infrastructure/prisma-catalog.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';

/**
 * Los tres catálogos planos de la ficha del RDACAA, sembrados de verdad.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * QUÉ SE PRUEBA AQUÍ Y NO SE PUEDE PROBAR EN OTRO SITIO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Que el sembrador deja el catálogo USABLE y con LOS CÓDIGOS DEL MINISTERIO.
 * Los códigos no son decoración: son lo que viaja en el reporte mensual, y una
 * lista completa con el código equivocado no falla en ningún sitio — se
 * descubre cuando el ministerio devuelve el reporte.
 *
 * Que sustituir una lista RETIRA la anterior en vez de borrarla, que es lo que
 * permite que una ficha registrada antes siga resolviendo la categoría con la
 * que se registró.
 *
 * Y que sembrar dos veces no duplica nada, que es lo que permite llamarlo desde
 * `seed.mts` en cada `pnpm db:reset` sin pensarlo.
 */

/**
 * El día desde el que esta base sirve las listas del instructivo.
 *
 * ES LA FECHA DE VIGENCIA DE LA RELEASE, no una cualquiera: con un día antes
 * las tres listas salen vacías —correctamente, porque entonces regía la
 * anterior— y las pruebas parecerían decir que el sembrador no siembra.
 */
const VIGENTE_DESDE = new Date('2026-08-19T00:00:00Z');

/** El día anterior al corte, cuando aún regía la lista del INEC. */
const LA_VISPERA = new Date('2026-08-18T00:00:00Z');

const VERSION = 'msp-rdacaa-2.0-2019';

describe('los catálogos del RDACAA', () => {
  const db = useDatabase();
  let repository: PrismaCatalogRepository;

  beforeEach(async () => {
    repository = new PrismaCatalogRepository(db() as unknown as PrismaService);
    await seedRdacaa(db());
  });

  const criterios = { on: VIGENTE_DESDE, limit: 500, offset: 0 };

  it('siembra las nueve categorías de autoidentificación étnica de la columna 12', async () => {
    /**
     * ⚠️ EL `8` ES «NO SABE / NO RESPONDE» Y EL `98` ES «OTRO/A». Ésta es la
     * aserción que existe por un error real: la lista sembrada el 17-08-2026
     * salía del censo del INEC y usaba el `8` para «Otro/a», así que una ficha
     * registrada como «Otro/a» se habría reportado al ministerio como «No
     * sabe» sin que nada fallara. El instructivo separa las dos.
     *
     * NUEVE Y NO SEIS: el INEC agrupa afroecuatoriano, negro y mulato al
     * publicar; el formulario del RDACAA pregunta por las nueve y agrupar es
     * trabajo de la capa de exportación, no del registro.
     */
    const pagina = await repository.rootsOf('ETHNICITY', criterios);

    expect(pagina.total).toBe(9);
    const porCodigo = new Map(pagina.items.map((c) => [c.code, c.display]));
    expect(porCodigo.get('1')).toBe('Indígena');
    expect(porCodigo.get('2')).toBe('Afroecuatoriano/a Afrodescendiente');
    expect(porCodigo.get('3')).toBe('Negro/a');
    expect(porCodigo.get('4')).toBe('Mulato/a');
    expect(porCodigo.get('5')).toBe('Montubio/a');
    expect(porCodigo.get('6')).toBe('Mestizo/a');
    expect(porCodigo.get('7')).toBe('Blanco/a');
    expect(porCodigo.get('8')).toBe('No sabe / No responde');
    expect(porCodigo.get('98')).toBe('Otro/a');
  });

  it('siembra las dieciséis nacionalidades indígenas de la columna 13, y ningún país', async () => {
    /**
     * COLUMNA 13, «Nacionalidades», la que el instructivo aplica «únicamente
     * para la autoidentificación "indígena"» — la condición que hace cumplir
     * PA-027.
     *
     * NO ES LA COLUMNA 11. Ésa se llama «Nacionalidad», en singular, y es el
     * PAÍS DE ORIGEN; en este sistema la cubre `country_of_nationality_code`
     * contra el catálogo `COUNTRY` (PA-053). Son dos columnas con nombres casi
     * iguales, y este catálogo ya se sembró una vez con la lista equivocada.
     */
    const pagina = await repository.rootsOf('NATIONALITY', criterios);

    expect(pagina.total).toBe(16);

    const porCodigo = new Map(pagina.items.map((c) => [c.code, c.display]));
    expect(porCodigo.get('1')).toBe('Achuar');
    expect(porCodigo.get('6')).toBe('Kichwa');
    expect(porCodigo.get('8')).toBe('Shuar');
    expect(porCodigo.get('16')).toBe('Huancavilca');

    // Ni un país: si alguno aparece aquí, alguien volcó la columna 11.
    const nombres = pagina.items.map((c) => c.display);
    expect(nombres).not.toContain('Ecuatoriana');
    expect(nombres).not.toContain('Venezolana');
    // Y sin los saltos del INEC: los códigos del instructivo son 1 a 16
    // seguidos, y renumerarlos ya cambió una vez el significado de un dato.
    expect(
      pagina.items.map((c) => Number(c.code)).sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });

  it('siembra las seis identidades de género de la columna 8', async () => {
    /**
     * LAS DEL FORMULARIO, NO LAS DEL GLOSARIO. Lo que se sembró el 17-08-2026
     * —«Cisgénero», «No binaria/o», «Género fluido»— salía del glosario del
     * manual de diversidades sexo-genéricas del MSP y NINGUNA de las seis
     * coincidía con el formulario que se reporta.
     */
    const pagina = await repository.rootsOf('GENDER_IDENTITY', criterios);

    expect(pagina.total).toBe(6);
    const porCodigo = new Map(pagina.items.map((c) => [c.code, c.display]));
    expect(porCodigo.get('1')).toBe('Transmasculino');
    expect(porCodigo.get('2')).toBe('Transfemenino');
    expect(porCodigo.get('3')).toBe('Masculino');
    expect(porCodigo.get('4')).toBe('Femenino');
    expect(porCodigo.get('5')).toBe('Ninguno');
    expect(porCodigo.get('6')).toBe('No sabe/No responde');
  });

  it('deja los tres catálogos enteros como elegibles, que es de lo que dependen', async () => {
    /**
     * EN UNA LISTA PLANA TODO SE ELIGE. `hierarchical` en `false` es lo que lo
     * decide: con `true`, sus conceptos de nivel 0 se leerían como títulos de
     * navegación y el selector de la ficha saldría vacío con un 200 — el
     * defecto que no falla.
     */
    for (const sistema of ['ETHNICITY', 'NATIONALITY', 'GENDER_IDENTITY']) {
      const pagina = await repository.rootsOf(sistema, criterios);
      expect(pagina.items.length, sistema).toBeGreaterThan(0);
      expect(
        pagina.items.every((c) => c.selectable),
        sistema,
      ).toBe(true);
      // Planos: ninguno cuelga de nada, así que las raíces son la lista entera.
      expect(pagina.items.length, sistema).toBe(pagina.total);
    }

    const sistemas = await db().catalogSystem.findMany({
      where: { code: { in: ['ETHNICITY', 'NATIONALITY', 'GENDER_IDENTITY'] } },
    });
    expect(sistemas.every((s) => !s.hierarchical)).toBe(true);
  });

  it('corrige el sistema marcado como jerárquico en vez de dejarlo así', async () => {
    /**
     * `hierarchical` SE FIJA TAMBIÉN AL ACTUALIZAR. Una fila `ETHNICITY` creada
     * a mano en `true` —o por una siembra anterior— deja el catálogo entero
     * como no elegible para siempre, y con `update: {}` nadie lo corrige nunca.
     */
    await db().catalogSystem.update({
      where: { code: 'ETHNICITY' },
      data: { hierarchical: true },
    });

    await seedRdacaa(db());

    const pagina = await repository.rootsOf('ETHNICITY', criterios);
    expect(pagina.items.every((c) => c.selectable)).toBe(true);
  });

  it('corrige también el NOMBRE del catálogo, que cambió con el instructivo', async () => {
    /**
     * `NATIONALITY` se llamaba «Nacionalidad o pueblo indígena», que mezclaba
     * la columna 13 con la 14 y venía de otra fuente. Un nombre que sólo se
     * escribe al crear se queda con la redacción vieja en toda base que ya
     * existiera — y es el texto que la pantalla enseña encima del selector.
     */
    await db().catalogSystem.update({
      where: { code: 'NATIONALITY' },
      data: { name: 'Nacionalidad o pueblo indígena (RDACAA)' },
    });

    await seedRdacaa(db());

    const sistema = await db().catalogSystem.findUniqueOrThrow({
      where: { code: 'NATIONALITY' },
    });
    expect(sistema.name).toBe('Nacionalidad indígena (RDACAA, columna 13)');
  });

  it('sembrar dos veces no duplica nada', async () => {
    // La release con su checksum es la que decide, y por eso `seed.mts` puede
    // llamarlo en cada arranque sin pensarlo.
    await seedRdacaa(db());

    for (const [sistema, total] of [
      ['ETHNICITY', 9],
      ['NATIONALITY', 16],
      ['GENDER_IDENTITY', 6],
    ] as const) {
      expect((await repository.rootsOf(sistema, criterios)).total).toBe(total);
    }
    expect(await db().catalogRelease.count()).toBe(3);
  });

  it('retira la lista anterior en vez de borrarla, y la ficha que la declaraba la sigue resolviendo', async () => {
    /**
     * ═════════════════════════════════════════════════════════════════════
     * SUSTITUIR UNA LISTA ES CARGAR OTRA RELEASE, Y ESTO ES LO QUE SIGNIFICA
     * ═════════════════════════════════════════════════════════════════════
     *
     * El caso real: `ETHNICITY` tenía el código `8` en «Otro/a» —lista del
     * INEC— y el instructivo pone ahí «No sabe / No responde». Borrar la fila
     * vieja ni se puede —hay `ON DELETE RESTRICT` desde `patient`— ni se
     * querría: una ficha registrada bajo la lista anterior apunta a ESA FILA
     * por su `id`, y su categoría es la que declaró el paciente.
     *
     * Lo que se retira es la posibilidad de ELEGIRLA a partir del corte. Se
     * comprueban las dos mitades, porque una sin la otra es el fallo:
     *  - `rootsOf` en el día del corte YA NO la devuelve —no se puede elegir—.
     *  - `findById`, que es como se lee una ficha, la sigue devolviendo con su
     *    texto de entonces.
     *
     * La fila anterior se fabrica aquí con la vigencia que tenía la release del
     * INEC, porque ese archivo ya no existe en el repositorio: lo que se prueba
     * es el MECANISMO, y el mecanismo no sabe de qué lista viene lo que retira.
     */
    const sistema = await db().catalogSystem.findUniqueOrThrow({
      where: { code: 'ETHNICITY' },
    });
    // Se deshace la siembra de este catálogo para dejar en su sitio la lista
    // ANTERIOR, que es el estado del que parte la corrección. Los conceptos
    // primero: `introduced_by_release_id` es `ON DELETE RESTRICT`.
    await db().catalogConcept.deleteMany({ where: { systemId: sistema.id } });
    await db().catalogRelease.deleteMany({ where: { systemId: sistema.id } });

    const anterior = await db().catalogConcept.create({
      data: {
        systemId: sistema.id,
        code: '8',
        display: 'Otro/a',
        validFrom: new Date('2022-01-01T00:00:00Z'),
        attributes: { level: 0 },
      },
    });

    await seedRdacaa(db());

    // 1. Ya no se puede elegir: en su sitio está la categoría del instructivo.
    const hoy = await repository.rootsOf('ETHNICITY', criterios);
    expect(hoy.items.map((c) => c.id)).not.toContain(anterior.id);
    expect(hoy.items.find((c) => c.code === '8')?.display).toBe(
      'No sabe / No responde',
    );

    // 2. Pero sigue ahí, con su texto, para quien la declaró. Leer una ficha
    //    no pregunta por vigencia, y por eso `findById` tampoco.
    const comoSeRegistro = await repository.findById(anterior.id);
    expect(comoSeRegistro?.display).toBe('Otro/a');

    // 3. Y consta QUIÉN la retiró, que es la mitad de la provenance que
    //    permite decir qué release cerró qué.
    const retirada = await db().catalogConcept.findUniqueOrThrow({
      where: { id: anterior.id },
      include: { retiredByRelease: true },
    });
    expect(retirada.validTo).toEqual(VIGENTE_DESDE);
    expect(retirada.retiredByRelease?.version).toBe(VERSION);
  });

  it('se niega a sustituir una lista que empieza en el corte o después', async () => {
    /**
     * El corte cierra la vigencia de lo anterior en la fecha de la release
     * nueva, y `catalog_concept_period_not_empty` exige `valid_to >
     * valid_from`. Una lista anterior que empezara ese mismo día no se puede
     * cerrar, y sin esta comprobación el fallo llegaría como un `23514` en
     * mitad de un `createMany` — cierto, pero ilegible.
     */
    const sistema = await db().catalogSystem.findUniqueOrThrow({
      where: { code: 'GENDER_IDENTITY' },
    });
    await db().catalogConcept.deleteMany({ where: { systemId: sistema.id } });
    await db().catalogRelease.deleteMany({ where: { systemId: sistema.id } });

    // Una lista anterior que empieza EL MISMO DÍA del corte: cerrarla dejaría
    // un rango vacío, que es lo que `catalog_concept_period_not_empty` prohíbe.
    await db().catalogConcept.create({
      data: {
        systemId: sistema.id,
        code: '1',
        display: 'Transmasculino',
        validFrom: VIGENTE_DESDE,
        attributes: { level: 0 },
      },
    });

    await expect(seedRdacaa(db())).rejects.toThrow(/2026-08-19 o después/);
  });

  it('deja constancia de qué archivo produjo cada lista', async () => {
    /**
     * PROVENANCE, Y AQUÍ MÁS QUE EN NINGÚN OTRO CATÁLOGO: las tres listas
     * anteriores eran provisionales y estaban mal. Éstas salen las tres del
     * MISMO documento —el instructivo del formulario SNS-MSP / Form. 504 /
     * 2019—, así que comparten versión, y lo que las distingue es el checksum
     * de su archivo. Cargar otra edición será otra release, no editar filas.
     */
    const releases = await db().catalogRelease.findMany({
      where: {
        system: {
          code: { in: ['ETHNICITY', 'NATIONALITY', 'GENDER_IDENTITY'] },
        },
      },
      include: { system: { select: { code: true } } },
    });

    const porSistema = new Map(releases.map((r) => [r.system.code, r]));

    expect(porSistema.get('ETHNICITY')).toMatchObject({
      version: VERSION,
      sourceChecksum:
        '9916254e91c4b67f35fa01a27f37945ceb7162009fb022de045700ccbcb73656',
    });
    expect(porSistema.get('NATIONALITY')).toMatchObject({
      version: VERSION,
      sourceChecksum:
        '54aafd635daf5b4433979e54a4c6f34545b9a8acd35ead824a570a6c44bf425f',
    });
    expect(porSistema.get('GENDER_IDENTITY')).toMatchObject({
      version: VERSION,
      sourceChecksum:
        'a595fb69da873da6766bf4650f9d531c5292f56b704917518ce2c5ad34d88314',
    });

    // Las tres vigentes desde el mismo día: es una sola corrección.
    for (const release of releases) {
      expect(release.sourceUrl, release.system.code).toBeTruthy();
      expect(release.effectiveFrom, release.system.code).toEqual(VIGENTE_DESDE);
    }

    // Cada release introduce sus conceptos: sin eso no se sabría qué retirar
    // al cargar la siguiente.
    const huerfanos = await db().catalogConcept.count({
      where: {
        system: {
          code: { in: ['ETHNICITY', 'NATIONALITY', 'GENDER_IDENTITY'] },
        },
        introducedByReleaseId: null,
      },
    });
    expect(huerfanos).toBe(0);
  });

  it('la víspera del corte los tres catálogos están vacíos, y eso es correcto', async () => {
    /**
     * NO ES UNA CURIOSIDAD: es lo que hace que retirar sea distinto de borrar.
     * El catálogo se consulta CON UNA FECHA, así que preguntarle por el 18 de
     * agosto devuelve lo que regía el 18 de agosto — nada, en una base donde
     * la lista anterior nunca se cargó. En la base de desarrollo, donde sí se
     * cargó, ese mismo día devuelve la lista del INEC.
     */
    for (const sistema of ['ETHNICITY', 'NATIONALITY', 'GENDER_IDENTITY']) {
      const pagina = await repository.rootsOf(sistema, {
        ...criterios,
        on: LA_VISPERA,
      });
      expect(pagina.total, sistema).toBe(0);
    }
  });
});
