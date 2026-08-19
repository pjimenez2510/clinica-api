import { afterEach, describe, expect, it } from 'vitest';

import { parseClinicalDate } from './clinic-time';
import {
  AGE_PRIORITY_BRACKETS,
  PRIORITY_LEVEL,
  ageInYearsOn,
  agePriorityBracketsOn,
  isPeriodInForce,
  priorityLevelOf,
} from './priority-level';

const d = parseClinicalDate;

/**
 * The derivation two modules share, as pure decisions.
 *
 * WHAT THIS LEVEL CAN PROVE AND THE INTEGRATION SUITE CANNOT: that the rules
 * are answers to a question about a DAY, so the same data gives the same
 * answer whatever clock, host or session the question arrives from. One test
 * moves `process.env.TZ` for exactly that — the failure mode it closes is the
 * one that already cost this project a day of neonate ages (AG-001, PA-030).
 *
 * The tests that name PA-034 to PA-038 stay in
 * `patients/domain/priority-groups.spec.ts`: those are about the catalogue of
 * the ten and what may be written, which did not move.
 */
describe('la prioridad que la agenda ordena', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  describe('la edad, que se deriva y no se guarda', () => {
    it('PA-035 counts a birthday as reached only from the day it falls', () => {
      const birth = d('1961-06-30');

      expect(ageInYearsOn(birth, d('2026-06-29'))).toBe(64);
      expect(ageInYearsOn(birth, d('2026-06-30'))).toBe(65);
    });

    it('PA-035 derives the same age whatever the process time zone', () => {
      const birth = d('1961-06-30');

      for (const tz of ['Asia/Tokyo', 'Pacific/Kiritimati', 'America/Denver']) {
        process.env.TZ = tz;
        expect(ageInYearsOn(birth, d('2026-06-30')), `with TZ=${tz}`).toBe(65);
      }
    });

    it('PA-035 names only the two brackets a birth date can settle on its own', () => {
      // The list `agenda` and `patients` both read. It is two of the ten, and
      // the compiler ties it to the catalogue over there: `priorityGroupsInForce`
      // returns `PriorityGroup[]` from exactly this function's output.
      expect([...AGE_PRIORITY_BRACKETS].sort()).toEqual([
        'CHILD_OR_ADOLESCENT',
        'OLDER_ADULT',
      ]);
    });

    it('PA-035 puts nobody in a bracket between the two thresholds', () => {
      expect(agePriorityBracketsOn(d('1990-03-15'), d('2026-08-16'))).toEqual(
        [],
      );
      expect(agePriorityBracketsOn(d('1950-01-01'), d('2026-08-16'))).toEqual([
        'OLDER_ADULT',
      ]);
      expect(agePriorityBracketsOn(d('2015-01-01'), d('2026-08-16'))).toEqual([
        'CHILD_OR_ADOLESCENT',
      ]);
    });
  });

  describe('la vigencia, resuelta al leer', () => {
    it('PA-036 stops counting a pregnancy whose expected date of delivery has passed, with nobody touching the row', () => {
      const pregnancy = { startsOn: d('2026-01-10'), endsOn: d('2026-08-15') };

      // The same row, unchanged, read on two days.
      expect(isPeriodInForce(pregnancy, d('2026-08-15'))).toBe(true);
      expect(isPeriodInForce(pregnancy, d('2026-08-16'))).toBe(false);
    });

    it('PA-036 does not count a period that has not started yet', () => {
      const period = { startsOn: d('2026-09-01'), endsOn: null };

      expect(isPeriodInForce(period, d('2026-08-31'))).toBe(false);
      expect(isPeriodInForce(period, d('2026-09-01'))).toBe(true);
    });

    it('PA-037 keeps a closed state answering why the person had priority back then', () => {
      const disability = { startsOn: d('2024-02-01'), endsOn: d('2026-03-31') };

      // Closed today, and still the answer to «¿por qué en marzo?». The row is
      // never deleted, so the past keeps its explanation.
      expect(isPeriodInForce(disability, d('2026-08-16'))).toBe(false);
      expect(isPeriodInForce(disability, d('2026-03-15'))).toBe(true);
    });

    it('PA-037 leaves an open state counting indefinitely', () => {
      const disability = { startsOn: d('2024-02-01'), endsOn: null };

      expect(isPeriodInForce(disability, d('2099-01-01'))).toBe(true);
    });
  });

  describe('el nivel', () => {
    const ADULT = d('1990-03-15');

    it('PA-041 gives priority 1 to a patient with an assessment in force and 2 to one without', () => {
      const on = d('2026-08-16');
      const pregnancy = { startsOn: d('2026-01-10'), endsOn: d('2026-09-20') };

      expect(priorityLevelOf({ birthDate: ADULT, periods: [] }, on)).toBe(
        PRIORITY_LEVEL.STANDARD,
      );
      expect(
        priorityLevelOf({ birthDate: ADULT, periods: [pregnancy] }, on),
      ).toBe(PRIORITY_LEVEL.PRIORITY);
    });

    it('PA-041 drops a patient back to ordinary priority once the period lapses, without any write', () => {
      const pregnancy = { startsOn: d('2026-01-10'), endsOn: d('2026-08-15') };
      const patient = { birthDate: ADULT, periods: [pregnancy] };

      expect(priorityLevelOf(patient, d('2026-08-15'))).toBe(
        PRIORITY_LEVEL.PRIORITY,
      );
      expect(priorityLevelOf(patient, d('2026-08-16'))).toBe(
        PRIORITY_LEVEL.STANDARD,
      );
    });

    it('PA-041 gives priority 1 from the birth date alone, with no row at all', () => {
      expect(
        priorityLevelOf({ birthDate: d('1950-01-01'), periods: [] }, d('2026-08-16')), // prettier-ignore
      ).toBe(PRIORITY_LEVEL.PRIORITY);
    });

    it('PA-041 makes the level change ON the 65th birthday, not a year later', () => {
      /**
       * ═══════════════════════════════════════════════════════════════════════
       * EL LÍMITE, QUE ES DONDE VIVE EL DEFECTO.
       * ═══════════════════════════════════════════════════════════════════════
       *
       * Las pruebas de esta sección usaban 36 y 76 años: dos edades a las que
       * `>=` y `>` responden lo mismo. Una auditoría por mutación cambió
       * `age >= 65 || age < 18` por `age > 65 || age <= 18` y la suite entera
       * siguió en verde — es decir, un paciente perdía la prioridad el día que
       * cumplía 65 y la recuperaba un año después, y nada lo decía. Son los
       * umbrales del artículo 36 de la Constitución y del Código de la Niñez.
       */
      const patient = { birthDate: d('1961-06-30'), periods: [] };

      expect(priorityLevelOf(patient, d('2026-06-29'))).toBe(
        PRIORITY_LEVEL.STANDARD,
      );
      expect(priorityLevelOf(patient, d('2026-06-30'))).toBe(
        PRIORITY_LEVEL.PRIORITY,
      );
    });

    it('PA-041 keeps priority until the day BEFORE the 18th birthday, and drops it on the day', () => {
      const patient = { birthDate: d('2008-06-30'), periods: [] };

      expect(priorityLevelOf(patient, d('2026-06-29'))).toBe(
        PRIORITY_LEVEL.PRIORITY,
      );
      expect(priorityLevelOf(patient, d('2026-06-30'))).toBe(
        PRIORITY_LEVEL.STANDARD,
      );
    });

    it('PA-042 computes the order from the periods alone, never from which group it is', () => {
      /**
       * The signature is the guarantee: `priorityLevelOf` takes periods and no
       * group code, so the query that feeds a listing has no reason to select
       * one. A rule enforced by what the function cannot receive does not
       * depend on anybody remembering it while mapping a response — and it is
       * what lets `agenda` order the waiting list without ever seeing a motive
       * (AG-061, AG-073).
       */
      const on = d('2026-08-16');
      const period = { startsOn: d('2026-01-10'), endsOn: null };

      expect(priorityLevelOf({ birthDate: ADULT, periods: [period] }, on)).toBe(
        PRIORITY_LEVEL.PRIORITY,
      );
    });
  });
});
