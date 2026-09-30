import { describe, expect, it } from 'vitest';

import {
  ANTIMICROBIAL_VALIDITY_DAYS,
  VALIDITY_DAYS,
  validThrough,
  validityDaysFor,
} from './prescription-validity';

/**
 * PR-050 to PR-053. Arts. 17, 18 and 19 of the Resolución ACESS-2023-0030.
 *
 * ⚠️ THE TIME-ZONE CASE IS THE ONE THAT MATTERS. Everything else here is a
 * lookup in a table of three numbers; the zone is where the real defect lives,
 * and it is the same one `clinical-date-timezone.spec.ts` exists for: a
 * prescription issued at 21:00 in Guayaquil is of THAT day, and read in UTC it
 * would be of the next — so the pharmacy would refuse it a day early.
 */
describe('la vigencia de la receta', () => {
  it('PR-050 da tres días a la receta de consulta externa', () => {
    expect(validityDaysFor('AMBULATORY')).toBe(3);
    expect(VALIDITY_DAYS.AMBULATORY).toBe(3);
  });

  it('PR-051 da un día a la de emergencia y un día a la de hospitalización', () => {
    // Hoy inalcanzables —esta clínica es ambulatoria y el esquema no distingue
    // la modalidad—, y escritas porque el día que se abra una emergencia el
    // número cambia sin que nadie avise.
    expect(validityDaysFor('EMERGENCY')).toBe(1);
    expect(validityDaysFor('HOSPITALISATION')).toBe(1);
  });

  it('PR-052 da tres días al antimicrobiano', () => {
    expect(ANTIMICROBIAL_VALIDITY_DAYS).toBe(3);
    expect(validityDaysFor('AMBULATORY', { antimicrobial: true })).toBe(3);
  });

  it('PR-052 toma el plazo MÁS CORTO cuando las dos reglas concurren', () => {
    // La norma no dice cuál gana en un antimicrobiano de emergencia. El menor
    // es la única lectura que no puede autorizar una dispensación tardía.
    expect(validityDaysFor('EMERGENCY', { antimicrobial: true })).toBe(1);
    expect(validityDaysFor('HOSPITALISATION', { antimicrobial: true })).toBe(1);
  });

  it('PR-050 cuenta el día de la prescripción como el primero de los tres', () => {
    // Lectura estricta de «contados a partir de la fecha de prescripción»
    // (pregunta abierta P-1): emitida el 14, el último día válido es el 16.
    expect(validThrough(new Date('2026-09-14T14:00:00Z'), 3)).toBe(
      '2026-09-16',
    );
  });

  it('PR-050 resuelve la fecha en América/Guayaquil y no en el huso de la sesión', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL DEFECTO QUE ESTA PRUEBA EXISTE PARA CAZAR
     * ═══════════════════════════════════════════════════════════════════════
     *
     * 02:00 UTC del día 15 son las 21:00 del día 14 en Guayaquil. Leído en UTC,
     * la receta sería del 15 y vencería el 17; leído en Ecuador es del 14 y
     * vence el 16. Un día de más en la vigencia de un antimicrobiano es una
     * dispensación fuera de plazo que la farmacia acepta creyendo el papel.
     */
    const lateEvening = new Date('2026-09-15T02:00:00Z');

    expect(validThrough(lateEvening, 3)).toBe('2026-09-16');
    // Y la misma emisión bajo otro huso da OTRA fecha, que es lo que demuestra
    // que la zona se lee y no se asume.
    expect(validThrough(lateEvening, 3, 'Asia/Tokyo')).toBe('2026-09-17');
  });

  it('PR-050 cruza el fin de mes contando días del calendario', () => {
    expect(validThrough(new Date('2026-09-30T14:00:00Z'), 3)).toBe(
      '2026-10-02',
    );
  });

  it('PR-053 rechaza una vigencia de menos de un día en vez de inventarla', () => {
    expect(() => validThrough(new Date('2026-09-14T14:00:00Z'), 0)).toThrow(
      RangeError,
    );
    expect(() => validThrough(new Date('2026-09-14T14:00:00Z'), 1.5)).toThrow(
      RangeError,
    );
  });
});
