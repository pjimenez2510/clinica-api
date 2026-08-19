import { afterEach, describe, expect, it } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';
import { patientAgeOn } from './patient-age';

/**
 * The derived age (PA-030).
 *
 * SEVERAL TESTS MOVE `process.env.TZ`, like `clinic-time.spec.ts` and
 * `test/integration/clinical-date-timezone.spec.ts`. Node re-reads it, so it
 * is the cheapest proof that the answer does not depend on how a container, a
 * cloud provider or a developer's laptop happens to be configured — which is
 * the whole requirement: the age is resolved on the Ecuadorian date.
 */
const d = parseClinicalDate;

const alive = (birthDate: string) => ({
  birthDate: d(birthDate),
  deceasedAt: null,
});

describe('the age of a patient', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('PA-030 gives the same age under Asia/Tokyo as under the clinic zone', () => {
    // The guarantee is not "it works here": it is that nothing in the
    // calculation reads the host's zone.
    const expected = patientAgeOn(alive('2026-08-01'), d('2026-08-16'));

    for (const tz of ['Asia/Tokyo', 'Pacific/Kiritimati', 'America/Denver']) {
      process.env.TZ = tz;
      expect(
        patientAgeOn(alive('2026-08-01'), d('2026-08-16')),
        `with TZ=${tz}`,
      ).toEqual(expected);
    }
    expect(expected).toEqual({ years: 0, months: null, days: 15 });
  });

  it('PA-030 expresses a newborn of zero days in days', () => {
    // Twenty minutes old. The chart exists before any paperwork does, and the
    // ministry classifies this patient by `age_days`, not by years.
    expect(patientAgeOn(alive('2026-08-16'), d('2026-08-16'))).toEqual({
      years: 0,
      months: null,
      days: 0,
    });
  });

  it('PA-030 still expresses 28 completed days in days', () => {
    expect(patientAgeOn(alive('2026-07-19'), d('2026-08-16'))).toEqual({
      years: 0,
      months: null,
      days: 28,
    });
  });

  it('PA-030 stops expressing the age in days at 29 completed days', () => {
    // The neonatal period ends here. Reporting 29 days would be reporting a
    // classification the RDACAA no longer uses for this patient.
    expect(patientAgeOn(alive('2026-07-18'), d('2026-08-16'))).toEqual({
      years: 0,
      months: 0,
      days: null,
    });
  });

  // ---------------------------------------------------------------------
  // Months (D-035 a): the unit a paediatric dose table is written in
  // ---------------------------------------------------------------------

  it('PA-030 expresses an infant of seven months in months', () => {
    // «Menos de 1 año» is true and useless: paediatric dosing goes by month.
    expect(patientAgeOn(alive('2026-01-16'), d('2026-08-16'))).toEqual({
      years: 0,
      months: 7,
      days: null,
    });
  });

  it('PA-030 gives the same months under Asia/Tokyo as under the clinic zone', () => {
    const expected = patientAgeOn(alive('2026-01-16'), d('2026-08-16'));

    for (const tz of ['Asia/Tokyo', 'Pacific/Kiritimati', 'America/Denver']) {
      process.env.TZ = tz;
      expect(
        patientAgeOn(alive('2026-01-16'), d('2026-08-16')),
        `with TZ=${tz}`,
      ).toEqual(expected);
    }
  });

  it('PA-030 never offers days and months at the same time', () => {
    // The overlap decision. A 20-day-old HAS zero completed months, and
    // publishing both invites the screen to render «0 meses» for a patient
    // the ministry classifies by day.
    expect(patientAgeOn(alive('2026-07-27'), d('2026-08-16'))).toEqual({
      years: 0,
      months: null,
      days: 20,
    });
  });

  it('PA-030 hands over from days to months at 29 completed days', () => {
    // 28 days is still the neonatal period; 29 is no longer, and from that day
    // the age has a unit again — 0 completed months for two or three days,
    // which is what the calendar says and not a gap in the answer.
    expect(patientAgeOn(alive('2026-07-19'), d('2026-08-16'))).toMatchObject({
      months: null,
      days: 28,
    });
    expect(patientAgeOn(alive('2026-07-18'), d('2026-08-16'))).toMatchObject({
      months: 0,
      days: null,
    });
  });

  it('PA-030 counts the day of the month itself as a completed month', () => {
    expect(patientAgeOn(alive('2026-07-16'), d('2026-08-16')).months).toBe(1);
    // One day short, and it is still zero completed months.
    expect(patientAgeOn(alive('2026-07-17'), d('2026-08-16')).months).toBe(0);
  });

  it('PA-030 still expresses eleven months in months, and stops at the first birthday', () => {
    expect(patientAgeOn(alive('2025-09-16'), d('2026-08-16'))).toEqual({
      years: 0,
      months: 11,
      days: null,
    });
    // The first birthday: years is the unit again, and months would be noise
    // nobody would render — «12 meses» next to «1 año».
    expect(patientAgeOn(alive('2025-08-16'), d('2026-08-16'))).toEqual({
      years: 1,
      months: null,
      days: null,
    });
  });

  it('PA-030 counts months for someone born on 29 February', () => {
    // Born 2024-02-29. The first completed month lands on 29 March, the same
    // day the neonatal period ends, so it is the first month this patient is
    // reported in months at all — one, not zero.
    expect(patientAgeOn(alive('2024-02-29'), d('2024-03-28'))).toMatchObject({
      months: null,
      days: 28,
    });
    expect(patientAgeOn(alive('2024-02-29'), d('2024-03-29')).months).toBe(1);
    // And the 29th of every month is what completes another one: on 28 April
    // the day of the month has not come round.
    expect(patientAgeOn(alive('2024-02-29'), d('2024-04-28')).months).toBe(1);
    expect(patientAgeOn(alive('2024-02-29'), d('2024-04-29')).months).toBe(2);
    // And a month whose 31st does not exist never OVERSTATES the age: a baby
    // born on 31 January is not a month old on 29 February.
    expect(patientAgeOn(alive('2024-01-31'), d('2024-02-29')).months).toBe(0);
    expect(patientAgeOn(alive('2024-01-31'), d('2024-03-01')).months).toBe(1);
  });

  it('PA-030 counts the birthday itself as a completed year', () => {
    expect(patientAgeOn(alive('1990-08-16'), d('2026-08-16')).years).toBe(36);
  });

  it('PA-030 does not count a birthday that has not arrived yet', () => {
    // One day earlier, and the difference decides whether somebody is 65 —
    // which is whether the waiting list prioritises them (PA-035).
    expect(patientAgeOn(alive('1990-08-17'), d('2026-08-16')).years).toBe(35);
  });

  it('PA-030 gives someone born on 29 February an age on a non-leap year', () => {
    // Born 2024-02-29. On 2026-02-28 the birthday has not arrived; on
    // 2026-03-01 it has. Dividing elapsed milliseconds gets this wrong.
    expect(patientAgeOn(alive('2024-02-29'), d('2026-02-28')).years).toBe(1);
    expect(patientAgeOn(alive('2024-02-29'), d('2026-03-01')).years).toBe(2);
  });

  it('PA-030 counts a leap day as a lived day for a neonate', () => {
    // Born on 28 February 2024, asked on 1 March: two completed days, because
    // 29 February existed that year.
    expect(patientAgeOn(alive('2024-02-28'), d('2024-03-01')).days).toBe(2);
  });

  it('PA-008 freezes the age of a deceased patient at the date of death', () => {
    // Resolved against today, this chart would report an age that grows every
    // January — and it is the age AT DEATH that a mortality report means.
    const chart = {
      birthDate: d('1950-01-10'),
      // 14:00 in Guayaquil on 20 March 2020.
      deceasedAt: new Date('2020-03-20T19:00:00Z'),
    };

    expect(patientAgeOn(chart, d('2026-08-16'))).toEqual({
      years: 70,
      months: null,
      days: null,
    });
  });

  it('PA-008 resolves the date of death in Ecuador and not in UTC', () => {
    // 21:00 on 15 August in Guayaquil is already the 16th in UTC. On a newborn
    // that is a whole day of `age_days`, which is how the RDACAA classifies
    // them — and it affects the entire evening clinic.
    const chart = {
      birthDate: d('2026-08-10'),
      deceasedAt: new Date('2026-08-16T02:00:00Z'),
    };

    expect(patientAgeOn(chart, d('2026-08-16')).days).toBe(5);
  });

  it('PA-030 refuses to report a negative age when the dates disagree', () => {
    // `patient_deceased_after_birth` keeps such a chart out of the database.
    // If one ever arrives from elsewhere, the answer is "no days", never a
    // negative number that a report would carry forward.
    const chart = {
      birthDate: d('2026-08-16'),
      deceasedAt: new Date('2026-08-10T15:00:00Z'),
    };

    expect(patientAgeOn(chart, d('2026-08-16'))).toEqual({
      years: 0,
      months: null,
      days: null,
    });
  });
});
