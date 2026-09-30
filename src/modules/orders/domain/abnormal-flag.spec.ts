import { describe, expect, it } from 'vitest';

import {
  applicableRange,
  classifyNumeric,
  classifyQualitative,
  isCritical,
} from './abnormal-flag';
import { GLUCOSE, HAEMOGLOBIN, NITRITES } from './analyte.fixtures';
import type { PatientProfile, ReferenceRange } from './analyte';

/**
 * The flag: the number that decides whether somebody phones the patient
 * tonight.
 *
 * Exercised against the REAL seeded ranges — see `analyte.fixtures.ts` for why
 * round numbers would prove nothing.
 */

const woman: PatientProfile = { sex: 'FEMALE', ageDays: 12_000 };
const man: PatientProfile = { sex: 'MALE', ageDays: 12_000 };

describe('la bandera de anormalidad', () => {
  it('ORD-036 clasifica la misma hemoglobina distinto según el sexo del paciente', () => {
    // 12,5 g/dL: dentro de 12,0–15,5 (FEMALE) y por debajo de 13,0 (MALE).
    // Con un rango único, este número marcaría como anémica a media población
    // o a ninguna. Es el caso que justifica que el rango sea una tabla.
    expect(classifyNumeric(12.5, HAEMOGLOBIN, woman).flag).toBe('NORMAL');
    expect(classifyNumeric(12.5, HAEMOGLOBIN, man).flag).toBe('LOW');
  });

  it('ORD-037 congela el rango que aplicó, no el del otro sexo', () => {
    expect(classifyNumeric(12.5, HAEMOGLOBIN, woman)).toMatchObject({
      referenceLow: 12.0,
      referenceHigh: 15.5,
    });
    expect(classifyNumeric(12.5, HAEMOGLOBIN, man)).toMatchObject({
      referenceLow: 13.0,
      referenceHigh: 17.0,
    });
  });

  it('ORD-035 marca alto lo que supera el límite superior', () => {
    expect(classifyNumeric(18.2, HAEMOGLOBIN, man).flag).toBe('HIGH');
  });

  it('ORD-036 evalúa el rango crítico ANTES que el de referencia', () => {
    // 25 mg/dL está por debajo de 70 —bajo— y por debajo de 40 —crítico—.
    // Contestar `LOW` lo pondría en la misma lista que un 68.
    expect(classifyNumeric(25, GLUCOSE, woman).flag).toBe('CRITICAL_LOW');
    expect(classifyNumeric(480, GLUCOSE, woman).flag).toBe('CRITICAL_HIGH');
  });

  it('ORD-035 deja en bajo lo que sale de la referencia sin llegar al crítico', () => {
    expect(classifyNumeric(65, GLUCOSE, woman).flag).toBe('LOW');
    expect(classifyNumeric(150, GLUCOSE, woman).flag).toBe('HIGH');
    expect(classifyNumeric(88, GLUCOSE, woman).flag).toBe('NORMAL');
  });

  it('ORD-037 imprime como VALOR DE REFERENCIA el rango normal y no el crítico', () => {
    // Si la columna del 010B trajera 40–400, el paciente leería que cualquier
    // glucosa por debajo de 400 mg/dL está bien.
    expect(classifyNumeric(480, GLUCOSE, woman)).toMatchObject({
      flag: 'CRITICAL_HIGH',
      referenceLow: 70,
      referenceHigh: 100,
    });
  });

  it('ORD-038 deja la bandera VACÍA cuando ningún rango aplica, y no la marca normal', () => {
    // Sexo desconocido contra un analito cuyos dos rangos son por sexo: no hay
    // con qué comparar. `NORMAL` aquí sería indistinguible de un resultado
    // tranquilizador en la pantalla donde alguien decide no llamar.
    const unknown: PatientProfile = { sex: 'UNKNOWN', ageDays: 12_000 };
    const classified = classifyNumeric(12.5, HAEMOGLOBIN, unknown);

    expect(classified.flag).toBeNull();
    expect(classified.referenceLow).toBeNull();
  });

  it('ORD-036 nunca aplica un rango por edad a un paciente de edad desconocida', () => {
    const neonatal: ReferenceRange[] = [
      { rangeKind: 'REFERENCE', sex: null, ageMinDays: 0, ageMaxDays: 28, low: 14, high: 24, text: null }, // prettier-ignore
    ];
    // «No sabemos la edad» tratado como «cabe en la ventana» clasificaría a un
    // adulto con el rango de un neonato, que son justo los que más difieren.
    expect(
      applicableRange(neonatal, 'REFERENCE', { sex: null, ageDays: null }),
    ).toBeUndefined();
    expect(
      applicableRange(neonatal, 'REFERENCE', { sex: null, ageDays: 3 }),
    ).toBeDefined();
    expect(
      applicableRange(neonatal, 'REFERENCE', { sex: null, ageDays: 400 }),
    ).toBeUndefined();
  });

  it('ORD-036 prefiere el rango más específico sobre el que vale para todos', () => {
    const mixed: ReferenceRange[] = [
      { rangeKind: 'REFERENCE', sex: null, ageMinDays: null, ageMaxDays: null, low: 1, high: 100, text: null }, // prettier-ignore
      { rangeKind: 'REFERENCE', sex: 'FEMALE', ageMinDays: null, ageMaxDays: null, low: 5, high: 20, text: null }, // prettier-ignore
    ];
    // Tomar el primero haría que la respuesta dependiera del orden en que la
    // base devolvió las filas, que no es una respuesta.
    expect(applicableRange(mixed, 'REFERENCE', woman)?.low).toBe(5);
    expect(applicableRange(mixed, 'REFERENCE', man)?.low).toBe(1);
  });

  it('ORD-036 usa el crítico aunque no exista rango de referencia', () => {
    const onlyCritical: ReferenceRange[] = [
      { rangeKind: 'CRITICAL', sex: null, ageMinDays: null, ageMaxDays: null, low: 2.5, high: 6.5, text: null }, // prettier-ignore
    ];
    const analyte = { ranges: onlyCritical };

    expect(classifyNumeric(7.2, analyte, woman).flag).toBe('CRITICAL_HIGH');
    expect(classifyNumeric(4, analyte, woman).flag).toBeNull();
  });

  it('ORD-038 no inventa bandera para un rango que no acota nada', () => {
    // «Negativo» no es un intervalo: comparar contra él con `<` o `>` sería
    // inventar un orden que el analito no tiene.
    expect(classifyNumeric(1, { ranges: NITRITES.ranges }, woman).flag).toBeNull(); // prettier-ignore
  });

  it('ORD-037 congela el valor esperado de una determinación cualitativa', () => {
    expect(classifyQualitative(NITRITES, woman)).toEqual({
      flag: null,
      referenceLow: null,
      referenceHigh: null,
      referenceText: 'Negativo',
    });
  });

  it('ORD-060 reconoce las dos banderas que tienen que llegar hoy a una persona', () => {
    expect(isCritical('CRITICAL_LOW')).toBe(true);
    expect(isCritical('CRITICAL_HIGH')).toBe(true);
    expect(isCritical('HIGH')).toBe(false);
    expect(isCritical(null)).toBe(false);
  });
});
