import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  CIE10_LOOKUP,
  type Cie10Lookup,
} from '../../../shared/clinical/cie10-lookup.port';
import {
  acceptsNewContent,
  CODING_CONTEXT_READER,
  type CodingContextReader,
  type CodingEncounter,
} from '../../../shared/clinical/coding-context.port';
import {
  AssistantEncounterClosedError,
  AssistantEncounterNotFoundError,
  AssistantNoteEmptyError,
  AssistantNotEncounterOwnerError,
  AssistantProposalNotKeptError,
  SuggestionDiagnosisMismatchError,
  SuggestionNotFoundError,
} from '../domain/assistant.errors';
import {
  backedProblems,
  baselineOf,
  type BaselineCode,
  currentReading,
  type DiagnosisProposal,
  type OfferedCode,
  PROPOSED,
} from '../domain/problem-coding';
import type { SuggestionStatus, SuggestionView } from '../domain/suggestion';

import { LLM_CLIENT, type LlmClient } from './llm-client.port';
import {
  CODES_INSTRUCTIONS,
  CODES_MAX_TOKENS,
  CODES_PROMPT_VERSION,
  CODES_PURPOSE,
  codesAnswer,
  noteText,
  PROBLEMS_INSTRUCTIONS,
  PROBLEMS_MAX_TOKENS,
  PROBLEMS_PROMPT_VERSION,
  PROBLEMS_PURPOSE,
  problemLine,
  problemsAnswer,
} from './problem-coding.prompts';
import {
  PSEUDONYMIZER,
  type Pseudonymizer,
  restorePlaceholders,
} from './pseudonymizer.port';
import {
  type SuggestionRequester,
  SuggestionService,
} from './suggestion.service';

export const DIAGNOSIS_PROPOSAL_CLOCK = Symbol('DIAGNOSIS_PROPOSAL_CLOCK');
/** AS-029. Whether the chain is the fake of the demonstration mode. */
export const ASSISTANT_DEMO = Symbol('ASSISTANT_DEMO');

/** AS-040. SigmAI's `NAMING_LIMIT_MS`: the physician is waiting on a button. */
export const READING_LIMIT_MS = 90_000;
/** D-245 §4. The clinic's frequency counts twelve months. */
const FREQUENCY_WINDOW_MS = 365 * 86_400_000;
const FROM_HISTORY = 10;
const FROM_FREQUENCY = 10;

/** The audit trail's name for what the overview reads (EN-047 reads the same). */
const RESOURCE_TYPE = 'assistant_diagnosis';

export interface ProposalRequester {
  userId: string;
  /** Where the requester may read the history (`record:read`). */
  readSites: 'all' | readonly string[];
  /** Where the requester may write it (`record:write`). */
  writeSites: 'all' | readonly string[];
  ip?: string;
  userAgent?: string;
}

export interface ProblemView {
  id: string;
  problem: string;
  quote: string;
  section: string;
  candidates: (OfferedCode & { recorded: boolean })[];
  status: SuggestionStatus;
  /** The diagnosis it was accepted as, if it was. */
  diagnosisId: string | null;
  demo: boolean;
}

export interface DiagnosisOverview {
  baseline: BaselineCode[];
  problems: ProblemView[];
  /** When the problems shown were read; null when nobody asked yet. */
  readAt: Date | null;
  /** AS-029. The demonstration mode is on: nothing here came from a model. */
  demo: boolean;
}

export interface ReadingResult extends DiagnosisOverview {
  /** How many problems the model named whose phrase is not in the note. */
  dropped: number;
}

/**
 * AS-027, AS-028, AS-035 to AS-041. The CIE-10 the assistant proposes in
 * Diagnósticos: the baseline with no model, and on demand the problems of
 * the note with their phrase and the codes the WHO catalogue has.
 *
 * Nothing is recorded here (P1): the diagnosis goes through its own route,
 * and accepting only links the proposal to it.
 */
@Injectable()
export class DiagnosisProposalService {
  private readonly logger = new Logger(DiagnosisProposalService.name);

  constructor(
    @Inject(CODING_CONTEXT_READER) private readonly context: CodingContextReader, // prettier-ignore
    @Inject(CIE10_LOOKUP) private readonly catalogue: Cie10Lookup,
    @Inject(PSEUDONYMIZER) private readonly pseudonymizer: Pseudonymizer,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    private readonly suggestions: SuggestionService,
    @Inject(ACCESS_AUDIT_RECORDER) private readonly audit: AccessAuditRecorder,
    @Inject(DIAGNOSIS_PROPOSAL_CLOCK) private readonly clock: () => Date,
    @Inject(ASSISTANT_DEMO) private readonly demo: boolean,
  ) {}

