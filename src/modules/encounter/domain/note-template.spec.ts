import { describe, expect, it } from 'vitest';

import {
  NoteContentIncompleteError,
  NoteTemplateInvalidError,
} from './encounter.errors';
import {
  MINIMUM_002_KEYS,
  assertNoteComplete,
  builtInTemplate,
  publishableSections,
  type NoteSectionInput,
} from './note-template';

/**
 * EN-200 to EN-205. What a clinic may change in its consultation note, and
 * what it may not.
 */

const builtIn = builtInTemplate('002');

/** The built-in sections as an administrator would send them back. */
const asInput = (): NoteSectionInput[] =>
  builtIn.sections.map((section) => ({
    key: section.key,
    title: section.title,
    help: section.help,
    kind: section.kind,
    options: [...section.options],
    required: section.required,
  }));

const refusalOf = (input: NoteSectionInput[]) => {
  try {
    publishableSections('002', input);
    return undefined;
  } catch (error) {
    return error as NoteTemplateInvalidError;
  }
};

const COMPLETE_002 = {
  motivoConsulta: 'Dolor dental',
  antecedentes: 'Niega antecedentes',
  enfermedadActual: 'Dolor de tres días',
  revisionOrganosSistemas: 'Sin particularidades',
  examenFisico: 'Caries en 36',
  planTratamiento: 'Endodoncia',
};

describe('la plantilla de serie', () => {
  it('EN-200 trae las seis secciones del mínimo de EN-020, obligatorias y en el orden de la consulta', () => {
    expect(builtIn.sections.map((section) => section.key)).toEqual([
      ...MINIMUM_002_KEYS,
    ]);
    expect(builtIn.sections.every((section) => section.required)).toBe(true);
    expect(builtIn.sections.every((section) => section.minimum)).toBe(true);
    expect(builtIn.id).toBeNull();
  });

  it('EN-200 la ayuda de antecedentes no pide reescribir las alergias registradas', () => {
    const background = builtIn.sections.find(
      (section) => section.key === 'antecedentes',
    );
    expect(background?.help).not.toMatch(/^Alergias/);
  });
});

describe('lo que la clínica puede cambiar', () => {
  it('EN-201 admite cambiar título, ayuda y orden de las secciones del mínimo', () => {
    const input = asInput().reverse();
    input[0] = { ...input[0]!, title: 'Indicaciones', help: 'Qué se indica' };

    const sections = publishableSections('002', input);

    expect(sections[0]).toMatchObject({
      key: 'planTratamiento',
      title: 'Indicaciones',
      help: 'Qué se indica',
      minimum: true,
      required: true,
    });
  });

  it('EN-201 rechaza quitar una sección del mínimo y la nombra', () => {
    const refusal = refusalOf(
      asInput().filter((section) => section.key !== 'examenFisico'),
    );

    expect(refusal).toBeInstanceOf(NoteTemplateInvalidError);
    expect(refusal?.code).toBe('NOTE_TEMPLATE_INVALID');
    expect(refusal?.fieldErrors?.[0]?.message).toContain('Examen físico');
  });

  it('EN-201 rechaza marcar como no obligatoria una sección del mínimo', () => {
    const input = asInput();
    input[1] = { ...input[1]!, required: false };

    expect(refusalOf(input)).toBeInstanceOf(NoteTemplateInvalidError);
  });

  it('EN-201 rechaza repetir una sección del mínimo', () => {
    expect(refusalOf([...asInput(), asInput()[0]!])).toBeInstanceOf(
      NoteTemplateInvalidError,
    );
  });

  it('EN-202 añade una sección propia de lista, con su clave puesta por el servidor', () => {
    const sections = publishableSections('002', [
      ...asInput(),
      {
        title: 'Hallazgos odontológicos',
        help: '',
        kind: 'CHOICE',
        options: ['Caries', 'Gingivitis', 'Sin hallazgos'],
        required: true,
      },
    ]);

    const own = sections.at(-1);
    expect(own).toMatchObject({
      key: 'extra1',
      kind: 'CHOICE',
      minimum: false,
      required: true,
    });
  });

  it('EN-202 conserva la clave de una sección propia que ya existía y numera las nuevas después', () => {
    const sections = publishableSections('002', [
      ...asInput(),
      {
        key: 'extra3',
        title: 'Odontograma',
        help: '',
        kind: 'TEXT',
        required: false,
      },
      { title: 'Higiene oral', help: '', kind: 'TEXT', required: false },
    ]);

    expect(sections.slice(-2).map((section) => section.key)).toEqual([
      'extra3',
      'extra4',
    ]);
  });

  it('EN-202 rechaza una lista de menos de dos opciones', () => {
    expect(
      refusalOf([
        ...asInput(),
        {
          title: 'Lado',
          help: '',
          kind: 'CHOICE',
          options: ['Derecho'],
          required: false,
        },
      ]),
    ).toBeInstanceOf(NoteTemplateInvalidError);
  });

  it('EN-202 rechaza opciones repetidas', () => {
    expect(
      refusalOf([
        ...asInput(),
        {
          title: 'Lado',
          help: '',
          kind: 'CHOICE',
          options: ['Derecho', ' derecho '],
          required: false,
        },
      ]),
    ).toBeInstanceOf(NoteTemplateInvalidError);
  });

  it('EN-202 rechaza dos secciones con el mismo título', () => {
    expect(
      refusalOf([
        ...asInput(),
        {
          title: 'motivo de consulta',
          help: '',
          kind: 'TEXT',
          required: false,
        },
      ]),
    ).toBeInstanceOf(NoteTemplateInvalidError);
  });

  it('EN-202 rechaza una clave que no es del mínimo ni de una sección propia', () => {
    expect(
      refusalOf([
        ...asInput(),
        {
          key: 'backgroundSnapshot',
          title: 'Foto',
          help: '',
          kind: 'TEXT',
          required: false,
        },
      ]),
    ).toBeInstanceOf(NoteTemplateInvalidError);
  });
});

describe('firmar con la plantilla de la nota', () => {
  const withOwn = {
    ...builtIn,
    id: 'template-1',
    sections: publishableSections('002', [
      ...asInput(),
      {
        title: 'Hallazgos odontológicos',
        help: '',
        kind: 'CHOICE',
        options: ['Caries', 'Sin hallazgos'],
        required: true,
      },
      { title: 'Observaciones', help: '', kind: 'TEXT', required: false },
    ]),
  };

  it('EN-205 exige la sección propia obligatoria', () => {
    expect(() => assertNoteComplete(withOwn, COMPLETE_002)).toThrow(
      NoteContentIncompleteError,
    );
  });

  it('EN-205 no exige la sección propia opcional', () => {
    expect(() =>
      assertNoteComplete(withOwn, { ...COMPLETE_002, extra1: 'Caries' }),
    ).not.toThrow();
  });

  it('EN-205 rechaza en una lista un valor que no es una de sus opciones', () => {
    try {
      assertNoteComplete(withOwn, { ...COMPLETE_002, extra1: 'Fractura' });
      expect.unreachable('la opción inventada debía rechazarse');
    } catch (error) {
      const refusal = error as NoteContentIncompleteError;
      expect(refusal.fieldErrors?.[0]).toMatchObject({
        field: 'content.extra1',
        message: 'Elija una de las opciones de la lista',
      });
    }
  });

  it('EN-205 con la plantilla de serie exige las seis de siempre', () => {
    expect(() =>
      assertNoteComplete(builtIn, { ...COMPLETE_002, planTratamiento: ' ' }),
    ).toThrow(NoteContentIncompleteError);
  });
});
