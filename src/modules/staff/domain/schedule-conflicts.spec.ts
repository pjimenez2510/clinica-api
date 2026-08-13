import { describe, expect, it } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';

import {
  type BookedInterval,
  type CoveringRule,
  scheduleConflicts,
} from './schedule-conflicts';

/**
 * What a schedule change strands (ST-043).
 *
 * ALL TIMES ARE ECUADORIAN WALL CLOCK expressed with their offset. Writing
 * `2026-09-14T08:00:00Z` instead of `-05:00` would move every appointment five
 * hours and make the assertions agree with the wrong thing — which is the bug
 * `clinic-time` exists to prevent, so the tests may not reintroduce it.
 *
 * 2026-09-14 is a Monday (ISO weekday 1).
 */
const SITE = '11111111-1111-4111-8111-111111111111';
const OTHER_SITE = '22222222-2222-4222-8222-222222222222';

const MORNING: CoveringRule = {
  siteId: SITE,
  weekday: 1,
  startMinutes: 8 * 60,
  endMinutes: 12 * 60,
  validFrom: parseClinicalDate('2026-01-01'),
  validTo: null,
  active: true,
};

function booked(
  id: string,
  from: string,
  to: string,
  siteId = SITE,
): BookedInterval {
  return {
    id,
    siteId,
    startsAt: new Date(`2026-09-14T${from}:00-05:00`),
    endsAt: new Date(`2026-09-14T${to}:00-05:00`),
  };
}

describe('los conflictos de un cambio de horario', () => {
  it('ST-043 no lista una cita que la regla cubre entera', () => {
    expect(scheduleConflicts([booked('a', '09:00', '09:20')], [MORNING])).toEqual([]); // prettier-ignore
  });

  it('ST-043 lista la cita que el nuevo horario deja fuera', () => {
    const conflicts = scheduleConflicts(
      [booked('a', '09:00', '09:20'), booked('b', '13:00', '13:20')],
      [MORNING],
    );

    expect(conflicts.map((conflict) => conflict.agendaEntryId)).toEqual(['b']);
    expect(conflicts[0]).toMatchObject({ siteId: SITE, date: '2026-09-14' });
  });

  it('ST-043 media cita fuera es una cita fuera: el médico no está la segunda mitad', () => {
    expect(
      scheduleConflicts([booked('a', '11:40', '12:10')], [MORNING]).map(
        (conflict) => conflict.agendaEntryId,
      ),
    ).toEqual(['a']);
  });

  it('ST-043 no cose dos reglas contiguas para cubrir una cita a caballo', () => {
    // Morning and afternoon can carry different slot lengths and different
    // service types, so an appointment straddling them belongs to neither.
    const afternoon: CoveringRule = {
      ...MORNING,
      startMinutes: 12 * 60,
      endMinutes: 16 * 60,
    };

    expect(
      scheduleConflicts(
        [booked('a', '11:50', '12:10')],
        [MORNING, afternoon],
      ).map(
        // prettier-ignore
        (conflict) => conflict.agendaEntryId,
      ),
    ).toEqual(['a']);
  });

  it('ST-046 una regla de otra sede no cubre la cita: la sede es parte de la regla', () => {
    expect(
      scheduleConflicts(
        [booked('a', '09:00', '09:20', OTHER_SITE)],
        [MORNING],
      ).map((conflict) => conflict.agendaEntryId),
    ).toEqual(['a']);
  });

  it('ST-043 una regla de otro día de la semana no cubre la cita', () => {
    expect(
      scheduleConflicts([booked('a', '09:00', '09:20')], [{ ...MORNING, weekday: 2 }]) // prettier-ignore
        .map((conflict) => conflict.agendaEntryId),
    ).toEqual(['a']);
  });

  it('ST-041 una regla ya cerrada antes de esa fecha no cubre nada', () => {
    expect(
      scheduleConflicts(
        [booked('a', '09:00', '09:20')],
        [{ ...MORNING, validTo: parseClinicalDate('2026-09-13') }],
      ).map((conflict) => conflict.agendaEntryId),
    ).toEqual(['a']);
  });

  it('ST-041 una regla cerrada EL MISMO día todavía la cubre: el fin es inclusivo', () => {
    expect(
      scheduleConflicts(
        [booked('a', '09:00', '09:20')],
        [{ ...MORNING, validTo: parseClinicalDate('2026-09-14') }],
      ),
    ).toEqual([]);
  });

  it('ST-043 una regla desactivada no cubre nada', () => {
    expect(
      scheduleConflicts([booked('a', '09:00', '09:20')], [{ ...MORNING, active: false }]) // prettier-ignore
        .map((conflict) => conflict.agendaEntryId),
    ).toEqual(['a']);
  });

  it('ST-043 sin ninguna regla vigente todas las citas quedan como conflicto', () => {
    const conflicts = scheduleConflicts(
      [booked('a', '09:00', '09:20'), booked('b', '10:00', '10:20')],
      [],
    );

    expect(conflicts).toHaveLength(2);
    // The function LISTS and does nothing else: the intervals come back
    // untouched, which is what lets a human phone each patient.
    expect(conflicts[0]?.startsAt).toEqual(new Date('2026-09-14T09:00:00-05:00')); // prettier-ignore
  });

  it('ST-043 una cita que cruza medianoche se reporta, no se disimula', () => {
    // No weekly rule can cover it — `end_time < 24:00` is a CHECK in the base
    // — and reading `endMinutes = 0` as «end of day» would hide it silently.
    const crossing: BookedInterval = {
      id: 'a',
      siteId: SITE,
      startsAt: new Date('2026-09-14T23:40:00-05:00'),
      endsAt: new Date('2026-09-15T00:10:00-05:00'),
    };

    expect(
      scheduleConflicts([crossing], [{ ...MORNING, startMinutes: 0, endMinutes: 1439 }]) // prettier-ignore
        .map((conflict) => conflict.agendaEntryId),
    ).toEqual(['a']);
  });

  it('ST-043 la fecha del conflicto es la ecuatoriana, no la del servidor', () => {
    // 19:00 in Quito is 00:00 UTC of the NEXT day. A `::date` on the session's
    // zone would file this appointment under the 15th and look for a Tuesday
    // rule that does not exist.
    const evening = booked('a', '19:00', '19:20');

    expect(scheduleConflicts([evening], [])[0]?.date).toBe('2026-09-14');
  });
});
