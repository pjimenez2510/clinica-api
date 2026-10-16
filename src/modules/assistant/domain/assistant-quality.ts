import {
  type ClinicalDate,
  addDays,
  clinicalDaySpan,
  isoWeekdayOf,
  startOfClinicalDay,
} from '../../../shared/domain/clinic-time';

/**
 * E19 (AS-345 to AS-356). How the assistant did, counted from what E1 and the
 * register of calls already keep: figures only — counts, rates, costs and
 * times —, never a word of clinical text (AS-349).
 *
 * The sums and medians are the database's (`PrismaAssistantQualityReader`);
 * this file decides what a week is, what a rate is when there is nothing to
 * divide by, and how the CSV is written.
 */

/** AS-353. The longest range the CSV covers: a year of weeks. */
export const MAX_CSV_WEEKS = 53;

/** AS-348. Monday to Sunday, in the clinic's calendar. */
export function weekOf(date: ClinicalDate): {
  weekStart: ClinicalDate;
  weekEnd: ClinicalDate;
} {
  const weekStart = addDays(date, 1 - isoWeekdayOf(date));
  return { weekStart, weekEnd: addDays(weekStart, 6) };
}

/** AS-348. The instants of a week: midnight to midnight in Guayaquil. */
export function weekBounds(weekStart: ClinicalDate): {
  startsAt: Date;
  endsAtExclusive: Date;
} {
  return {
    startsAt: startOfClinicalDay(weekStart),
    endsAtExclusive: startOfClinicalDay(addDays(weekStart, 7)),
  };
}

/** AS-353. How many weeks `[from, to]` touches; 0 when it is backwards. */
export function weeksSpanned(from: ClinicalDate, to: ClinicalDate): number {
  const first = weekOf(from).weekStart;
  const last = weekOf(to).weekStart;
  const days = clinicalDaySpan(first, last);
  return days <= 0 ? 0 : Math.round((days - 1) / 7) + 1;
}

/**
 * AS-348. A share, four decimals; `null` when there is nothing to divide by.
 * «0 %» of no attentions and of forty are not the same fact.
 */
export function rate(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return Math.round((part / whole) * 10_000) / 10_000;
}

/**
 * AS-348. The tokens read from the cache over all the input sent. The
 * provider reports `inputTokens` as the uncached remainder (`pricing.ts`), so
 * the three input figures are added.
 */
export function cacheRate(tokens: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number | null {
  return rate(
    tokens.cacheReadTokens,
    tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens,
  );
}

/** AS-346. What happened to the proposals of a class (and section). */
export interface ProposalCounts {
  proposals: number;
  /** `ACCEPTED`: taken as proposed. */
  accepted: number;
  /** `ACCEPTED_WITH_CHANGES`. */
  edited: number;
  /** `DISCARDED`. */
  discarded: number;
  /** `PROPOSED`: nobody decided. */
  untouched: number;
  /** AS-347. Something of it says «Nadie lo dijo». */
  amber: number;
  /** Reviewed at the signature (`ai_suggestion_review`). */
  reviewed: number;
  medianDistance: number | null;
}

/** AS-345. The attempts of one task (`ai_run.purpose`), summed. */
export interface TaskFigures {
  purpose: string;
  attempts: number;
  answered: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The sum of `cost_usd`, as the database's decimal text. */
  costUsd: string;
  attemptsWithoutCost: number;
  medianLatencyMs: number | null;
  maxLatencyMs: number | null;
}

/** AS-346. A class of proposal, and its section for `note-section`. */
export interface ProposalFigures extends ProposalCounts {
  kind: string;
  section: string | null;
  /** AS-348. Accepted and edited over every proposal. */
  acceptance: number | null;
}

/** AS-348. A week at a site, or at every site of the scope (`siteId` null). */
export interface SiteWeekFigures extends ProposalCounts {
  week: ClinicalDate;
  siteId: string | null;
  siteName: string | null;
  encounters: number;
  assisted: number;
  adoption: number | null;
  attempts: number;
  answered: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: string;
  attemptsWithoutCost: number;
  costPerAssisted: string | null;
  cacheRate: number | null;
  medianLatencyMs: number | null;
  acceptance: number | null;
}

/** AS-352. The CSV's columns, in this order, always. */
export const QUALITY_CSV_HEADER = [
  'semana',
  'sede',
  'atenciones',
  'con_asistente',
  'adopcion',
  'intentos',
  'respondidos',
  'tokens_entrada',
  'tokens_salida',
  'tokens_cache_leidos',
  'tokens_cache_escritos',
  'costo_usd',
  'intentos_sin_costo',
  'costo_por_atencion_usd',
  'tasa_cache',
  'latencia_mediana_ms',
  'propuestas',
  'aceptadas',
  'editadas',
  'quitadas',
  'sin_tocar',
  'ambar',
  'aceptacion',
  'revisadas',
  'distancia_mediana',
] as const;

/** RFC 4180: a cell with a comma, a quote or a line break goes quoted. */
function cell(value: string | number | null): string {
  if (value === null) return '';
  const text = typeof value === 'number' ? String(value) : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A decimal of the database without its trailing zeros: `0.01250000` → `0.0125`. */
function decimal(value: string | null): string | null {
  if (value === null) return null;
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

/** AS-352. One line per week and site, CRLF, a dot as decimal separator. */
export function qualityCsv(rows: readonly SiteWeekFigures[]): string {
  const lines = rows.map((row) =>
    [
      row.week,
      row.siteName,
      row.encounters,
      row.assisted,
      row.adoption,
      row.attempts,
      row.answered,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens,
      decimal(row.costUsd),
      row.attemptsWithoutCost,
      decimal(row.costPerAssisted),
      row.cacheRate,
      row.medianLatencyMs,
      row.proposals,
      row.accepted,
      row.edited,
      row.discarded,
      row.untouched,
      row.amber,
      row.acceptance,
      row.reviewed,
      row.medianDistance,
    ]
      .map(cell)
      .join(','),
  );
  return [QUALITY_CSV_HEADER.join(','), ...lines].join('\r\n') + '\r\n';
}

/** What the database sums for a week at a site; the rates come from these. */
export type SiteWeekSums = Omit<
  SiteWeekFigures,
  'adoption' | 'costPerAssisted' | 'cacheRate' | 'acceptance'
>;

/** AS-348. Accepted and edited, over every proposal. */
export function acceptanceOf(counts: {
  proposals: number;
  accepted: number;
  edited: number;
}): number | null {
  return rate(counts.accepted + counts.edited, counts.proposals);
}

/** AS-348. The rates of a week, from its sums; each empty without a denominator. */
export function withRates(sums: SiteWeekSums): SiteWeekFigures {
  return {
    ...sums,
    adoption: rate(sums.assisted, sums.encounters),
    costPerAssisted:
      sums.assisted === 0
        ? null
        : (Number(sums.costUsd) / sums.assisted).toFixed(8),
    cacheRate: cacheRate(sums),
    acceptance: acceptanceOf(sums),
  };
}
