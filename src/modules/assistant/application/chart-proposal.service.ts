import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  ALLERGY_ABSENCE_READER,
  type AllergyAbsenceReader,
} from '../../../shared/clinical/allergy-absence.port';
import {
  CHART_BACKGROUND_READER,
  type ChartBackgroundReader,
  type ChartRecordKind,
} from '../../../shared/clinical/chart-background.port';
import {
  acceptsNewContent,
  CODING_CONTEXT_READER,
  type CodingContextReader,
  type CodingEncounter,
} from '../../../shared/clinical/coding-context.port';
import {
  SURVIVING_CHART_ALLERGY_READER,
  type SurvivingChartAllergyReader,
} from '../../../shared/clinical/patient-allergy.port';
import {
  AssistantEncounterClosedError,
  AssistantEncounterNotFoundError,
  AssistantNotEncounterOwnerError,
  SuggestionChartMismatchError,
  SuggestionNotFoundError,
} from '../domain/assistant.errors';
import { shownChart, type ChartProposalView } from '../domain/chart-background';
import type { Lexicon } from '../domain/lexicon';
import type { TranscriptLine } from '../domain/note-draft';
import type { SuggestionKind, SuggestionView } from '../domain/suggestion';

import { readChart } from './chart-reader';
import { ASSISTANT_DEMO } from './diagnosis-proposal.service';
import { LISTENING_STORE, type ListeningStore } from './listening.store';
import { LLM_CLIENT, type LlmClient } from './llm-client.port';
import { PSEUDONYMIZER, type Pseudonymizer } from './pseudonymizer.port';
import {
  type SuggestionRequester,
  SuggestionService,
} from './suggestion.service';

/** The trail's names (EN-122): the chart read with the proposals. */
const RESOURCE_TYPE = 'assistant_chart';

/** AS-260. The kinds of a proposal of the chart, and the record each becomes. */
const CHART_KINDS = {
  'chart-allergy': 'allergy',
  'chart-no-allergy': 'absence',
  'chart-history': 'history',
} as const satisfies Partial<Record<SuggestionKind, ChartRecordKind>>;

type ChartKind = keyof typeof CHART_KINDS;

const isChartKind = (kind: SuggestionKind): kind is ChartKind =>
  Object.hasOwn(CHART_KINDS, kind);

export interface ChartRequester {
  userId: string;
  /** Where the requester may write the history (`record:write`). */
  writeSites: 'all' | readonly string[];
  ip?: string;
  userAgent?: string;
}

export interface ChartOverview {
  proposals: ChartProposalView[];
  /** AS-029. The demonstration mode is on: nothing here came from a model. */
  demo: boolean;
}

/**
 * AS-260 to AS-265. What the conversation said of the patient's chart,
 * proposed as its records: read after each draft, shown in Antecedentes, and
 * linked once the physician records it by the chart's own route. Nothing is
 * recorded here (P1).
 */
@Injectable()
export class ChartProposalService {
  private readonly logger = new Logger(ChartProposalService.name);

  constructor(
    @Inject(CODING_CONTEXT_READER) private readonly context: CodingContextReader, // prettier-ignore
    @Inject(CHART_BACKGROUND_READER) private readonly chart: ChartBackgroundReader, // prettier-ignore
    @Inject(SURVIVING_CHART_ALLERGY_READER) private readonly allergies: SurvivingChartAllergyReader, // prettier-ignore
    @Inject(ALLERGY_ABSENCE_READER) private readonly absences: AllergyAbsenceReader, // prettier-ignore
    @Inject(LISTENING_STORE) private readonly transcripts: ListeningStore,
    @Inject(PSEUDONYMIZER) private readonly pseudonymizer: Pseudonymizer,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    private readonly suggestions: SuggestionService,
    @Inject(ACCESS_AUDIT_RECORDER) private readonly audit: AccessAuditRecorder,
    @Inject(ASSISTANT_DEMO) private readonly demo: boolean,
  ) {}

  /**
   * AS-260. Reads the chart out of the stretch a draft was written from, in
   * the name of who asked for the draft. A failure is logged with its code
   * and never reaches the draft (the caller does not wait on it failing).
   */
  async readFrom(input: {
    encounter: CodingEncounter;
    lines: readonly TranscriptLine[];
    requestedBy: string;
    lexicon: Lexicon | null;
    signal?: AbortSignal;
  }): Promise<number> {
    const people = await this.context.people(input.encounter.id);
    const read = await readChart(
      { pseudonymizer: this.pseudonymizer, llm: this.llm, lexicon: input.lexicon }, // prettier-ignore
      {
        subject: input.encounter.patientId,
        names: people.patient,
        staff: people.staff,
        lines: input.lines,
        encounterId: input.encounter.id,
        signal: input.signal,
      },
    );
    if (read.runId === null || read.kept.length === 0) return 0;
    const runId = read.runId;
    await this.suggestions.propose(
      read.kept.map((proposal) => ({
        encounterId: input.encounter.id,
        aiRunId: runId,
        kind: proposal.kind,
        proposal: { ...proposal, demo: this.demo },
        sources: [{ kind: 'transcript' as const, fromMs: proposal.fromMs, toMs: proposal.toMs }], // prettier-ignore
      })),
      { userId: input.requestedBy, sites: 'all' },
    );
    // AS-262. Counts only: no allergy, no history reaches the log.
    this.logger.log(
      {
        encounter_id: input.encounter.id,
        assistant_chart_proposed: read.kept.length,
        assistant_chart_dropped: read.dropped,
      },
      'assistant chart read',
    );
    return read.kept.length;
  }

