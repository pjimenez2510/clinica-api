import { describe, expect, it } from 'vitest';

import {
  addDays,
  atWallClock,
  clinicalDateOf,
  type ClinicalDate,
  WallClockTime,
} from '../../../shared/domain/clinic-time';

import {
  medicationsOf,
  seriesKeyOf,
  timelineOf,
  type HistoryResult,
  type HistoryVisit,
  type PrescribedLine,
} from './clinical-history';

// Every date is derived from today: none is written by hand.
const TODAY = clinicalDateOf(new Date());
const day = (offset: number): ClinicalDate => addDays(TODAY, offset);
/** Ten in the morning of that day, in Ecuador. */
const at = (offset: number, hour = '10:00'): Date =>
  atWallClock(day(offset), WallClockTime.parse(hour));

let sequence = 0;
function line(
  offset: number,
  over: Partial<PrescribedLine> = {},
): PrescribedLine {
  sequence += 1;
  return {
    prescriptionId: `rx-${sequence}`,
    encounterId: `enc-${sequence}`,
    issuedAt: at(offset),
    conceptId: 'cnmb-enalapril-10',
    genericName: 'Enalapril',
    concentration: '10 mg',
    presentation: 'Tableta',
    doseText: '1 tableta',
    frequencyText: 'cada 12 horas',
    durationDays: 30,
    fromMergedChart: false,
    ...over,
  };
}

function result(
  offset: number,
  over: Partial<HistoryResult> = {},
): HistoryResult {
  sequence += 1;
  return {
    id: String(sequence),
    orderId: `ord-${sequence}`,
    encounterId: `enc-${sequence}`,
    analyteConceptId: 'glucose',
    analyteDisplay: 'Glucosa',
    valueNumeric: 92,
    valueText: null,
    valueCode: null,
    unit: 'mg/dL',
    referenceLow: 70,
    referenceHigh: 100,
    referenceText: null,
    criticalLow: null,
    criticalHigh: null,
    abnormalFlag: 'NORMAL',
    observedAt: at(offset),
    fromMergedChart: false,
    ...over,
  };
}

function visit(offset: number, over: Partial<HistoryVisit> = {}): HistoryVisit {
  sequence += 1;
  return {
    encounterId: `enc-${sequence}`,
    startedAt: at(offset),
    presentingComplaint: 'Dolor de cabeza',
    siteName: 'Matriz',
    diagnoses: [{ code: 'I10.X', display: 'Hipertensión esencial (primaria)' }],
    fromMergedChart: false,
    ...over,
  };
}

describe('medicationsOf (AS-203, AS-204)', () => {
  it('AS-204 keeps a 7-day course active through its seventh day and ended on the eighth', () => {
    const course = line(-6, { durationDays: 7 });
    const [onSeventh] = medicationsOf([course], TODAY);
    expect(onSeventh).toMatchObject({ status: 'ACTIVE', endsOn: TODAY });

    const [onEighth] = medicationsOf([course], day(1));
    expect(onEighth).toMatchObject({ status: 'ENDED', endsOn: TODAY });
  });

  it('AS-204 reads a medicine whose last prescription states no days as neither active nor ended', () => {
    const [medicine] = medicationsOf(
      [line(-90, { durationDays: 30 }), line(-10, { durationDays: null })],
      TODAY,
    );
    expect(medicine).toMatchObject({ status: 'NO_DURATION', endsOn: null });
  });

  it('AS-204 does not end a medicine because a later prescription leaves it out', () => {
    const enalapril = line(-20, { durationDays: 60 });
    const amoxicillin = line(-5, {
      conceptId: 'cnmb-amoxicillin-500',
      genericName: 'Amoxicilina',
      concentration: '500 mg',
      durationDays: 7,
    });
    const medicines = medicationsOf([enalapril, amoxicillin], TODAY);
    expect(medicines.map((m) => [m.genericName, m.status])).toEqual([
      ['Amoxicilina', 'ACTIVE'],
      ['Enalapril', 'ACTIVE'],
    ]);
  });

  it('AS-204 keeps the furthest end when a shorter course follows a longer one still running', () => {
    const [medicine] = medicationsOf(
      [line(-10, { durationDays: 30 }), line(-2, { durationDays: 5 })],
      TODAY,
    );
    expect(medicine).toMatchObject({ status: 'ACTIVE', endsOn: day(19) });
  });

  it('AS-203 groups by CNMB concept, and without one by generic name and concentration', () => {
    const medicines = medicationsOf(
      [
        line(-60),
        line(-30, { genericName: 'ENALAPRIL ', doseText: '2 tabletas' }),
        line(-40, {
          conceptId: null,
          genericName: 'Metformina',
          concentration: '850 mg',
        }),
        line(-20, {
          conceptId: null,
          genericName: ' metformina',
          concentration: '850 MG',
        }),
        line(-20, {
          conceptId: null,
          genericName: 'Metformina',
          concentration: '500 mg',
        }),
      ],
      TODAY,
    );
    expect(medicines).toHaveLength(3);
    const enalapril = medicines.find(
      (m) => m.key === 'concept:cnmb-enalapril-10',
    );
    expect(enalapril).toMatchObject({
      timesPrescribed: 2,
      firstPrescribedOn: day(-60),
      lastPrescribedOn: day(-30),
      lastDoseText: '2 tabletas',
    });
    const metformin850 = medicines.filter(
      (m) => m.concentration?.trim().toLowerCase() === '850 mg',
    );
    expect(metformin850).toHaveLength(1);
    expect(metformin850[0]?.timesPrescribed).toBe(2);
  });

  it('AS-203 orders the active first, then those with no days, then the ended, most recent first', () => {
    const medicines = medicationsOf(
      [
        line(-200, { conceptId: 'a', genericName: 'A', durationDays: 10 }),
        line(-100, { conceptId: 'b', genericName: 'B', durationDays: 10 }),
        line(-3, { conceptId: 'c', genericName: 'C', durationDays: null }),
        line(-2, { conceptId: 'd', genericName: 'D', durationDays: 30 }),
      ],
      TODAY,
    );
    expect(medicines.map((m) => m.genericName)).toEqual(['D', 'C', 'B', 'A']);
  });

  it('AS-203 says a medicine came from an absorbed chart when any of its prescriptions did', () => {
    const [medicine] = medicationsOf(
      [line(-60, { fromMergedChart: true }), line(-5)],
      TODAY,
    );
    expect(medicine?.fromMergedChart).toBe(true);
  });
});

