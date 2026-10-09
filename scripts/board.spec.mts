/**
 * The parsing every report shares (`pnpm estado`, `pnpm estado:proyecto`,
 * `pnpm roadmap:check`, `pnpm rtm`). Each case here is a way the board once
 * told something false with confidence.
 */

import { describe, expect, it } from 'vitest';

import {
  TEST_TITLE,
  computeBoard,
  exemptionsOf,
  titleOf,
  workingTree,
  workspaceOf,
  type Source,
} from './board.mts';

/** Titles `TEST_TITLE` reads in `code`, in order. */
const titles = (code: string): string[] =>
  [...code.matchAll(TEST_TITLE)].map(titleOf);

/** An in-memory checkout: path → contents. */
function memory(files: Record<string, string>): Source {
  return {
    label: 'memoria',
    list: (dir, ext) =>
      Object.keys(files).filter(
        (f) => (dir === '' || f.startsWith(`${dir}/`)) && f.endsWith(ext),
      ),
    read: (path) => files[path] ?? null,
  };
}

const SPEC_HEAD = [
  '**Estado:** borrador',
  '',
  '- **ZZ-001** — El sistema DEBERÁ uno.',
  '- **ZZ-002** — El sistema DEBERÁ dos.',
  '- **ZZ-003** — El sistema DEBERÁ tres.',
  '',
].join('\n');

const declared = new Set(['ZZ-001', 'ZZ-002', 'ZZ-003']);
const all = ['ZZ-001', 'ZZ-002', 'ZZ-003'];

describe('TEST_TITLE: el título entero, sea cual sea la comilla de dentro', () => {
  it('lee un título entre comillas simples que lleva acentos graves', () => {
    expect(titles("it('ZZ-001 sin `record:read` también', () => {})")).toEqual([
      'ZZ-001 sin `record:read` también',
    ]);
  });

  it('lee un título entre comillas simples que lleva comillas dobles', () => {
    expect(
      titles(`test('ZZ-001 el botón "Corregir" emite', () => {})`),
    ).toEqual(['ZZ-001 el botón "Corregir" emite']);
  });

  it('lee un título con la propia comilla escapada', () => {
    expect(titles("it('ZZ-001 l\\'acte y ZZ-002', () => {})")).toEqual([
      "ZZ-001 l\\'acte y ZZ-002",
    ]);
  });

  it('lee un título entre acentos graves que lleva comillas simples', () => {
    expect(titles('describe(`ZZ-003 \'a\' y "b"`, () => {})')).toEqual([
      'ZZ-003 \'a\' y "b"',
    ]);
  });

  it('control: un título normal se lee, y dos llamadas seguidas no se funden', () => {
    expect(
      titles('it(\'ZZ-001 uno\', () => {});\nit.skip("ZZ-002 dos", () => {});'),
    ).toEqual(['ZZ-001 uno', 'ZZ-002 dos']);
  });

  it('cuenta en el tablero el requisito que viene tras el acento grave', () => {
    const api = memory({
      'src/modules/zz/SPEC.md':
        SPEC_HEAD + '### Z1 — Entrega _(P1)_\n\n**Cubre:** ZZ-001.\n',
      'src/modules/zz/a.spec.ts':
        "it('sin `x` ZZ-001', () => {}); it('control', () => {});",
    });
    const [zz] = computeBoard(api, memory({}));
    expect(zz?.deliverables[0]).toMatchObject({ back: 1, total: 1 });
  });
});

describe('«Fuera del sistema»: fuera de los dos denominadores, con motivo', () => {
  const section = (exemptions: string): string =>
    `Z1 — Entrega _(P2)_\n\n**Cubre:** ZZ-001 a ZZ-003.\n\n${exemptions}\n`;

  it('saca el requisito de los dos lados y lo lista aparte con su motivo', () => {
    const api = memory({
      'src/modules/zz/SPEC.md':
        SPEC_HEAD +
        '### ' +
        section(
          '**Fuera del sistema:** ZZ-002, ZZ-003. D-151.1: se hace en el\nportal del SRI.',
        ),
      'src/modules/zz/a.spec.ts': "it('ZZ-001 se prueba', () => {});",
    });
    const web = memory({
      'app/a.spec.ts': "it('ZZ-001 en pantalla', () => {});",
    });
    const [zz] = computeBoard(api, web);
    expect(zz?.deliverables[0]).toMatchObject({
      back: 1,
      total: 1,
      front: 1,
      frontTotal: 1,
      state: 'completo',
      outOfSystem: ['ZZ-002', 'ZZ-003'],
      outOfSystemReason: 'D-151.1: se hace en el portal del SRI.',
    });
  });

  it('control: sin la declaración, los mismos requisitos se deben', () => {
    const api = memory({
      'src/modules/zz/SPEC.md': SPEC_HEAD + '### ' + section(''),
      'src/modules/zz/a.spec.ts': "it('ZZ-001 se prueba', () => {});",
    });
    const [zz] = computeBoard(api, memory({}));
    expect(zz?.deliverables[0]).toMatchObject({
      back: 1,
      total: 3,
      frontTotal: 3,
      outOfSystem: [],
      state: 'backend en curso',
    });
  });

  it('el motivo no se come el párrafo siguiente', () => {
    const got = exemptionsOf(
      '**Fuera del sistema:** ZZ-002. Lo dice D-151.\n\n**Solo servidor:** ZZ-001. Base.',
      declared,
      'zz/Z1',
      all,
    );
    expect(got.outOfSystemReason).toBe('Lo dice D-151.');
    expect([...got.serverOnly]).toEqual(['ZZ-001']);
  });

  it('rechaza «Fuera del sistema» sin motivo', () => {
    expect(() =>
      exemptionsOf(
        '**Fuera del sistema:** ZZ-002.\n\nOtra cosa.',
        declared,
        'zz/Z1',
        all,
      ),
    ).toThrow(/zz\/Z1: «Fuera del sistema» sin motivo/);
  });

  it('rechaza un requisito a la vez fuera del sistema y solo servidor', () => {
    expect(() =>
      exemptionsOf(
        '**Solo servidor:** ZZ-002. Base.\n\n**Fuera del sistema:** ZZ-002. D-151.',
        declared,
        'zz/Z1',
        all,
      ),
    ).toThrow(
      /zz\/Z1: ZZ-002 declarado a la vez «Fuera del sistema» y «Solo servidor»/,
    );
  });

  it('rechaza un requisito a la vez fuera del sistema y solo interfaz', () => {
    expect(() =>
      exemptionsOf(
        '**Solo interfaz:** ZZ-003. Navegador.\n\n**Fuera del sistema:** ZZ-003. D-151.',
        declared,
        'zz/Z1',
        all,
      ),
    ).toThrow(/«Fuera del sistema» y «Solo interfaz»/);
  });

  it('control: tres declaraciones con requisitos distintos se aceptan', () => {
    const got = exemptionsOf(
      '**Solo servidor:** ZZ-001. Base.\n\n**Solo interfaz:** ZZ-002. Navegador.\n\n**Fuera del sistema:** ZZ-003. D-151.',
      declared,
      'zz/Z1',
      all,
    );
    expect([...got.outOfSystem]).toEqual(['ZZ-003']);
  });
});

