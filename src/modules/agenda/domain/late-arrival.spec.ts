import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LATE_ARRIVAL_GRACE_MINUTES,
  arrivalDelayMinutes,
  lateArrivalWarningsFor,
} from './late-arrival';

/**
 * AG-118, AG-119, AG-142. The arrival delay, judged without a database and
 * without a clock.
 *
 * WHAT THIS FILE IS REALLY GUARDING is that late arrival never becomes a
 * status: every assertion here is about a NUMBER derived from two columns that
 * already exist, and the moment somebody adds a `LATE_ARRIVAL` state these
 * tests stop describing the system.
 */

/** 08:00 in Guayaquil on Monday 5 January 2026 (UTC-5). */
const EIGHT = new Date('2026-01-05T13:00:00Z');
const minutesAfter = (minutes: number): Date =>
  new Date(EIGHT.getTime() + minutes * 60_000);

describe('el retraso de llegada', () => {
  it('AG-118 calcula la diferencia en minutos entre la hora comprometida y la llegada', () => {
    expect(
      arrivalDelayMinutes({ startsAt: EIGHT, checkedInAt: minutesAfter(23) }),
    ).toBe(23);
  });

  it('AG-118 conserva el signo: llegar antes es negativo', () => {
    // Truncar a cero convertiría «llegó veinte minutos antes» en «llegó a la
    // hora», que es una afirmación distinta y falsa — y el dato sirve en el
    // mostrador y en la mediana de AG-141.
    expect(
      arrivalDelayMinutes({ startsAt: EIGHT, checkedInAt: minutesAfter(-20) }),
    ).toBe(-20);
  });

  it('AG-118 responde cero exacto en el instante comprometido', () => {
    expect(arrivalDelayMinutes({ startsAt: EIGHT, checkedInAt: EIGHT })).toBe(
      0,
    );
  });

  it('AG-118 no inventa un retraso para quien todavía no ha llegado', () => {
    // `0` diría «llegó puntual» de alguien que no ha venido: es la misma
    // distinción que AG-080 hace entre `null` y `0` en la tasa.
    expect(
      arrivalDelayMinutes({ startsAt: EIGHT, checkedInAt: null }),
    ).toBeNull();
  });

  it('AG-001, AG-118 dan el mismo número sea cual sea el huso de la sesión', () => {
    /**
     * NO ES UNA EXCEPCIÓN A AG-001, y por eso hay una prueba que lo fija: los
     * dos operandos son instantes absolutos (`timestamptz`), y la distancia
     * entre dos instantes es el mismo número en todos los husos. AG-001 rige
     * las preguntas que resuelven un DÍA, y ésta no pregunta por un día.
     *
     * La llegada de las 21:00 es justo el caso que rompería un cálculo que
     * pasara por la fecha civil: en UTC cae al día siguiente.
     */
    const nightAppointment = new Date('2026-01-05T02:00:00Z'); // 21:00 del 4
    const arrival = new Date('2026-01-05T02:30:00Z');

    expect(
      arrivalDelayMinutes({ startsAt: nightAppointment, checkedInAt: arrival }),
    ).toBe(30);
  });
});

describe('la advertencia de llegada tardía', () => {
  it('AG-119 advierte cuando el retraso supera el margen de la sede, con los dos números', () => {
    const warnings = lateArrivalWarningsFor(40, 15);

    expect(warnings).toHaveLength(1);
    // Los DOS números: «llegó tarde» sin el umbral no lo puede accionar quien
    // no conoce la regla de esa sede.
    expect(warnings[0]).toContain('40');
    expect(warnings[0]).toContain('15');
  });

  it('AG-119 calla justo en el umbral, que no es superarlo', () => {
    expect(lateArrivalWarningsFor(15, 15)).toEqual([]);
    expect(lateArrivalWarningsFor(16, 15)).toHaveLength(1);
  });

  it('AG-119 no advierte de quien llegó antes de su hora', () => {
    expect(lateArrivalWarningsFor(-30, 15)).toEqual([]);
  });

  it('AG-119 no advierte de una cita a la que nadie ha llegado', () => {
    expect(lateArrivalWarningsFor(null, 15)).toEqual([]);
  });

  it('AG-142 admite el margen cero, que es cómo una sede desactiva la política', () => {
    // `site_parameter_grace_is_not_negative` lo admite a propósito: sin él,
    // apagar la política exigiría una migración.
    expect(lateArrivalWarningsFor(1, 0)).toHaveLength(1);
    expect(lateArrivalWarningsFor(0, 0)).toEqual([]);
  });

  it('AG-142 arranca en los quince minutos que escribió la migración', () => {
    // El valor por defecto de `site_parameter.late_arrival_grace_minutes`.
    // Que sea el que la clínica quiere NO está decidido — la spec lo marca
    // como [NECESITA ACLARACIÓN] bajo AG-142 —, y un defecto es lo que hace
    // que el sistema arranque, no la prueba de que alguien lo eligió.
    expect(DEFAULT_LATE_ARRIVAL_GRACE_MINUTES).toBe(15);
  });
});