  /** AS-027, AS-036. What Diagnósticos shows on opening. A read of the history. */
  async overview(
    encounterId: string,
    requester: ProposalRequester,
  ): Promise<DiagnosisOverview> {
    const encounter = await this.encounterFor(encounterId, requester.readSites);
    const overview = await this.overviewOf(encounter, {
      userId: requester.userId,
      sites: requester.readSites,
    });
    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: encounter.id,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
    return overview;
  }

  /**
   * AS-028, AS-035, AS-036, AS-039, AS-040. Reads the problems out of the
   * note and keeps them as proposals. On any failure nothing is kept and
   * nothing that was there is touched.
   */
  async read(
    encounterId: string,
    requester: ProposalRequester,
  ): Promise<ReadingResult> {
    const encounter = await this.ownLiveEncounter(encounterId, requester);
    const note = await this.context.consultationNote(encounter.id);
    if (!note || note.sections.length === 0)
      throw new AssistantNoteEmptyError();

    const signal = AbortSignal.timeout(READING_LIMIT_MS);
    const people = await this.context.people(encounter.id);
    const cleared = await this.pseudonymizer.pseudonymize(
      {
        text: noteText(note.sections),
        subject: encounter.patientId,
        names: people.patient,
        staff: people.staff,
      },
      signal,
    );
    const named = await this.llm.generate({
      tier: 'quality',
      purpose: PROBLEMS_PURPOSE,
      promptVersion: PROBLEMS_PROMPT_VERSION,
      system: PROBLEMS_INSTRUCTIONS,
      prompt: cleared.cleared,
      answer: problemsAnswer,
      maxTokens: PROBLEMS_MAX_TOKENS,
      signal,
      encounterId: encounter.id,
    });
    if (named.runId === null) throw new AssistantProposalNotKeptError();

    const restore = (text: string) =>
      restorePlaceholders(text, cleared.replacements);
    const backed = backedProblems({
      named: named.value.problems.map((each) => ({ ...each, codes: [] })),
      cleared: cleared.cleared,
      sections: note.sections,
      restore,
    });

    const coded = await Promise.all(
      backed.kept.map(async (problem) => {
        const line = await this.pseudonymizer.pseudonymize(
          {
            text: problemLine(problem.problem),
            subject: encounter.patientId,
            names: people.patient,
            staff: people.staff,
          },
          signal,
        );
        const answer = await this.llm.generate({
          tier: 'quality',
          purpose: CODES_PURPOSE,
          promptVersion: CODES_PROMPT_VERSION,
          system: CODES_INSTRUCTIONS,
          prompt: line.cleared,
          answer: codesAnswer,
          maxTokens: CODES_MAX_TOKENS,
          signal,
          encounterId: encounter.id,
        });
        return { problem, written: answer.value.codes.slice(0, PROPOSED) };
      }),
    );

    // AS-035. The barrier: only what the WHO catalogue has, in force today.
    const resolved = await this.catalogue.resolveWritten(
      coded.flatMap(({ written }) => written),
      encounter.clinicalDate,
    );
    let next = 0;
    const proposals = coded.map(({ problem, written }) => {
      const candidates = dedupe(
        written.map(() => resolved[next++]).filter(isEntry),
      );
      const proposal: DiagnosisProposal = {
        problem: problem.problem,
        quote: problem.quote,
        section: problem.section,
        codes: candidates.map(({ code }) => code),
        candidates,
        demo: this.demo,
      };
      return proposal;
    });

    if (proposals.length > 0) {
      await this.suggestions.propose(
        proposals.map((proposal) => ({
          encounterId: encounter.id,
          aiRunId: named.runId!,
          kind: 'diagnosis',
          proposal: { ...proposal },
          sources: [{ kind: 'chart', table: 'clinical_note', id: note.id }],
        })),
        writer(requester),
      );
    }

    // AS-041. Counts only: no problem, no phrase, no code reaches the log.
    this.logger.log(
      {
        problems: proposals.length,
        problems_without_quote: backed.dropped,
        codes_written: coded.reduce((sum, each) => sum + each.written.length, 0), // prettier-ignore
        codes_shown: proposals.reduce((sum, each) => sum + each.codes.length, 0), // prettier-ignore
      },
      'assistant problems read',
    );

    return {
      ...(await this.overviewOf(encounter, writer(requester))),
      dropped: backed.dropped,
    };
  }