describe('timelineOf (AS-205)', () => {
  it('AS-205 groups by Ecuadorian calendar day, newest first, a visit before what it started', () => {
    const late = atWallClock(day(-3), WallClockTime.parse('21:30')); // past midnight in UTC
    const days = timelineOf({
      visits: [visit(-10), { ...visit(-3), startedAt: late }],
      lines: [line(-3, { durationDays: 7 })],
      results: [],
      today: TODAY,
    });
    expect(days.map((d) => d.date)).toEqual([day(-3), day(-10)]);
    expect(days[0]?.items.map((item) => item.kind)).toEqual([
      'visit',
      'medication-started',
    ]);
  });

  it('AS-205 writes a renewed medicine once, and its end only once nobody renewed it in time', () => {
    const days = timelineOf({
      visits: [],
      lines: [
        line(-50, { durationDays: 30 }),
        line(-25, { durationDays: 10 }), // renewed before it ended: no new line
        line(-5, { durationDays: 3 }), // after it ended on day -16: started again
      ],
      results: [],
      today: TODAY,
    });
    const flat = days.flatMap((d) =>
      d.items.map((item) => [d.date, item.kind] as const),
    );
    expect(flat).toEqual([
      [day(-3), 'medication-ended'],
      [day(-5), 'medication-started'],
      [day(-16), 'medication-ended'],
      [day(-50), 'medication-started'],
    ]);
  });

  it('AS-205 writes no end for a course still running or with no days', () => {
    const days = timelineOf({
      visits: [],
      lines: [
        line(-2, { durationDays: 30 }),
        line(-40, { conceptId: 'x', genericName: 'X', durationDays: null }),
      ],
      results: [],
      today: TODAY,
    });
    expect(days.flatMap((d) => d.items).map((i) => i.kind)).toEqual([
      'medication-started',
      'medication-started',
    ]);
  });

  it('AS-205 lists the results out of range, critical included, and never a normal or unflagged one', () => {
    const high = result(-4, { valueNumeric: 182, abnormalFlag: 'HIGH' });
    const critical = result(-4, {
      valueNumeric: 2.6,
      abnormalFlag: 'CRITICAL_LOW',
    });
    const days = timelineOf({
      visits: [],
      lines: [],
      results: [high, critical, result(-4), result(-4, { abnormalFlag: null })],
      today: TODAY,
    });
    expect(days).toHaveLength(1);
    expect(days[0]?.items).toEqual([
      { kind: 'result', resultId: high.id, orderId: high.orderId },
      { kind: 'result', resultId: critical.id, orderId: critical.orderId },
    ]);
  });

  it('AS-205 carries a visit with its complaint, diagnoses and site', () => {
    const seen = visit(-1, { presentingComplaint: null });
    const [first] = timelineOf({
      visits: [seen],
      lines: [],
      results: [],
      today: TODAY,
    });
    expect(first?.items[0]).toEqual({
      kind: 'visit',
      encounterId: seen.encounterId,
      complaint: null,
      diagnoses: seen.diagnoses,
      siteName: 'Matriz',
      fromMergedChart: false,
    });
  });
});

describe('seriesKeyOf (AS-206)', () => {
  it('AS-206 makes the same determination in two units two series', () => {
    const mgdl = seriesKeyOf(result(-1));
    const mmol = seriesKeyOf(result(-1, { unit: 'mmol/L', valueNumeric: 5.1 }));
    expect(mgdl).not.toBeNull();
    expect(mgdl).not.toBe(mmol);
    expect(seriesKeyOf(result(-9))).toBe(mgdl);
  });

  it('AS-206 keys a determination without catalogue concept by its name, and a non-numeric result by nothing', () => {
    const a = seriesKeyOf(
      result(-1, { analyteConceptId: null, analyteDisplay: 'HbA1c ' }),
    );
    const b = seriesKeyOf(
      result(-2, { analyteConceptId: null, analyteDisplay: 'hba1c' }),
    );
    expect(a).toBe(b);
    expect(
      seriesKeyOf(result(-1, { valueNumeric: null, valueCode: 'POSITIVO' })),
    ).toBeNull();
  });
});
