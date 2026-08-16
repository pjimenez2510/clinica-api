import { afterEach, describe, expect, it } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';

import {
  PriorityGroupEvidenceRequiredError,
  PriorityGroupNotRecordableError,
  PriorityGroupPeriodInvalidError,
} from './patient.errors';
import {
  AGE_DERIVED_PRIORITY_GROUPS,
  PRIORITY_GROUPS,
  PRIORITY_LEVEL,
  RECORDABLE_PRIORITY_GROUPS,
  RESTRICTED_PRIORITY_GROUPS,
  assertRecordablePriorityGroup,
  ageInYearsOn,
  clinicalDateToday,
  isPeriodInForce,
  isRestrictedPriorityGroup,
  priorityGroupsInForce,
  priorityLevelOf,
} from './priority-groups';

const d = parseClinicalDate;

/**
 * The priority groups of article 35, as pure decisions.
 *
 * WHAT THIS LEVEL CAN PROVE AND THE INTEGRATION SUITE CANNOT: that the rules
 * are answers to a question about a DAY, so the same data gives the same answer
 * whatever clock, host or session the question arrives from. Two tests move
 * `process.env.TZ` for exactly that — the failure mode they close is the one
 * that already cost this project a day of neonate ages (AG-001, PA-030).
 */
describe('grupos prioritarios', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  describe('la enumeración', () => {
    it('PA-034 admits the ten groups of article 35, six from the first sentence and four from the second', () => {
      expect([...PRIORITY_GROUPS].sort()).toEqual(
        [
          // First sentence.
          'OLDER_ADULT',
          'CHILD_OR_ADOLESCENT',
          'PREGNANT',
          'DISABILITY',
          'DEPRIVED_OF_LIBERTY',
          'CATASTROPHIC_ILLNESS',
          // Second sentence: «la misma atención prioritaria» (D-027).
          'AT_RISK',
          'DOMESTIC_OR_SEXUAL_VIOLENCE_VICTIM',
          'CHILD_ABUSE_VICTIM',
          'DISASTER_VICTIM',
        ].sort(),
      );
    });

    it('PA-034 puts the four groups of the second sentence behind their own reading level', () => {
      expect([...RESTRICTED_PRIORITY_GROUPS].sort()).toEqual([
        'AT_RISK',
        'CHILD_ABUSE_VICTIM',
        'DISASTER_VICTIM',
        'DOMESTIC_OR_SEXUAL_VIOLENCE_VICTIM',
      ]);
      // And the six of the first sentence are NOT restricted: reading level is
      // the only thing that separates them.
      expect(isRestrictedPriorityGroup('PREGNANT')).toBe(false);
      expect(isRestrictedPriorityGroup('DISABILITY')).toBe(false);
    });

    it('PA-035 leaves the two age-derived groups out of what can be stored', () => {
      expect([...AGE_DERIVED_PRIORITY_GROUPS].sort()).toEqual([
        'CHILD_OR_ADOLESCENT',
        'OLDER_ADULT',
      ]);
      expect(RECORDABLE_PRIORITY_GROUPS).not.toContain('OLDER_ADULT');
      expect(RECORDABLE_PRIORITY_GROUPS).not.toContain('CHILD_OR_ADOLESCENT');
      // The two lists partition the catalogue: a group that is in neither, or
      // in both, is a group whose behaviour nobody decided.
      expect(
        RECORDABLE_PRIORITY_GROUPS.length + AGE_DERIVED_PRIORITY_GROUPS.length,
      ).toBe(PRIORITY_GROUPS.length);
    });
  });

  describe('la edad, que se deriva y no se guarda', () => {
    it('PA-035 counts a birthday as reached only from the day it falls', () => {
      const birth = d('1961-06-30');

      expect(ageInYearsOn(birth, d('2026-06-29'))).toBe(64);
      expect(ageInYearsOn(birth, d('2026-06-30'))).toBe(65);
    });

    it('PA-035 makes someone an older adult the day they turn 65, not before', () => {
      const patient = { birthDate: d('1961-06-30'), recorded: [] };

      expect(priorityGroupsInForce(patient, d('2026-06-29'))).toEqual([]);
      expect(priorityGroupsInForce(patient, d('2026-06-30'))).toEqual([
        'OLDER_ADULT',
      ]);
    });

    it('PA-035 stops treating a person as an adolescent the day they turn 18', () => {
      const patient = { birthDate: d('2008-06-30'), recorded: [] };

      expect(priorityGroupsInForce(patient, d('2026-06-29'))).toEqual([
        'CHILD_OR_ADOLESCENT',
      ]);
      expect(priorityGroupsInForce(patient, d('2026-06-30'))).toEqual([]);
    });

    it('PA-035 derives the same age whatever the process time zone', () => {
      const birth = d('1961-06-30');

      for (const tz of ['Asia/Tokyo', 'Pacific/Kiritimati', 'America/Denver']) {
        process.env.TZ = tz;
        expect(ageInYearsOn(birth, d('2026-06-30')), `with TZ=${tz}`).toBe(65);
      }
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

    it('PA-036 resolves the validity against the Ecuadorian day and not the UTC one', () => {
      /**
       * 21:30 on 15 August in Guayaquil, which is already 16 August in UTC.
       *
       * A pregnancy ending on the 15th still counts for the last patient of
       * that evening. Taking the date from `toISOString()` — the obvious
       * one-liner — would have dropped her priority at 19:00 local, every day,
       * for the whole afternoon shift. Same failure `encounter_freeze_age` had
       * to be corrected for.
       */
      const evening = new Date('2026-08-16T02:30:00Z');
      const pregnancy = { startsOn: d('2026-01-10'), endsOn: d('2026-08-15') };

      expect(clinicalDateToday(evening)).toBe('2026-08-15');
      expect(isPeriodInForce(pregnancy, clinicalDateToday(evening))).toBe(true);
      expect(evening.toISOString().slice(0, 10)).toBe('2026-08-16');
    });

    it('PA-036 resolves the same Ecuadorian day whatever the process time zone', () => {
      const evening = new Date('2026-08-16T02:30:00Z');

      for (const tz of ['Asia/Tokyo', 'Pacific/Kiritimati', 'America/Denver']) {
        process.env.TZ = tz;
        expect(clinicalDateToday(evening), `with TZ=${tz}`).toBe('2026-08-15');
      }
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

  describe('la prioridad que la agenda ordena', () => {
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

    it('PA-042 computes the order from the periods alone, never from which group it is', () => {
      /**
       * The signature is the guarantee: `priorityLevelOf` takes periods and no
       * group code, so the query that feeds a listing has no reason to select
       * one. A rule enforced by what the function cannot receive does not
       * depend on anybody remembering it while mapping a response.
       */
      const on = d('2026-08-16');
      const period = { startsOn: d('2026-01-10'), endsOn: null };

      expect(priorityLevelOf({ birthDate: ADULT, periods: [period] }, on)).toBe(
        PRIORITY_LEVEL.PRIORITY,
      );
    });

    it('PA-034 counts the restricted groups of the second sentence for the order like any other', () => {
      const on = d('2026-08-16');
      const patient = {
        birthDate: ADULT,
        recorded: [
          {
            group: 'DOMESTIC_OR_SEXUAL_VIOLENCE_VICTIM' as const,
            startsOn: d('2026-05-01'),
            endsOn: null,
          },
        ],
      };

      expect(priorityGroupsInForce(patient, on)).toEqual([
        'DOMESTIC_OR_SEXUAL_VIOLENCE_VICTIM',
      ]);
      expect(
        priorityLevelOf({ birthDate: ADULT, periods: patient.recorded }, on),
      ).toBe(PRIORITY_LEVEL.PRIORITY);
    });
  });

  describe('lo que se puede escribir', () => {
    const VALID = {
      group: 'DISABILITY',
      startsOn: d('2026-01-10'),
      endsOn: null,
      origin: 'SELF_DECLARED' as const,
      evidenceDocument: null,
    };

    it('PA-033 accepts an assessment with group, period, origin and nothing else required', () => {
      expect(assertRecordablePriorityGroup(VALID)).toBe('DISABILITY');
    });

    it('PA-035 refuses to store a group that is derived from the birth date', () => {
      expect(() =>
        assertRecordablePriorityGroup({ ...VALID, group: 'OLDER_ADULT' }),
      ).toThrow(PriorityGroupNotRecordableError);
    });

    it('PA-036 refuses a pregnancy with no expected date of delivery and no end', () => {
      expect(() =>
        assertRecordablePriorityGroup({
          ...VALID,
          group: 'PREGNANT',
          endsOn: null,
        }),
      ).toThrow(PriorityGroupPeriodInvalidError);
    });

    it('PA-036 accepts a pregnancy that carries its expected date of delivery', () => {
      expect(
        assertRecordablePriorityGroup({
          ...VALID,
          group: 'PREGNANT',
          endsOn: d('2026-12-01'),
        }),
      ).toBe('PREGNANT');
    });

    it('PA-036 refuses a period that ends before it starts', () => {
      expect(() =>
        assertRecordablePriorityGroup({ ...VALID, endsOn: d('2026-01-09') }),
      ).toThrow(PriorityGroupPeriodInvalidError);
    });

    it('PA-038 refuses an accredited record that does not name its document', () => {
      expect(() =>
        assertRecordablePriorityGroup({
          ...VALID,
          origin: 'ACCREDITED',
          evidenceDocument: null,
        }),
      ).toThrow(PriorityGroupEvidenceRequiredError);

      // A blank one is not a document either.
      expect(() =>
        assertRecordablePriorityGroup({
          ...VALID,
          origin: 'ACCREDITED',
          evidenceDocument: '   ',
        }),
      ).toThrow(PriorityGroupEvidenceRequiredError);
    });

    it('PA-038 accepts an accredited record that names the document, and a self-declared one that does not', () => {
      expect(
        assertRecordablePriorityGroup({
          ...VALID,
          origin: 'ACCREDITED',
          evidenceDocument: 'Carné del CONADIS 1234',
        }),
      ).toBe('DISABILITY');
      expect(
        assertRecordablePriorityGroup({
          ...VALID,
          origin: 'SELF_DECLARED',
          evidenceDocument: null,
        }),
      ).toBe('DISABILITY');
    });
  });
});
