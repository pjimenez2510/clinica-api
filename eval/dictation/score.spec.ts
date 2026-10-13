import { describe, expect, it } from 'vitest';

import { cellsOf, groupBy, judge, tally, verdictOf } from './score.ts';

const CASE = {
  id: 'X1',
  category: 'presion',
  text: 'Presión 120 sobre 80, pulso 72',
  expected: { systolicBp: 120, diastolicBp: 80, heartRate: 72 },
};

describe('AS-188 the dictation harness scores every field, as E-055 did', () => {
  it('AS-188 tells a correct value, a wrong one, an empty one and an invented one', () => {
    expect(judge(36.5, 36.5)).toBe('correct');
    expect(judge(36.5, 36.54)).toBe('correct');
    expect(judge(36.5, 36.6)).toBe('wrong');
    expect(judge(72, undefined)).toBe('empty');
    expect(judge(undefined, 98)).toBe('invented');
    expect(judge(undefined, undefined)).toBe('empty-ok');
  });

  it('AS-188 SC-096 counts a wrong value and an invented one as serious, never an empty one', () => {
    const cells = cellsOf(
      CASE,
      'oido',
      'Paulina',
      'presión 120 con 70, saturación 97',
      {
        signs: { systolicBp: 120, diastolicBp: 70, oxygenSaturation: 97 },
      },
    );

    const result = tally(cells);

    expect(result).toMatchObject({ expected: 3, correct: 1, wrong: 1, empty: 1, invented: 1, unsaid: 5, serious: 2 }); // prettier-ignore
    expect(result.correctRate.high).toBeGreaterThan(1 / 3);
    expect(result.correctRate.low).toBeLessThan(1 / 3);
  });

  it('AS-188 SC-095 SC-096 pass only at 93 % correct heard and with no serious value in either arm', () => {
    const perfect = tally(
      cellsOf(CASE, 'texto', '—', CASE.text, { signs: CASE.expected }),
    );
    const missing = tally(
      cellsOf(CASE, 'oido', 'Eddy', 'presión', { signs: {} }),
    );
    const invented = tally(cellsOf(CASE, 'oido', 'Eddy', '', { signs: { ...CASE.expected, weightKg: 70 } })); // prettier-ignore

    expect(verdictOf(perfect, perfect)).toEqual({ sc095: true, sc096: true });
    expect(verdictOf(perfect, missing)).toEqual({ sc095: false, sc096: true });
    expect(verdictOf(perfect, invented)).toEqual({ sc095: true, sc096: false });
  });

  it('AS-188 groups the cells by voice, keeping the order they came in', () => {
    const cells = [
      ...cellsOf(CASE, 'oido', 'Mónica', '', { signs: {} }),
      ...cellsOf(CASE, 'oido', 'Paulina', '', { signs: {} }),
    ];

    expect([...groupBy(cells, 'voice').keys()]).toEqual(['Mónica', 'Paulina']);
  });
});