describe('TEST_TITLE: dónde termina un título', () => {
  it('lee un título entre acentos graves que cruza líneas', () => {
    expect(titles('it(`ZZ-001 una\n  ZZ-002 dos`, () => {})')).toEqual([
      'ZZ-001 una\n  ZZ-002 dos',
    ]);
  });

  it('lee un título con continuación de línea', () => {
    expect(titles("it('ZZ-001 \\\nZZ-002', () => {})")).toEqual([
      'ZZ-001 \\\nZZ-002',
    ]);
  });

  it('una comilla suelta en un comentario no se traga las líneas siguientes', () => {
    expect(
      titles(
        "// test('s de la API\nconst a = 1;\nit('ZZ-001 real', () => {});",
      ),
    ).toEqual(['ZZ-001 real']);
  });
});

describe('las declaraciones no retiran lo que no dicen', () => {
  const read = (raw: string) => exemptionsOf(raw, declared, 'zz/Z1', all);

  it('un punto olvidado no saca los requisitos del párrafo siguiente', () => {
    expect(() =>
      read(
        '**Fuera del sistema:** ZZ-002\n\nPor qué ZZ-003 importa. Más texto aquí.',
      ),
    ).toThrow(/«Fuera del sistema» sin el punto que cierra su lista/);
  });

  it('el motivo empieza en la línea del punto, y una lista no pasa por motivo', () => {
    expect(() =>
      read('**Fuera del sistema:** ZZ-002.\n- **ZZ-004** — Otra cosa.'),
    ).toThrow(/sin motivo/);
    expect(
      read(
        '**Fuera del sistema:** ZZ-002. D-151.1: se hace\nen el portal.\n- **ZZ-004** — x.',
      ).outOfSystemReason,
    ).toBe('D-151.1: se hace en el portal.');
  });

  it('una lista vacía se rechaza', () => {
    expect(() => read('**Fuera del sistema:** . D-151.')).toThrow(
      /no nombra ningún requisito declarado/,
    );
  });

  it('un requisito que su «Cubre» no nombra se rechaza', () => {
    expect(() =>
      exemptionsOf('**Fuera del sistema:** ZZ-003. D-151.', declared, 'zz/Z1', [
        'ZZ-001',
        'ZZ-002',
      ]),
    ).toThrow(/zz\/Z1: ZZ-003 declarado aparte pero su «Cubre» no lo nombra/);
    expect(() =>
      exemptionsOf('**Solo servidor:** ZZ-003. Base.', declared, 'zz/Z1', [
        'ZZ-001',
      ]),
    ).toThrow(/«Cubre» no lo nombra/);
  });

  it('dos declaraciones del mismo tipo en una entrega se rechazan', () => {
    expect(() =>
      read(
        '**Solo servidor:** ZZ-001. Base.\n\n**Solo servidor:** ZZ-002. Otra.',
      ),
    ).toThrow(/dos declaraciones «Solo servidor»/);
  });

  it('la última entrega acaba en el siguiente `##`, no al final del archivo', () => {
    const api = memory({
      'src/modules/zz/SPEC.md':
        SPEC_HEAD +
        '### Z1 — Entrega _(P1)_\n\n**Cubre:** ZZ-001, ZZ-002.\n\n## Requisitos\n\n' +
        '> una nota que cita **Solo interfaz:** ZZ-002 de pasada.\n',
      'src/modules/zz/a.spec.ts': "it('ZZ-001 se prueba', () => {});",
    });
    expect(computeBoard(api, memory({}))[0]?.deliverables[0]).toMatchObject({
      total: 2,
    });
  });
});

describe('los SPEC.md reales', () => {
  it('se leen sin ninguna declaración rechazada, y billing/B3 deja fuera BI-092 y BI-093', () => {
    const where = workspaceOf(process.cwd());
    const board = computeBoard(workingTree(where.api), workingTree(where.web));
    const b3 = board
      .find((m) => m.module === 'billing')
      ?.deliverables.find((d) => d.id === 'B3');
    expect(b3?.outOfSystem).toEqual(['BI-092', 'BI-093']);
  });
});
