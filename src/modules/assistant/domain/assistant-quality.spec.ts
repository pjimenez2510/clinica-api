import { describe, expect, it } from 'vitest';

import {
  addDays,
  clinicalDateOf,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';

import {
  QUALITY_CSV_HEADER,
  type SiteWeekFigures,
  cacheRate,
  qualityCsv,
  rate,
  weekBounds,
  weekOf,
  weeksSpanned,
} from './assistant-quality';

/** Every date derives from this clock, never written by hand (CLAUDE.md). */
const NOW = new Date();
const TODAY = clinicalDateOf(NOW);

function figures(over: Partial<SiteWeekFigures> = {}): SiteWeekFigures {
  return {
    week: weekOf(TODAY).weekStart,
    siteId: '00000000-0000-7000-8000-000000000001',
    siteName: 'Matriz',
    encounters: 4,
    assisted: 1,
    adoption: 0.25,
    attempts: 3,
    answered: 3,
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 3_000,
    cacheWriteTokens: 0,
    costUsd: '0.01250000',
    attemptsWithoutCost: 0,
    costPerAssisted: '0.01250000',
    cacheRate: 0.75,
    medianLatencyMs: 900,
    proposals: 5,
    accepted: 2,
    edited: 1,
    discarded: 1,
    untouched: 1,
    amber: 1,
    acceptance: 0.6,
    reviewed: 2,
    medianDistance: 0.125,
    ...over,
  };
}

describe('assistant quality (E19)', () => {
  it('AS-348 a week runs Monday to Sunday in Guayaquil, whatever day is asked', () => {
    const { weekStart, weekEnd } = weekOf(TODAY);
    for (let day = 0; day < 7; day += 1) {
      expect(weekOf(addDays(weekStart, day))).toEqual({ weekStart, weekEnd });
    }
    expect(new Date(`${weekStart}T12:00:00Z`).getUTCDay()).toBe(1);
    expect(weekEnd).toBe(addDays(weekStart, 6));
    expect(weekOf(addDays(weekStart, 7)).weekStart).toBe(addDays(weekStart, 7));
  });

  it('AS-348 the week bounds are midnight in Guayaquil, not in UTC', () => {
    const { weekStart } = weekOf(TODAY);
    const { startsAt, endsAtExclusive } = weekBounds(weekStart);
    // Guayaquil is UTC−5 all year: midnight there is 05:00 UTC.
    expect(startsAt.toISOString()).toBe(`${weekStart}T05:00:00.000Z`);
    expect(endsAtExclusive.toISOString()).toBe(
      `${addDays(weekStart, 7)}T05:00:00.000Z`,
    );
  });

  it('AS-348 a rate without a denominator is empty, never zero', () => {
    expect(rate(0, 0)).toBeNull();
    expect(rate(1, 3)).toBe(0.3333);
    expect(rate(0, 5)).toBe(0);
    expect(cacheRate({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull(); // prettier-ignore
    expect(cacheRate({ inputTokens: 1_000, cacheReadTokens: 3_000, cacheWriteTokens: 0 })).toBe(0.75); // prettier-ignore
    // The cache write is input too: it was sent, and not read from the cache.
    expect(cacheRate({ inputTokens: 500, cacheReadTokens: 1_000, cacheWriteTokens: 500 })).toBe(0.5); // prettier-ignore
  });

  it('AS-352 the CSV has a fixed header, one line per week and site, a dot as decimal separator', () => {
    const csv = qualityCsv([figures(), figures({ siteName: 'Sur, "norte"', adoption: null, medianDistance: null })]); // prettier-ignore
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe(QUALITY_CSV_HEADER.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(',0.25,');
    expect(lines[1]).toContain(',0.0125,');
    // A name with a comma or a quote is quoted, its quotes doubled.
    expect(lines[2]).toContain('"Sur, ""norte"""');
    // An empty rate is an empty cell, not a zero.
    expect(lines[2]!.split(',').filter((cell) => cell === '').length).toBe(2);
  });

  it('AS-353 counts the weeks a range spans, and refuses a backwards one', () => {
    const { weekStart } = weekOf(TODAY);
    expect(weeksSpanned(weekStart, weekStart)).toBe(1);
    expect(weeksSpanned(weekStart, addDays(weekStart, 6))).toBe(1);
    expect(weeksSpanned(weekStart, addDays(weekStart, 7))).toBe(2);
    expect(weeksSpanned(addDays(weekStart, 7), weekStart)).toBe(0);
    expect(() => weekOf(parseClinicalDate('2026-02-30'))).toThrow(); // fecha-fija: a day no calendar has
  });
});
