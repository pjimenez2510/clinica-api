/**
 * The few statistics the harness reports, written out so each can be checked
 * (copied from SigmAI `src/batch/stats.ts`, which measured E-044 to E-072 with
 * them, and adapted: the paired difference over cases is new).
 */

export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  const above = Math.ceil(position);
  return (
    sorted[below]! + (sorted[above]! - sorted[below]!) * (position - below)
  );
}

export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

export interface Interval {
  low: number;
  high: number;
}

/** Wilson score interval for a proportion: honest with small n and near 0 or 1. */
export function wilson(hits: number, n: number, z = 1.959964): Interval {
  if (n === 0) return { low: Number.NaN, high: Number.NaN };
  const p = hits / n;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator),
  };
}

/** Mulberry32: a seeded generator, so a bootstrap run twice gives the same interval. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface BootstrapOptions {
  resamples?: number;
  seed?: number;
}

export interface Estimate extends Interval {
  estimate: number;
  n: number;
}

const mean = (values: readonly number[]) =>
  values.reduce((total, value) => total + value, 0) / values.length;

/**
 * Percentile bootstrap of a mean, resampling whole cases. Each value is one
 * case, so cases are the unit that is resampled (SigmAI resampled whole
 * consultations for the same reason).
 */
export function bootstrapMean(
  values: readonly number[],
  { resamples = 10_000, seed = 42 }: BootstrapOptions = {},
): Estimate {
  const n = values.length;
  if (n === 0) {
    return { estimate: Number.NaN, low: Number.NaN, high: Number.NaN, n };
  }
  const random = seeded(seed);
  const estimates: number[] = [];
  for (let r = 0; r < resamples; r += 1) {
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      total += values[Math.floor(random() * n)]!;
    }
    estimates.push(total / n);
  }
  return {
    estimate: mean(values),
    low: quantile(estimates, 0.025),
    high: quantile(estimates, 0.975),
    n,
  };
}

/**
 * The difference `b − a` over the SAME cases, with its 95 % interval. The
 * rule of PLAN-ASISTENTE-IA §5, written before measuring: a difference counts
 * only if this interval excludes zero.
 */
export function pairedDifference(
  pairs: readonly { a: number; b: number }[],
  options: BootstrapOptions = {},
): Estimate {
  return bootstrapMean(
    pairs.map((pair) => pair.b - pair.a),
    options,
  );
}

function binomialCdf(k: number, n: number): number {
  let total = 0;
  let term = 0.5 ** n;
  for (let i = 0; i <= k; i += 1) {
    total += term;
    term = (term * (n - i)) / (i + 1);
  }
  return total;
}

/**
 * Distribution-free interval for the median of paired differences, from the
 * sign test: the k-th and (n-k+1)-th ordered differences, with k as large as
 * keeps the coverage at 95 % or more. With small n the coverage is never
 * exactly 95 %, so it is returned; null when no k reaches it.
 */
export function signTestInterval(
  differences: readonly number[],
): (Interval & { coverage: number }) | null {
  const n = differences.length;
  const sorted = [...differences].sort((a, b) => a - b);
  let chosen: { k: number; coverage: number } | null = null;
  for (let k = 1; k <= Math.floor(n / 2); k += 1) {
    const coverage = 1 - 2 * binomialCdf(k - 1, n);
    if (coverage < 0.95) break;
    chosen = { k, coverage };
  }
  return chosen === null
    ? null
    : {
        low: sorted[chosen.k - 1]!,
        high: sorted[n - chosen.k]!,
        coverage: chosen.coverage,
      };
}

/**
 * Cohen's kappa of two binary labellings of the same items (SigmAI
 * `relevance-judge.ts`): how the judge agrees with physicians beyond chance,
 * once a reviewed subsample exists (PLAN-ASISTENTE-IA §5).
 */
export function cohenKappa(
  pairs: readonly { judged: boolean; truth: boolean }[],
): number {
  const n = pairs.length;
  if (n === 0) return Number.NaN;
  const agree = pairs.filter((pair) => pair.judged === pair.truth).length / n;
  const judgedYes = pairs.filter((pair) => pair.judged).length / n;
  const truthYes = pairs.filter((pair) => pair.truth).length / n;
  const chance = judgedYes * truthYes + (1 - judgedYes) * (1 - truthYes);
  return chance === 1 ? 1 : (agree - chance) / (1 - chance);
}
