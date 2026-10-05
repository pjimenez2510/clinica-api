import { describe, expect, it } from 'vitest';

import {
  composePrescriptionSchema,
  discardPrescriptionSchema,
} from './prescription.dto';

/** The transport's half of PR-031 and PR-105: the line as it is sent. */
const line = (overrides: Record<string, unknown> = {}) => ({
  conceptId: '0192f0c4-7d6e-7a40-9a2b-3c4d5e6f7a8b',
  dosageForm: 'TABLET',
  concentration: '500 mg',
  routeCode: 'ORAL',
  quantity: 1,
  doseAmount: 1,
  doseUnit: 'TABLET',
  frequency: 'EVERY_8_HOURS',
  durationDays: 7,
  ...overrides,
});

const parse = (item: Record<string, unknown>) =>
  composePrescriptionSchema.safeParse({ items: [item] });

const failedPaths = (item: Record<string, unknown>) =>
  parse(item).error?.issues.map((issue) => issue.path.join('.')) ?? [];

describe('la duración de una línea de receta', () => {
  it('PR-031 con cualquier frecuencia que no sea «Dosis única», la duración es obligatoria', () => {
    expect(failedPaths(line({ durationDays: undefined }))).toEqual([
      'items.0.durationDays',
    ]);
    expect(parse(line()).success).toBe(true);
  });

  it('PR-105 con «Dosis única» la línea se admite sin duración', () => {
    const result = parse(
      line({ frequency: 'SINGLE_DOSE', durationDays: undefined }),
    );

    expect(result.success).toBe(true);
  });

  it('PR-105 con «Dosis única» una duración se rechaza nombrando el campo', () => {
    const result = parse(line({ frequency: 'SINGLE_DOSE', durationDays: 1 }));

    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['items', 0, 'durationDays'],
        message: 'Con «Dosis única» no se indica duración',
      }),
    ]);
  });
});

describe('descartar un borrador de receta', () => {
  it('PR-107 no pide motivo: sin cuerpo, o con el motivo en blanco, el motivo es nulo', () => {
    expect(discardPrescriptionSchema.parse({})).toEqual({ reason: null });
    expect(discardPrescriptionSchema.parse({ reason: '   ' })).toEqual({
      reason: null,
    });
  });

  it('PR-107 el motivo que se escribe se guarda, y no pasa del ancho de su columna', () => {
    expect(discardPrescriptionSchema.parse({ reason: ' Paciente equivocado ' })).toEqual({ reason: 'Paciente equivocado' }); // prettier-ignore
    expect(
      discardPrescriptionSchema.safeParse({ reason: 'x'.repeat(501) }).error
        ?.issues[0]?.path,
    ).toEqual(['reason']);
  });
});
