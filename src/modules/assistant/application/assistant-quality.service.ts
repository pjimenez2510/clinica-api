import { Inject, Injectable } from '@nestjs/common';

import { type ClinicalDate } from '../../../shared/domain/clinic-time';
import {
  type ProposalFigures,
  type SiteWeekFigures,
  type TaskFigures,
  acceptanceOf,
  cacheRate,
  qualityCsv,
  weekBounds,
  weekOf,
  withRates,
} from '../domain/assistant-quality';
import { AssistantEncounterNotFoundError } from '../domain/assistant.errors';

import {
  ASSISTANT_QUALITY_READER,
  type AssistantQualityReader,
  type ProposalSums,
  type QualityEncounter,
  type QualityEncounterRow,
  type QualityScope,
} from './assistant-quality.reader';

/** AS-345, AS-346. One attention's breakdown, figures only (AS-349). */
export interface EncounterQuality extends QualityEncounter {
  tasks: TaskFigures[];
  proposals: ProposalFigures[];
  totals: {
    attempts: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: string;
    cacheRate: number | null;
    proposals: number;
    acceptance: number | null;
  };
}

/** AS-348. A week of the scope: by site, for all of them, by task and class. */
export interface WeekQuality {
  weekStart: ClinicalDate;
  weekEnd: ClinicalDate;
  siteId: string | null;
  sites: { id: string; name: string }[];
  total: SiteWeekFigures;
  bySite: SiteWeekFigures[];
  tasks: TaskFigures[];
  proposals: ProposalFigures[];
  encounters: QualityEncounterRow[];
}

function withAcceptance(sums: ProposalSums): ProposalFigures {
  return { ...sums, acceptance: acceptanceOf(sums) };
}

/** A week with no attentions: zeros, and every rate empty (AS-348). */
function emptyWeek(week: ClinicalDate, siteId: string | null): SiteWeekFigures {
  return withRates({
    week,
    siteId,
    siteName: null,
    encounters: 0,
    assisted: 0,
    attempts: 0,
    answered: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: '0.00000000',
    attemptsWithoutCost: 0,
    medianLatencyMs: null,
    proposals: 0,
    accepted: 0,
    edited: 0,
    discarded: 0,
    untouched: 0,
    amber: 0,
    reviewed: 0,
    medianDistance: null,
  });
}

/** Sums two decimals of eight places exactly, as integers of 1e-8. */
function addUsd(a: string, b: string): string {
  const units = (value: string) => BigInt(Number(value).toFixed(8).replace('.', '')); // prettier-ignore
  const sum = (units(a) + units(b)).toString().padStart(9, '0');
  return `${sum.slice(0, -8)}.${sum.slice(-8)}`;
}

/**
 * E19 (AS-345 to AS-353). The assistant's register, counted for the screen.
 * A read: nothing is written, no model is called, the switch does not apply.
 */
@Injectable()
export class AssistantQualityService {
  constructor(
    @Inject(ASSISTANT_QUALITY_READER)
    private readonly reader: AssistantQualityReader,
  ) {}

  /** AS-345 to AS-347, AS-350. */
  async encounter(
    encounterId: string,
    scope: QualityScope,
  ): Promise<EncounterQuality> {
    const encounter = await this.reader.encounter(encounterId, scope);
    if (!encounter) throw new AssistantEncounterNotFoundError();
    const [tasks, proposals] = await Promise.all([
      this.reader.tasksOf(encounterId),
      this.reader.proposalsOf(encounterId),
    ]);
    const sum = (pick: (row: TaskFigures) => number) =>
      tasks.reduce((total, row) => total + pick(row), 0);
    const tokens = {
      inputTokens: sum((row) => row.inputTokens),
      outputTokens: sum((row) => row.outputTokens),
      cacheReadTokens: sum((row) => row.cacheReadTokens),
      cacheWriteTokens: sum((row) => row.cacheWriteTokens),
    };
    const counted = proposals.reduce(
      (total, row) => ({
        proposals: total.proposals + row.proposals,
        accepted: total.accepted + row.accepted,
        edited: total.edited + row.edited,
      }),
      { proposals: 0, accepted: 0, edited: 0 },
    );
    return {
      ...encounter,
      tasks,
      proposals: proposals.map(withAcceptance),
      totals: {
        attempts: sum((row) => row.attempts),
        ...tokens,
        costUsd: tasks.reduce((total, row) => addUsd(total, row.costUsd), '0.00000000'), // prettier-ignore
        cacheRate: cacheRate(tokens),
        proposals: counted.proposals,
        acceptance: acceptanceOf(counted),
      },
    };
  }

  /** AS-348, AS-350, AS-351. */
  async week(
    date: ClinicalDate,
    siteId: string | null,
    scope: QualityScope,
  ): Promise<WeekQuality> {
    const { weekStart, weekEnd } = weekOf(date);
    const window = { ...weekBounds(weekStart), siteId };
    const [rows, tasks, proposals, encounters, sites] = await Promise.all([
      this.reader.siteWeeks(window, scope),
      this.reader.tasks(window, scope),
      this.reader.proposals(window, scope),
      this.reader.assistedEncounters(window, scope),
      this.reader.sites(scope),
    ]);
    const figures = rows.map(withRates);
    return {
      weekStart,
      weekEnd,
      siteId,
      sites,
      total:
        figures.find((row) => row.siteId === null) ??
        emptyWeek(weekStart, null),
      bySite: figures.filter((row) => row.siteId !== null),
      tasks,
      proposals: proposals.map(withAcceptance),
      encounters,
    };
  }

  /** AS-352. One line per week and site with attentions, from `from`'s week to `to`'s. */
  async csv(
    from: ClinicalDate,
    to: ClinicalDate,
    scope: QualityScope,
  ): Promise<string> {
    const window = {
      startsAt: weekBounds(weekOf(from).weekStart).startsAt,
      endsAtExclusive: weekBounds(weekOf(to).weekStart).endsAtExclusive,
      siteId: null,
    };
    const rows = await this.reader.siteWeeks(window, scope);
    return qualityCsv(rows.filter((row) => row.siteId !== null).map(withRates));
  }
}
