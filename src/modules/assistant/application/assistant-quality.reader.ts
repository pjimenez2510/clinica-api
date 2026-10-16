import type {
  ProposalCounts,
  SiteWeekSums,
  TaskFigures,
} from '../domain/assistant-quality';

/**
 * AS-350. Whose attentions the board counts: those of the caller's sites for
 * `audit:read`, or —holding only `assistant:use`— those the caller attended,
 * at the sites where they hold it. Never a site or a person they named.
 */
export interface QualityScope {
  sites: 'all' | readonly string[];
  /** Set ⇔ only the attentions whose practitioner is this account. */
  practitionerUserId: string | null;
}

/** AS-345. The attention a breakdown is of: no patient, no text (AS-349). */
export interface QualityEncounter {
  encounterId: string;
  startedAt: Date;
  siteId: string;
  siteName: string;
  practitionerName: string;
  status: string;
}

/** AS-348. A row of the week's list of attentions with the assistant. */
export interface QualityEncounterRow extends QualityEncounter {
  attempts: number;
  costUsd: string;
  proposals: number;
  accepted: number;
  edited: number;
}

/** AS-346. The counts of one class (and section) of proposal. */
export interface ProposalSums extends ProposalCounts {
  kind: string;
  section: string | null;
}

/** The instants a week or a range covers: `[startsAt, endsAtExclusive)`. */
export interface QualityWindow {
  startsAt: Date;
  endsAtExclusive: Date;
  /** Only this site, already checked to be in scope by the guard's scope. */
  siteId: string | null;
}

/**
 * E19. The register of the assistant, counted. Reads `ai_run`,
 * `ai_suggestion`, `ai_suggestion_review` and the attention; never
 * `ai_exchange` nor the text of a proposal (AS-349).
 */
export interface AssistantQualityReader {
  /** AS-350. `null` when it does not exist or is outside the scope. */
  encounter(
    encounterId: string,
    scope: QualityScope,
  ): Promise<QualityEncounter | null>;
  /** AS-345. One attention's attempts, by task. */
  tasksOf(encounterId: string): Promise<TaskFigures[]>;
  /** AS-348. The same, over the attentions of a window. */
  tasks(window: QualityWindow, scope: QualityScope): Promise<TaskFigures[]>;
  /** AS-346, AS-347. One attention's proposals, by class and section. */
  proposalsOf(encounterId: string): Promise<ProposalSums[]>;
  /** AS-348. The same, over the attentions of a window. */
  proposals(
    window: QualityWindow,
    scope: QualityScope,
  ): Promise<ProposalSums[]>;
  /**
   * AS-348, AS-352. The sums by week and site, plus one row per week for all
   * the sites of the scope (`siteId` null); only weeks with attentions.
   */
  siteWeeks(
    window: QualityWindow,
    scope: QualityScope,
  ): Promise<SiteWeekSums[]>;
  /** AS-348. The attentions with at least one attempt, oldest first. */
  assistedEncounters(
    window: QualityWindow,
    scope: QualityScope,
  ): Promise<QualityEncounterRow[]>;
  /** The sites of the scope, for the selector. */
  sites(scope: QualityScope): Promise<{ id: string; name: string }[]>;
}

export const ASSISTANT_QUALITY_READER = Symbol('ASSISTANT_QUALITY_READER');
