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
 * Que el sembrador deja el catálogo USABLE, que es la única pregunta que
 * importaba: `catalogSystemSchema` admitía `ETHNICITY` desde P2 y la ficha
 * sabía guardarla, pero la tabla estaba vacía porque qué lista cargar era una
 * decisión pendiente (D-034). Un selector vacío no falla: parece una pantalla
 * rota, y se pierden semanas antes de que alguien mire la tabla.
 *
 * Y que sembrar dos veces no duplica nada, que es lo que permite llamarlo desde
 * `seed.mts` en cada `pnpm db:reset` sin pensarlo.
 */
const HOY = new Date('2026-08-17T00:00:00Z');

describe('los catálogos del RDACAA', () => {
  const db = useDatabase();
  let repository: PrismaCatalogRepository;

  beforeEach(async () => {
    repository = new PrismaCatalogRepository(db() as unknown as PrismaService);
    await seedRdacaa(db());
  });

  const criterios = { on: HOY, limit: 500, offset: 0 };

  it('siembra las ocho categorías de autoidentificación étnica', async () => {
    /**
     * OCHO Y NO LAS SEIS QUE EL INEC PUBLICA. El INEC agrupa afroecuatoriano,
     * negro y mulato AL PUBLICAR los resultados; el formulario pregunta por las
     * ocho y el RDACAA las separa. De ocho siempre se pueden sacar seis; de
     * seis no se pueden sacar ocho.
     */
    const pagina = await repository.rootsOf('ETHNICITY', criterios);

    expect(pagina.total).toBe(8);
    const porCodigo = new Map(pagina.items.map((c) => [c.code, c.display]));
    expect(porCodigo.get('1')).toBe('Indígena');
    expect(porCodigo.get('2')).toBe('Afroecuatoriano/a');
    expect(porCodigo.get('3')).toBe('Negro/a');
    expect(porCodigo.get('4')).toBe('Mulato/a');
    expect(porCodigo.get('5')).toBe('Montubio/a');
    expect(porCodigo.get('6')).toBe('Mestizo/a');
    expect(porCodigo.get('7')).toBe('Blanco/a');
    expect(porCodigo.get('8')).toBe('Otro/a');
  });

  it('conserva los códigos del INEC con sus saltos, sin renumerar', async () => {
    /**
     * DEL 14 AL 21, Y SIN 37. Son los códigos de la variable `P12` del Censo
     * 2022 tal como el INEC los publica. Renumerarlos para que fueran seguidos
     * rompería la comparación con cualquier fuente oficial —y el dato de un
     * paciente registrado hoy se leería mañana como otra nacionalidad—.
     */
    const pagina = await repository.rootsOf('NATIONALITY', criterios);

    expect(pagina.total).toBe(34);
    const codigos = pagina.items.map((c) => c.code);
    expect(codigos).toContain('14');
    expect(codigos).toContain('21');
    expect(codigos).not.toContain('15');
    expect(codigos).not.toContain('37');
    // `99 Se ignora` se excluye a propósito: es un resultado de la
    // recolección, no algo que se le ofrezca a nadie para elegir.
    expect(codigos).not.toContain('99');
  });

  it('siembra las seis identidades de género del manual del MSP', async () => {
    const pagina = await repository.rootsOf('GENDER_IDENTITY', criterios);

    expect(pagina.total).toBe(6);
    expect(pagina.items.map((c) => c.code).sort()).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
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

  it('sembrar dos veces no duplica nada', async () => {
    // La release con su checksum es la que decide, y por eso `seed.mts` puede
    // llamarlo en cada arranque sin pensarlo.
    await seedRdacaa(db());

    for (const [sistema, total] of [
      ['ETHNICITY', 8],
      ['NATIONALITY', 34],
      ['GENDER_IDENTITY', 6],
    ] as const) {
      expect((await repository.rootsOf(sistema, criterios)).total).toBe(total);
    }
    expect(await db().catalogRelease.count()).toBe(3);
  });

  it('deja constancia de qué archivo produjo cada lista', async () => {
    /**
     * PROVENANCE, Y AQUÍ MÁS QUE EN NINGÚN OTRO CATÁLOGO: las tres listas son
     * PROVISIONALES hasta contrastarlas con el instructivo del RDACAA 2.0, que
     * no se ha podido obtener de fuente oficial. Sustituirlas será cargar otra
     * release —con su versión y su checksum—, no editar filas a mano, y una
     * ficha registrada hoy seguirá resolviendo la categoría con la que se
     * registró.
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
      version: 'inec-cpv-2022',
      sourceChecksum:
        'b33c4964099045a28799c441705d21a576f8664bfc6e35990f44072685b171e8',
    });
    expect(porSistema.get('NATIONALITY')).toMatchObject({
      version: 'inec-cpv-2022',
      sourceChecksum:
        'bc18f865d9d3da343a0a66483d3ab9ba76ea8b91a6abb3e96b2fe223890b1ee2',
    });
    expect(porSistema.get('GENDER_IDENTITY')).toMatchObject({
      version: 'msp-ro-579-2024',
      sourceChecksum:
        'cc6107afeae5da7b75776743fde96dfaf07c39e5373d6a72d0d14c62826d2eb5',
    });
    // Cada release dice de dónde salió su lista, y las tres introducen sus
    // conceptos: sin eso no se sabría qué retirar al cargar la siguiente.
    for (const release of releases) {
      expect(release.sourceUrl, release.system.code).toBeTruthy();
    }
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
});