  /** AS-037. Links a proposal to the diagnosis the physician recorded from it. */
  async accept(
    input: { encounterId: string; suggestionId: string; diagnosisId: string },
    requester: ProposalRequester,
  ): Promise<DiagnosisOverview> {
    const encounter = await this.ownLiveEncounter(input.encounterId, requester);
    await this.proposalOf(encounter.id, input.suggestionId, requester);
    const diagnosis = await this.context.diagnosisOf(
      encounter.id,
      input.diagnosisId,
    );
    if (!diagnosis) throw new SuggestionDiagnosisMismatchError();
    // AS-022. The store reads the code of the diagnosis itself, in the same
    // transaction that decides: nothing the caller says is the saved value.
    await this.suggestions.accept(
      { suggestionId: input.suggestionId, recordId: diagnosis.id },
      writer(requester),
    );
    return this.overviewOf(encounter, writer(requester));
  }

  /** AS-038. The physician says no to a proposal. */
  async discard(
    input: { encounterId: string; suggestionId: string },
    requester: ProposalRequester,
  ): Promise<DiagnosisOverview> {
    const encounter = await this.ownLiveEncounter(input.encounterId, requester);
    await this.proposalOf(encounter.id, input.suggestionId, requester);
    await this.suggestions.discard(input.suggestionId, writer(requester));
    return this.overviewOf(encounter, writer(requester));
  }

  private async overviewOf(
    encounter: CodingEncounter,
    reader: SuggestionRequester,
  ): Promise<DiagnosisOverview> {
    const since = new Date(this.clock().getTime() - FREQUENCY_WINDOW_MS);
    const [history, frequency, recorded, stored] = await Promise.all([
      this.context.patientHistory(encounter.patientId, encounter.id, FROM_HISTORY), // prettier-ignore
      this.context.clinicFrequency(since, FROM_FREQUENCY),
      this.context.recordedCodes(encounter.id),
      this.suggestions.ofEncounter(encounter.id, reader, 'diagnosis'),
    ]);
    const codes = [...new Set([...history, ...frequency].map(({ code }) => code))]; // prettier-ignore
    const entries = await this.catalogue.resolveWritten(
      codes,
      encounter.clinicalDate,
    );
    const resolved = new Map(
      codes.flatMap((code, index) => {
        const entry = entries[index];
        return entry && entry.code === code ? [[code, entry] as const] : [];
      }),
    );
    const shown = currentReading(stored);
    const taken = new Set(recorded);

    return {
      baseline: baselineOf({ history, frequency, recorded, resolved }),
      problems: shown.map((suggestion) => problemView(suggestion, taken)),
      readAt: shown[0]?.proposedAt ?? null,
      demo: this.demo,
    };
  }

  /** EN-121. Absent and out of reach are one answer. */
  private async encounterFor(
    encounterId: string,
    sites: 'all' | readonly string[],
  ): Promise<CodingEncounter> {
    const encounter = await this.context.encounter(encounterId, sites);
    if (!encounter) throw new AssistantEncounterNotFoundError();
    return encounter;
  }

  /** AS-039 (M-02). Its own professional, where they write, while it is live. */
  private async ownLiveEncounter(
    encounterId: string,
    requester: ProposalRequester,
  ): Promise<CodingEncounter> {
    const encounter = await this.encounterFor(encounterId, requester.writeSites); // prettier-ignore
    if (encounter.practitionerUserId !== requester.userId) {
      throw new AssistantNotEncounterOwnerError();
    }
    if (!acceptsNewContent(encounter.status)) {
      throw new AssistantEncounterClosedError();
    }
    return encounter;
  }

  /** The proposal, only when it is a diagnosis of this attention. */
  private async proposalOf(
    encounterId: string,
    suggestionId: string,
    requester: ProposalRequester,
  ): Promise<SuggestionView> {
    const stored = await this.suggestions.ofEncounter(
      encounterId,
      writer(requester),
      'diagnosis',
    );
    const found = stored.find((each) => each.id === suggestionId);
    if (!found) throw new SuggestionNotFoundError();
    return found;
  }
}

/** Who decides, with the sites where they write the history (AS-039). */
function writer(requester: ProposalRequester): SuggestionRequester {
  return { userId: requester.userId, sites: requester.writeSites };
}

function isEntry<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function dedupe(entries: readonly OfferedCode[]): OfferedCode[] {
  const seen = new Set<string>();
  return entries.filter(
    (entry) => !seen.has(entry.code) && Boolean(seen.add(entry.code)),
  );
}

function problemView(
  suggestion: SuggestionView,
  recorded: ReadonlySet<string>,
): ProblemView {
  const proposal = suggestion.proposal as unknown as DiagnosisProposal;
  return {
    id: suggestion.id,
    problem: proposal.problem,
    quote: proposal.quote,
    section: proposal.section,
    candidates: proposal.candidates.map((candidate) => ({
      ...candidate,
      recorded: recorded.has(candidate.code),
    })),
    status: suggestion.status,
    diagnosisId:
      suggestion.record?.kind === 'encounter_diagnosis'
        ? suggestion.record.id
        : null,
    demo: proposal.demo,
  };
}
