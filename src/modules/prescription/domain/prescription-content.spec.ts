import { describe, expect, it } from 'vitest';

import {
  assertItemsComplete,
  assertOffFormularyJustified,
  assertPrescriptionComplete,
} from './prescription-content';
import {
  OffFormularyJustificationRequiredError,
  PrescriptionEmptyError,
  PrescriptionItemIncompleteError,
} from './prescription.errors';
import type { ItemContent } from './prescription-content';

/**
 * PR-009, PR-032. Art. 5.c of the Resolución ACESS-2023-0030.
 *
 * ⚠️ THE TEST THAT MATTERS MOST IS «reports EVERY missing field at once». The
 * opposite failure mode is familiar and specific: the doctor fixes the
 * concentration, submits, is told the route is missing, fixes it, submits, is
 * told the duration is missing — and the third time round types anything into
 * the box to make it stop.
 */
const complete = (overrides: Partial<ItemContent> = {}): ItemContent => ({
  line: 1,
  genericName: 'Amoxicilina',
  presentation: 'Cápsula',
  concentration: '500 mg',
  routeCode: 'ORAL',
  quantity: 20,
  doseText: '1 cápsula',
  frequencyText: 'Cada 8 horas',
  durationDays: 7,
  conceptId: 'concept-1',
  offFormularyJustification: null,
  ...overrides,
});

describe('el contenido mínimo del art. 5', () => {
  it('PR-032 acepta una línea con todo lo que la norma exige', () => {
    expect(() => assertItemsComplete([complete()])).not.toThrow();
  });

  it('PR-032 rechaza emitir una receta sin ningún medicamento', () => {
    expect(() => assertItemsComplete([])).toThrow(PrescriptionEmptyError);
  });

  it('PR-032 nombra TODOS los campos que faltan, de TODAS las líneas, en una sola respuesta', () => {
    let thrown: PrescriptionItemIncompleteError | undefined;
    try {
      assertItemsComplete([
        complete({ line: 1, concentration: null, routeCode: null }),
        complete({ line: 2, durationDays: null }),
      ]);
    } catch (error) {
      thrown = error as PrescriptionItemIncompleteError;
    }

    expect(thrown?.code).toBe('PRESCRIPTION_ITEM_INCOMPLETE');
    expect(thrown?.fieldErrors?.map((error) => error.field)).toEqual([
      'items.0.concentration',
      'items.0.routeCode',
      'items.1.durationDays',
    ]);
  });

  it('PR-094 no nombra el medicamento en ningún mensaje', () => {
    // Un fármaco es un diagnóstico dicho de otra forma, y estos mensajes llegan
    // a los registros y a las capturas de soporte.
    let thrown: PrescriptionItemIncompleteError | undefined;
    try {
      assertItemsComplete([complete({ concentration: null })]);
    } catch (error) {
      thrown = error as PrescriptionItemIncompleteError;
    }

    const everything = JSON.stringify([
      thrown?.userTitle,
      thrown?.fieldErrors,
      thrown?.params,
    ]);
    expect(everything).not.toContain('Amoxicilina');
    expect(thrown?.fieldErrors?.[0]?.message).toContain('línea 1');
  });

  it('PR-032 trata el texto en blanco como ausente', () => {
    // `''` en un `varchar` no es una concentración, y la base la aceptaría.
    expect(() =>
      assertItemsComplete([complete({ concentration: '   ' })]),
    ).toThrow(
      // prettier-ignore
      PrescriptionItemIncompleteError,
    );
  });

  it('PR-009 exige la justificación cuando no hay concepto del CNMB', () => {
    expect(() =>
      assertOffFormularyJustified(
        complete({ conceptId: null, offFormularyJustification: null }),
      ),
    ).toThrow(OffFormularyJustificationRequiredError);
  });

  it('PR-009 admite recetar fuera del CNMB cuando se escribe por qué', () => {
    expect(() =>
      assertOffFormularyJustified(
        complete({
          conceptId: null,
          offFormularyJustification: 'Desabastecimiento del equivalente CNMB',
        }),
      ),
    ).not.toThrow();
  });

  it('PR-009 no pide justificación a una línea que sí nombra un concepto', () => {
    expect(() => assertOffFormularyJustified(complete())).not.toThrow();
  });

  it('PR-009 señala la línea en la que falta la justificación', () => {
    let thrown: OffFormularyJustificationRequiredError | undefined;
    try {
      assertItemsComplete([
        complete({ line: 1 }),
        complete({ line: 2, conceptId: null, offFormularyJustification: null }),
      ]);
    } catch (error) {
      thrown = error as OffFormularyJustificationRequiredError;
    }

    expect(thrown?.code).toBe('OFF_FORMULARY_JUSTIFICATION_REQUIRED');
    expect(thrown?.fieldErrors?.[0]?.field).toBe(
      'items.1.offFormularyJustification',
    );
  });
});

describe('las indicaciones del art. 5.e, que son de la receta y no de la línea', () => {
  const indications = {
    warningSigns: 'Fiebre mayor de 39 °C o dificultad para respirar',
    nonPharmacologicalAdvice: 'Abundantes líquidos y reposo relativo',
  };

  /** The field paths of the refusal, or `[]` when it was accepted. */
  function missingOf(
    content: Parameters<typeof assertPrescriptionComplete>[0],
  ) {
    try {
      assertPrescriptionComplete(content);
      return [];
    } catch (error) {
      return (error as PrescriptionItemIncompleteError).fieldErrors.map(
        (fieldError) => fieldError.field,
      );
    }
  }

  it('PR-038 PR-039 acepta una receta con signos de alarma y recomendaciones', () => {
    expect(missingOf({ ...indications, items: [complete()] })).toEqual([]);
  });

  it('PR-038 rechaza emitir sin signos de alarma y nombra el campo', () => {
    expect(
      missingOf({ ...indications, warningSigns: null, items: [complete()] }),
    ).toEqual(['warningSigns']);
  });

  it('PR-039 rechaza emitir sin recomendaciones no farmacológicas y nombra el campo', () => {
    expect(
      missingOf({ ...indications, nonPharmacologicalAdvice: '   ', items: [complete()] }), // prettier-ignore
    ).toEqual(['nonPharmacologicalAdvice']);
  });

  it('PR-032 PR-038 nombra los de la receta y los de las líneas en UNA sola respuesta', () => {
    expect(
      missingOf({
        warningSigns: '',
        nonPharmacologicalAdvice: null,
        items: [complete({ routeCode: null })],
      }),
    ).toEqual([
      'warningSigns',
      'nonPharmacologicalAdvice',
      'items.0.routeCode',
    ]);
  });
});
