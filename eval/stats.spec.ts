import { describe, expect, it } from 'vitest';

import {
  bootstrapMean,
  cohenKappa,
  median,
  pairedDifference,
  quantile,
  seeded,
  signTestInterval,
  wilson,
} from './stats.ts';

describe('statistics of the harness', () => {
  it('Wilson 95 % matches the published values', () => {
    // Newcombe (1998), table I: 81/263 → 0.2553–0.3662; 15/148 → 0.0624–0.1605.
    const a = wilson(81, 263);
    expect(a.low).toBeCloseTo(0.2553, 4);
    expect(a.high).toBeCloseTo(0.3662, 4);
    const b = wilson(15, 148);
    expect(b.low).toBeCloseTo(0.0624, 4);
    expect(b.high).toBeCloseTo(0.1605, 4);
    // At the borders the interval stays inside [0, 1] and is not empty.
    expect(wilson(0, 10).low).toBe(0);
    expect(wilson(0, 10).high).toBeGreaterThan(0.2);
    expect(wilson(10, 10).high).toBeCloseTo(1, 10);
    expect(Number.isNaN(wilson(0, 0).low)).toBe(true);
  });

  it('quantiles interpolate as the harness reports p50 and p90', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10, 20, 30, 40, 50], 0.9)).toBe(46);
    expect(median([3, 1, 2])).toBe(2);
    expect(Number.isNaN(median([]))).toBe(true);
  });

  it('a seeded bootstrap gives the same interval twice, and another seed another one', () => {
    const values = Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? 1 : 0));
    const first = bootstrapMean(values, { seed: 7, resamples: 2_000 });
    const again = bootstrapMean(values, { seed: 7, resamples: 2_000 });
    // Continuous values: with 0/1 the percentiles fall on the 1/40 lattice
    // and two seeds can land on the same one.
    const spread = values.map((value, i) => value + ((i * 7919) % 100) / 100);
    const seven = bootstrapMean(spread, { seed: 7, resamples: 2_000 });
    const eight = bootstrapMean(spread, { seed: 8, resamples: 2_000 });

    expect(again).toEqual(first);
    expect(eight.low).not.toBe(seven.low);
    expect(first.estimate).toBeCloseTo(14 / 40, 10);
    expect(first.low).toBeLessThan(first.estimate);
    expect(first.high).toBeGreaterThan(first.estimate);
  });

  it('a paired difference that is always positive excludes zero; one that is noise does not', () => {
    const better = pairedDifference(
      Array.from({ length: 30 }, (_, i) => ({ a: i % 2, b: 1 })),
      { seed: 1, resamples: 2_000 },
    );
    expect(better.n).toBe(30);
    expect(better.estimate).toBeCloseTo(0.5, 10);
    expect(better.low).toBeGreaterThan(0);

    const random = seeded(3);
    const noise = pairedDifference(
      Array.from({ length: 30 }, () => ({
        a: random() < 0.5 ? 1 : 0,
        b: random() < 0.5 ? 1 : 0,
      })),
      { seed: 1, resamples: 2_000 },
    );
    expect(noise.low).toBeLessThan(0);
    expect(noise.high).toBeGreaterThan(0);
  });

  it('the sign-test interval covers at least 95 % or says it cannot', () => {
    const interval = signTestInterval(
      Array.from({ length: 20 }, (_, i) => i - 5),
    );
    expect(interval?.coverage).toBeGreaterThanOrEqual(0.95);
    expect(interval?.low).toBeLessThanOrEqual(4.5);
    expect(interval?.high).toBeGreaterThanOrEqual(4.5);
    expect(signTestInterval([1, 2, 3])).toBeNull();
  });

  it("Cohen's kappa: 1 when the judge agrees, 0 when it agrees only by chance", () => {
    const truth = [true, true, false, false];
    expect(cohenKappa(truth.map((t) => ({ judged: t, truth: t })))).toBe(1);
    // 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no: po = 0.7, pe = 0.5 → κ = 0.4.
    const pairs = [
      ...Array.from({ length: 20 }, () => ({ judged: true, truth: true })),
      ...Array.from({ length: 5 }, () => ({ judged: true, truth: false })),
      ...Array.from({ length: 10 }, () => ({ judged: false, truth: true })),
      ...Array.from({ length: 15 }, () => ({ judged: false, truth: false })),
    ];
    expect(cohenKappa(pairs)).toBeCloseTo(0.4, 10);
    expect(Number.isNaN(cohenKappa([]))).toBe(true);
  });
});