  /** AS-263. What Antecedentes shows. A read of the history. */
  async overview(
    encounterId: string,
    requester: ChartRequester,
  ): Promise<ChartOverview> {
    const encounter = await this.ownEncounter(encounterId, requester);
    const overview = await this.overviewOf(encounter, requester);
    await this.trail(encounter, requester);
    return overview;
  }

  /**
   * AS-265. Links a shown proposal to the record the physician just made by
   * the chart's own route: of this patient, of the proposal's class, by
   * whoever accepts and after it was proposed. The store compares what was
   * recorded with what was proposed (AS-022).
   */
  async accept(
    input: { encounterId: string; suggestionId: string; recordId: string },
    requester: ChartRequester,
  ): Promise<ChartOverview> {
    const encounter = await this.ownLiveEncounter(input.encounterId, requester);
    const { suggestion, view } = await this.shownOf(encounter, input.suggestionId, requester); // prettier-ignore
    if (view.conflict !== null) throw new SuggestionChartMismatchError();
    const record = await this.chart.record(
      CHART_KINDS[suggestion.kind as ChartKind],
      input.recordId,
    );
    if (
      !record ||
      record.patientId !== encounter.patientId ||
      record.authorId !== requester.userId ||
      record.recordedAt < suggestion.proposedAt
    ) {
      throw new SuggestionChartMismatchError();
    }
    await this.suggestions.accept(
      { suggestionId: suggestion.id, recordId: input.recordId },
      writer(requester),
    );
    await this.trail(encounter, requester);
    return this.overviewOf(encounter, requester);
  }

  /** AS-265 (AS-038). The physician does not want this one. */
  async discard(
    input: { encounterId: string; suggestionId: string },
    requester: ChartRequester,
  ): Promise<ChartOverview> {
    const encounter = await this.ownLiveEncounter(input.encounterId, requester);
    const { suggestion } = await this.shownOf(encounter, input.suggestionId, requester); // prettier-ignore
    await this.suggestions.discard(suggestion.id, writer(requester));
    await this.trail(encounter, requester);
    return this.overviewOf(encounter, requester);
  }

  /** AS-263, AS-264. The current reading against the chart as it is now. */
  private async overviewOf(
    encounter: CodingEncounter,
    requester: ChartRequester,
  ): Promise<ChartOverview> {
    const [stored, allergies, absence, history, transcript] = await Promise.all(
      [
        this.chartSuggestions(encounter, requester),
        this.allergies.activeForSurvivorOf(encounter.patientId),
        this.absences.standingAbsenceFor(encounter.patientId),
        this.chart.activeHistory(encounter.patientId),
        this.transcripts.transcript(encounter.id),
      ],
    );
    const latest = stored.reduce<SuggestionView | null>(
      (last, each) => (last === null || each.proposedAt > last.proposedAt ? each : last), // prettier-ignore
      null,
    );
    const discarded = stored.flatMap((each) =>
      each.status === 'DISCARDED' && typeof each.proposal.text === 'string'
        ? [each.proposal.text]
        : [],
    );
    const current = latest
      ? stored.filter((each) => each.aiRunId === latest.aiRunId)
      : [];
    return {
      proposals: shownChart(
        current,
        discarded,
        {
          allergies: allergies.map((each) => each.substanceText),
          absence: absence !== null,
          history,
        },
        transcript,
      ),
      demo: this.demo,
    };
  }

  /** The proposal by its id, only when the screen shows it now. */
  private async shownOf(
    encounter: CodingEncounter,
    suggestionId: string,
    requester: ChartRequester,
  ): Promise<{ suggestion: SuggestionView; view: ChartProposalView }> {
    const { proposals } = await this.overviewOf(encounter, requester);
    const view = proposals.find((each) => each.id === suggestionId);
    const suggestion = view
      ? (await this.chartSuggestions(encounter, requester)).find((each) => each.id === suggestionId) // prettier-ignore
      : undefined;
    if (!view || !suggestion) throw new SuggestionNotFoundError();
    return { suggestion, view };
  }

  private async chartSuggestions(
    encounter: CodingEncounter,
    requester: ChartRequester,
  ): Promise<SuggestionView[]> {
    const all = await this.suggestions.ofEncounter(encounter.id, writer(requester)); // prettier-ignore
    return all.filter((each) => isChartKind(each.kind));
  }

  private async trail(
    encounter: CodingEncounter,
    requester: ChartRequester,
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: encounter.id,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }

  /** AS-263 (AS-039, EN-121). Its own professional, where they write. */
  private async ownEncounter(
    encounterId: string,
    requester: ChartRequester,
  ): Promise<CodingEncounter> {
    const encounter = await this.context.encounter(encounterId, requester.writeSites); // prettier-ignore
    if (!encounter) throw new AssistantEncounterNotFoundError();
    if (encounter.practitionerUserId !== requester.userId) {
      throw new AssistantNotEncounterOwnerError();
    }
    return encounter;
  }

  /** AS-265. And the attention still takes new clinical content. */
  private async ownLiveEncounter(
    encounterId: string,
    requester: ChartRequester,
  ): Promise<CodingEncounter> {
    const encounter = await this.ownEncounter(encounterId, requester);
    if (!acceptsNewContent(encounter.status)) {
      throw new AssistantEncounterClosedError();
    }
    return encounter;
  }
}

function writer(requester: ChartRequester): SuggestionRequester {
  return { userId: requester.userId, sites: requester.writeSites };
}
