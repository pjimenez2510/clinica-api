import { describe, expect, it } from 'vitest';

import {
  addDays,
  clinicalDateOf,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';

import { restOverlapNoticeOf, type RestOverlap } from './patient-merge';

/** Every date derives from one instant taken at the start of the run. */
const today: ClinicalDate = clinicalDateOf(new Date());
const label = (day: ClinicalDate) => day.split('-').reverse().join('/');

describe('PA-062 el aviso de reposos solapados al fusionar', () => {
  it('PA-062 sin solapes no hay aviso', () => {
    expect(restOverlapNoticeOf([])).toBeNull();
  });

  it('PA-062 nombra cada reposo por su numero y su periodo, y dice que se anule el que no corresponda', () => {
    const overlaps: RestOverlap[] = [
      {
        absorbed: { number: 12, from: today, to: addDays(today, 1), maternity: false }, // prettier-ignore
        surviving: { number: 7, from: addDays(today, -1), to: addDays(today, 9), maternity: true }, // prettier-ignore
      },
    ];
    expect(restOverlapNoticeOf(overlaps)).toBe(
      `La fusión junta reposos que se solapan con una maternidad: el N.º 12 (del ${label(today)} al ${label(addDays(today, 1))}) con el N.º 7 (maternidad, del ${label(addDays(today, -1))} al ${label(addDays(today, 9))}). Anule desde su atención el que no corresponda.`,
    );
  });

  it('PA-062 con varios pares, los separa', () => {
    const rest = (number: number, maternity: boolean) => ({
      number,
      from: today,
      to: today,
      maternity,
    });
    const notice = restOverlapNoticeOf([
      { absorbed: rest(1, false), surviving: rest(2, true) },
      { absorbed: rest(1, false), surviving: rest(3, true) },
    ]);
    const period = `del ${label(today)} al ${label(today)}`;
    expect(notice).toContain(`el N.º 1 (${period}) con el N.º 2`);
    expect(notice).toContain(`; el N.º 1 (${period}) con el N.º 3`);
  });
});
