import { describe, expect, it } from 'vitest';

import {
  addDays,
  clinicalDateOf,
  isoWeekdayOf,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';

import { legalDueDate } from './legal-due-date';

/**
 * Every date is derived from the clock and named by its weekday, so the
 * arithmetic under test is visible in the expectation: «a Monday plus 14».
 */
function next(isoWeekday: number): ClinicalDate {
  let day = clinicalDateOf(new Date());
  while (isoWeekdayOf(day) !== isoWeekday) day = addDays(day, 1);
  return day;
}

const MONDAY = 1;
const FRIDAY = 5;
const SATURDAY = 6;
const NONE = new Set<string>();

describe('legalDueDate — el vencimiento de una solicitud del titular', () => {
  it('PD-032 acceso recibido un lunes sin feriados: diez días hábiles (lunes + 14) vencen antes que quince calendario', () => {
    const monday = next(MONDAY);
    expect(legalDueDate('ACCESS', monday, NONE)).toBe(addDays(monday, 14));
  });

  it('PD-032 el día de la recepción no cuenta, aunque sea hábil: recibido un viernes vence el viernes + 14', () => {
    const friday = next(FRIDAY);
    expect(legalDueDate('RECTIFICATION', friday, NONE)).toBe(
      addDays(friday, 14),
    );
  });

  it('PD-032 recibido en fin de semana, los hábiles empiezan el lunes', () => {
    const saturday = next(SATURDAY);
    expect(legalDueDate('OBJECTION', saturday, NONE)).toBe(
      addDays(saturday, 13),
    );
  });

  it('PD-032 con feriados de toda la clínica, los quince días calendario son el tope de acceso, rectificación, eliminación y oposición', () => {
    const monday = next(MONDAY);
    const holidays = new Set([1, 2, 3].map((d) => addDays(monday, d)));

    // Ten working days would end on the Thursday of the third week (+17).
    expect(legalDueDate('ERASURE', monday, holidays)).toBe(addDays(monday, 15));
  });

  it('PD-032 la portabilidad no tiene tope calendario: diez días hábiles, feriados incluidos', () => {
    const monday = next(MONDAY);
    const holidays = new Set([1, 2, 3].map((d) => addDays(monday, d)));

    expect(legalDueDate('PORTABILITY', monday, holidays)).toBe(
      addDays(monday, 17),
    );
  });

  it('PD-032 la suspensión vence a los tres días hábiles: recibida un viernes, el miércoles', () => {
    const friday = next(FRIDAY);
    expect(legalDueDate('SUSPENSION', friday, NONE)).toBe(addDays(friday, 5));
  });

  it('PD-032 un feriado de fin de semana no resta ningún día hábil', () => {
    const monday = next(MONDAY);
    const sunday = new Set([addDays(monday, 6)]);
    expect(legalDueDate('PORTABILITY', monday, sunday)).toBe(
      addDays(monday, 14),
    );
  });
});

describe('legalDueDate — el horizonte de feriados', () => {
  it('PD-032 si los feriados leídos no alcanzan, falla en vez de fijar un vencimiento que puede estar mal', () => {
    const monday = next(MONDAY);
    // Every day of the horizon is a holiday: no working day exists in it.
    const allHolidays = new Set(
      Array.from({ length: 40 }, (_, d) => addDays(monday, d + 1)),
    );
    expect(() => legalDueDate('SUSPENSION', monday, allHolidays)).toThrow(
      RangeError,
    );
    // Control: with a week of holidays it still resolves.
    const week = new Set([1, 2, 3, 4, 5].map((d) => addDays(monday, d)));
    expect(legalDueDate('SUSPENSION', monday, week)).toBe(addDays(monday, 9));
  });
});
