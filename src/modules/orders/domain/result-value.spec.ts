import { describe, expect, it } from 'vitest';

import { CULTURE, GLUCOSE, HAEMOGLOBIN, NITRITES } from './analyte.fixtures';
import { resolveResult } from './result-value';
import type { PatientProfile } from './analyte';

/**
 * The coherence between what the analyte declares and what was typed, and the
 * two fields this contract refuses to be told.
 */

const woman: PatientProfile = { sex: 'FEMALE', ageDays: 12_000 };

describe('la transcripción de una determinación', () => {
  it('ORD-034 congela la unidad del catálogo y no la del transcriptor', () => {
    // Aceptarla del transcriptor es cómo la misma hemoglobina acaba en `g/dL`
    // y en `g/L` en dos filas consecutivas, sin que nada aguas abajo lo sepa.
    expect(
      resolveResult(HAEMOGLOBIN, { valueNumeric: 13.4 }, woman),
    ).toMatchObject({
      // prettier-ignore
      analyteDisplay: 'Hemoglobina',
      valueNumeric: 13.4,
      unit: 'g/dL',
      abnormalFlag: 'NORMAL',
    });
  });

  it('ORD-032 rechaza un número tecleado en la columna de texto', () => {
    // Cumple `observation_result_one_value` y sigue siendo una cadena con
    // aspecto de resultado: ninguna gráfica la dibuja, ningún umbral la compara.
    expect(() => resolveResult(GLUCOSE, { valueText: '92' }, woman)).toThrow(
      expect.objectContaining({ code: 'RESULT_VALUE_TYPE_MISMATCH' }),
    );
  });

  it('ORD-032 rechaza dos columnas pobladas a la vez', () => {
    expect(() =>
      resolveResult(GLUCOSE, { valueNumeric: 92, valueCode: 'Alto' }, woman),
    ).toThrow(expect.objectContaining({ code: 'RESULT_VALUE_TYPE_MISMATCH' }));
  });

  it('ORD-032 rechaza un número para una determinación codificada', () => {
    expect(() => resolveResult(NITRITES, { valueNumeric: 1 }, woman)).toThrow(
      expect.objectContaining({ code: 'RESULT_VALUE_TYPE_MISMATCH' }),
    );
  });

  it('ORD-033 admite un valor de la lista y rechaza cualquier otro', () => {
    expect(
      resolveResult(NITRITES, { valueCode: 'Positivo' }, woman),
    ).toMatchObject({
      // prettier-ignore
      valueCode: 'Positivo',
      valueNumeric: null,
      unit: null,
      referenceText: 'Negativo',
      // ORD-038. Sin `ABNORMAL` en el enum, un positivo cualitativo no lleva
      // bandera: inventar `HIGH` lo pondría en la misma lista que un potasio
      // de 7,2. Es la nota de esquema de ORD-038.
      abnormalFlag: null,
    });

    // Sin la lista cerrada, cada transcriptor escribe `POS`, `+`, `Positivo` y
    // `positivo`, y la regla clínica que los compare no encuentra ninguno.
    expect(() => resolveResult(NITRITES, { valueCode: 'POS' }, woman)).toThrow(
      expect.objectContaining({ code: 'RESULT_VALUE_NOT_ALLOWED' }),
    );
  });

  it('ORD-033 nombra en el mensaje las opciones admitidas y nunca el valor rechazado', () => {
    // Las opciones son metadato de catálogo y no dicen nada del paciente; el
    // valor rechazado ES la lectura, y ese mensaje llega a un log.
    try {
      resolveResult(NITRITES, { valueCode: 'POS' }, woman);
      expect.unreachable('debía rechazar el valor');
    } catch (error) {
      const title = (error as { userTitle: string }).userTitle;
      expect(title).toContain('Negativo, Positivo');
      expect(title).not.toContain('POS');
    }
  });

  it('ORD-032 acepta texto libre donde el analito lo declara', () => {
    expect(
      resolveResult(CULTURE, { valueText: '  Sin crecimiento a 48 h ' }, woman),
    ).toMatchObject({
      // prettier-ignore
      valueText: 'Sin crecimiento a 48 h',
      valueNumeric: null,
      unit: null,
      abnormalFlag: null,
    });
  });

  it('ORD-032 rechaza un texto vacío, que no es un resultado', () => {
    expect(() => resolveResult(CULTURE, { valueText: '   ' }, woman)).toThrow(
      expect.objectContaining({ code: 'RESULT_VALUE_TYPE_MISMATCH' }),
    );
    expect(() => resolveResult(NITRITES, { valueCode: '' }, woman)).toThrow(
      expect.objectContaining({ code: 'RESULT_VALUE_TYPE_MISMATCH' }),
    );
  });

  it('ORD-032 rechaza un numérico ausente o no finito', () => {
    expect(() => resolveResult(GLUCOSE, {}, woman)).toThrow(
      expect.objectContaining({ code: 'RESULT_VALUE_TYPE_MISMATCH' }),
    );
    expect(() =>
      resolveResult(GLUCOSE, { valueNumeric: Number.NaN }, woman),
    ).toThrow(expect.objectContaining({ code: 'RESULT_VALUE_TYPE_MISMATCH' }));
  });

  it('ORD-035 calcula la bandera crítica sin que nadie la envíe', () => {
    expect(resolveResult(GLUCOSE, { valueNumeric: 25 }, woman)).toMatchObject({
      abnormalFlag: 'CRITICAL_LOW',
      referenceLow: 70,
      referenceHigh: 100,
    });
  });

  it('ORD-033 admite cualquier valor cuando el catálogo no declara la lista', () => {
    // Un analito codificado cuya lista nadie ha llenado todavía tiene que
    // seguir siendo transcribible: lo que falta es una fila de catálogo, no un
    // rechazo que bloquea el informe de hoy.
    const uncatalogued = { ...NITRITES, allowedValues: null };
    expect(
      resolveResult(uncatalogued, { valueCode: 'Dudoso' }, woman),
    ).toMatchObject({
      // prettier-ignore
      valueCode: 'Dudoso',
    });
  });
});
