import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  acceptsNewContent,
  CODING_CONTEXT_READER,
  type CodingContextReader,
  type CodingEncounter,
} from '../../../shared/clinical/coding-context.port';
import {
  ORDERING_CONTEXT_READER,
  type OrderableExam,
  type OrderingContextReader,
} from '../../../shared/clinical/ordering-context.port';
import {
  AssistantEncounterClosedError,
  AssistantEncounterNotFoundError,
  AssistantNoteEmptyError,
  AssistantNotEncounterOwnerError,
  AssistantProposalNotKeptError,
  AssistantReadingInProgressError,
  PseudonymizerFailedError,
  SuggestionAlreadyDecidedError,
  SuggestionInvalidError,
  SuggestionNotFoundError,
  SuggestionOrderMismatchError,
} from '../domain/assistant.errors';
import {
  backedExams,
  blockOf,
  offeredCandidates,
  stillSaid,
  type CandidateBlock,
  type ExamCandidate,
  type ExamOrigin,
  type OrderProposal,
  type SpokenSegment,
} from '../domain/order-reading';
import { carriesAnIdentifier, currentReading } from '../domain/problem-coding';
import type {
  SuggestionSource,
  SuggestionStatus,
  SuggestionView,
} from '../domain/suggestion';

import {
  ASSISTANT_DEMO,
  type ProposalRequester,
} from './diagnosis-proposal.service';
import { LISTENING_STORE, type ListeningStore } from './listening.store';
import { LLM_CLIENT, withContext, type LlmClient } from './llm-client.port';
import {
  catalogueContext,
  conversationText,
  EXAMS_INSTRUCTIONS,
  EXAMS_MAX_TOKENS,
  EXAMS_PROMPT_VERSION,
  EXAMS_PURPOSE,
  examsAnswer,
  MOST_EXAMS,
} from './order-reading.prompts';
import { noteText } from './problem-coding.prompts';
import {
  PSEUDONYMIZER,
  type Pseudonymizer,
  restorePlaceholders,
} from './pseudonymizer.port';
import {
  type SuggestionRequester,
  SuggestionService,
} from './suggestion.service';

/** AS-112. The same deadline as the other readings: a physician is waiting. */
export const ORDER_READING_LIMIT_MS = 90_000;

/** The trail's names: what is read, and the text sent cleared (EN-122). */
const RESOURCE_TYPE = 'assistant_orders';
const READING_RESOURCE_TYPE = 'assistant_orders_reading';

export interface ExamCandidateView extends ExamCandidate {
  /** AS-106. Why it cannot be accepted now, or null. */
  block: CandidateBlock | null;
}

export interface ExamLineView {
  id: string;
  quote: string;
  origin: ExamOrigin;
  candidates: ExamCandidateView[];
  status: SuggestionStatus;
  /** The order it went to, once linked. */
  serviceOrderId: string | null;
  /** The code it was accepted as, once linked. */
  acceptedCode: string | null;
  demo: boolean;
}

export interface OrdersOverview {
  lines: ExamLineView[];
  readAt: Date | null;
  demo: boolean;
}

export interface OrdersReadingResult extends OrdersOverview {
  found: number;
  dropped: number;
}

/**
 * AS-103 to AS-113. The exams the assistant proposes in Exámenes: what the
 * note and the conversation ask for, each with up to five exams of the
 * clinic's catalogue. Nothing here writes an order (P1, AS-108): the
 * physician adds the one chosen to the draft through the order's own route.
 */
@Injectable()
export class OrderProposalService {
  private readonly logger = new Logger(OrderProposalService.name);
  private readonly reading = new Set<string>();

  constructor(
    @Inject(CODING_CONTEXT_READER) private readonly context: CodingContextReader, // prettier-ignore
    @Inject(ORDERING_CONTEXT_READER) private readonly ordering: OrderingContextReader, // prettier-ignore
    @Inject(LISTENING_STORE) private readonly listening: ListeningStore,
    @Inject(PSEUDONYMIZER) private readonly pseudonymizer: Pseudonymizer,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    private readonly suggestions: SuggestionService,
    @Inject(ACCESS_AUDIT_RECORDER) private readonly audit: AccessAuditRecorder,
    @Inject(ASSISTANT_DEMO) private readonly demo: boolean,
  ) {}

  /** AS-106, AS-111. What Exámenes shows: resolved again, now. */
  async overview(
    encounterId: string,
    requester: ProposalRequester,
  ): Promise<OrdersOverview> {
    const encounter = await this.encounterFor(encounterId, requester.readSites);
    const overview = await this.overviewOf(encounter, requester);
    await this.trail(encounter, requester);
    return overview;
  }

  /** AS-103 to AS-107, AS-112, AS-113. Reads the exams out of the consultation. */
  async read(
    encounterId: string,
    requester: ProposalRequester,
  ): Promise<OrdersReadingResult> {
    const encounter = await this.ownLiveEncounter(encounterId, requester);
    if (this.reading.has(encounter.id)) {
      throw new AssistantReadingInProgressError();
    }
    this.reading.add(encounter.id);
    try {
      return await this.readConsultation(encounter, requester);
    } finally {
      this.reading.delete(encounter.id);
    }
  }

  private async readConsultation(
    encounter: CodingEncounter,
    requester: ProposalRequester,
  ): Promise<OrdersReadingResult> {
    const [note, transcript] = await Promise.all([
      this.context.consultationNote(encounter.id),
      this.listening.transcript(encounter.id),
    ]);
    const sections = note?.sections ?? [];
    const spoken = transcript.filter((each) => each.text.trim() !== '');
    if (sections.length === 0 && spoken.length === 0) {
      throw new AssistantNoteEmptyError();
    }
    const catalogue = await this.ordering.orderableExams();

    // EN-122. The consultation leaves for a provider: who asked, first.
    await this.audit.record({
      userId: requester.userId,
      resourceType: READING_RESOURCE_TYPE,
      resourceId: encounter.id,
      action: 'EXPORT',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    const signal = AbortSignal.timeout(ORDER_READING_LIMIT_MS);
    const people = await this.context.people(encounter.id);
    const text = [
      sections.length > 0 ? noteText(sections) : '',
      conversationText(spoken),
    ]
      .filter((part) => part !== '')
      .join('\n\n');
    const cleared = await this.pseudonymizer.pseudonymize(
      { text, subject: encounter.patientId, names: people.patient, staff: people.staff }, // prettier-ignore
      signal,
    );
    // AS-025 (P4). An identifier still in the cleared text: fail closed.
    if (carriesAnIdentifier(cleared.cleared)) {
      throw new PseudonymizerFailedError('invalid-answer');
    }

    const answer = await this.llm.generate({
      tier: 'quality',
      purpose: EXAMS_PURPOSE,
      promptVersion: EXAMS_PROMPT_VERSION,
      system: EXAMS_INSTRUCTIONS,
      prompt: withContext(cleared.cleared, catalogueContext(catalogue)),
      answer: examsAnswer,
      maxTokens: EXAMS_MAX_TOKENS,
      signal,
      encounterId: encounter.id,
    });
    if (answer.runId === null) throw new AssistantProposalNotKeptError();

    const backed = backedExams({
      read: answer.value.exams.slice(0, MOST_EXAMS),
      cleared: cleared.cleared,
      sections,
      transcript: spoken,
      restore: (part) => restorePlaceholders(part, cleared.replacements),
    });

    const proposals = backed.kept.map((exam): OrderProposal => {
      // AS-104. Only numbers offered; names are the catalogue's.
      const candidates = offeredCandidates(exam.candidates, catalogue).map(
        candidateOf,
      );
      return {
        requested: exam.requested,
        quote: exam.quote,
        origin: exam.origin,
        candidates,
        codes: candidates.map((each) => each.code),
        demo: this.demo,
      };
    });

    // AS-112. Up to 90 s went by: nothing is kept on an attention closed since.
    await this.ownLiveEncounter(encounter.id, requester);
    if (proposals.length > 0) {
      await this.suggestions.propose(
        proposals.map((proposal) => ({
          encounterId: encounter.id,
          aiRunId: answer.runId!,
          kind: 'order-item',
          proposal: { ...proposal },
          sources: [sourceOf(proposal.origin, note?.id)],
        })),
        writer(requester),
      );
    }

    // AS-113. Counts only: no exam, no phrase reaches the log.
    this.logger.log(
      {
        assistant_exams: proposals.length,
        assistant_exams_without_quote: backed.dropped,
        assistant_exams_without_candidates: proposals.filter((each) => each.candidates.length === 0).length, // prettier-ignore
      },
      'assistant exams read',
    );

    return {
      ...(await this.overviewOf(encounter, requester)),
      found: proposals.length,
      dropped: backed.dropped,
    };
  }

  /**
   * AS-109. Links each proposal to the order its exam was saved in, reading
   * that order: of this attention, not discarded, with a live line of the
   * exam, which is one of the proposal's candidates and the answer of no
   * other proposal there. Everything is checked before anything is written.
   */
  async link(
    input: {
      encounterId: string;
      serviceOrderId: string;
      lines: readonly { suggestionId: string; serviceId: string }[];
    },
    requester: ProposalRequester,
  ): Promise<OrdersOverview> {
    const encounter = await this.ownLiveEncounter(input.encounterId, requester);
    const ids = input.lines.map((each) => each.suggestionId);
    const services = input.lines.map((each) => each.serviceId);
    if (
      ids.length === 0 ||
      new Set(ids).size !== ids.length ||
      new Set(services).size !== services.length
    ) {
      throw new SuggestionInvalidError('lines');
    }
    const stored = await this.suggestions.ofEncounter(encounter.id, writer(requester), 'order-item'); // prettier-ignore
    const shown = await this.shownOf(encounter, stored, requester);
    const saved = await this.ordering.orderCodes(encounter.id, input.serviceOrderId); // prettier-ignore
    if (saved === null) throw new SuggestionOrderMismatchError();
    // The exams of that order other proposals already answer for.
    const taken = new Set(
      stored.flatMap((each) =>
        each.record?.kind === 'service_order' &&
        each.record.id === input.serviceOrderId
          ? acceptedCodeOf(each)
          : [],
      ),
    );

    const accepted = input.lines.map(({ suggestionId, serviceId }) => {
      const suggestion = shown.find((each) => each.id === suggestionId);
      if (!suggestion) throw new SuggestionNotFoundError();
      if (suggestion.status !== 'PROPOSED') {
        throw new SuggestionAlreadyDecidedError();
      }
      const candidate = proposalOf(suggestion).candidates.find(
        (each) => each.serviceId === serviceId,
      );
      if (
        !candidate ||
        !saved.includes(candidate.code) ||
        taken.has(candidate.code)
      ) {
        throw new SuggestionOrderMismatchError();
      }
      return { suggestionId, code: candidate.code };
    });
    for (const { suggestionId, code } of accepted) {
      await this.suggestions.accept(
        { suggestionId, recordId: input.serviceOrderId, saved: code },
        writer(requester),
      );
    }
    await this.trail(encounter, requester);
    return this.overviewOf(encounter, requester);
  }

  /** AS-110. The physician says no to a line. */
  async discard(
    input: { encounterId: string; suggestionId: string },
    requester: ProposalRequester,
  ): Promise<OrdersOverview> {
    const encounter = await this.ownLiveEncounter(input.encounterId, requester);
    const stored = await this.suggestions.ofEncounter(encounter.id, writer(requester), 'order-item'); // prettier-ignore
    if (!stored.some((each) => each.id === input.suggestionId)) {
      throw new SuggestionNotFoundError();
    }
    await this.suggestions.discard(input.suggestionId, writer(requester));
    await this.trail(encounter, requester);
    return this.overviewOf(encounter, requester);
  }

  /** AS-106, AS-107. The current reading, its candidates resolved now. */
  private async overviewOf(
    encounter: CodingEncounter,
    requester: ProposalRequester,
  ): Promise<OrdersOverview> {
    const stored = await this.suggestions.ofEncounter(
      encounter.id,
      { userId: requester.userId, sites: requester.readSites },
      'order-item',
    );
    const [shown, catalogue, ordered] = await Promise.all([
      this.shownOf(encounter, stored, requester),
      this.ordering.orderableExams(),
      this.ordering.orderedCodes(encounter.id),
    ]);
    const now = new Map(catalogue.map((exam) => [exam.serviceId, exam]));
    const taken = new Set(ordered);

    return {
      lines: shown.map((suggestion) => {
        const proposal = proposalOf(suggestion);
        // AS-106. Only what the catalogue still orders, as it names it now.
        const candidates = proposal.candidates.flatMap((stored) => {
          const exam = now.get(stored.serviceId);
          if (!exam) return [];
          const candidate = candidateOf(exam);
          return [
            {
              ...candidate,
              block:
                suggestion.status === 'PROPOSED'
                  ? blockOf(candidate, taken)
                  : null,
            },
          ];
        });
        return {
          id: suggestion.id,
          quote: proposal.quote,
          origin: proposal.origin,
          candidates,
          status: suggestion.status,
          serviceOrderId:
            suggestion.record?.kind === 'service_order'
              ? suggestion.record.id
              : null,
          acceptedCode: acceptedCodeOf(suggestion)[0] ?? null,
          demo: proposal.demo,
        };
      }),
      readAt: shown[0]?.proposedAt ?? null,
      demo: this.demo,
    };
  }

  /**
   * AS-106, AS-107. The lines of the latest reading, less the discarded,
   * whose sentence is still said. One said in the conversation is shown only
   * to the attention's professional, who alone sees the transcript (AS-056).
   */
  private async shownOf(
    encounter: CodingEncounter,
    stored: readonly SuggestionView[],
    requester: ProposalRequester,
  ): Promise<SuggestionView[]> {
    const own = encounter.practitionerUserId === requester.userId;
    const [note, transcript] = await Promise.all([
      this.context.consultationNote(encounter.id),
      own
        ? this.listening.transcript(encounter.id)
        : Promise.resolve<SpokenSegment[]>([]),
    ]);
    const sections = note?.sections ?? [];
    return currentReading(stored).filter((suggestion) => {
      const { quote, origin } = suggestion.proposal as Partial<OrderProposal>;
      if (typeof quote !== 'string') return false;
      if (origin?.kind === 'transcript' && !own) return false;
      return stillSaid(quote, sections, transcript);
    });
  }

  private async trail(
    encounter: CodingEncounter,
    requester: ProposalRequester,
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

  /** EN-121. Absent and out of reach are one answer. */
  private async encounterFor(
    encounterId: string,
    sites: 'all' | readonly string[],
  ): Promise<CodingEncounter> {
    const encounter = await this.context.encounter(encounterId, sites);
    if (!encounter) throw new AssistantEncounterNotFoundError();
    return encounter;
  }

  /** AS-111 (AS-039, M-02). Its own professional, where they write, while live. */
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
}

function writer(requester: ProposalRequester): SuggestionRequester {
  return { userId: requester.userId, sites: requester.writeSites };
}

function proposalOf(suggestion: SuggestionView): OrderProposal {
  return suggestion.proposal as unknown as OrderProposal;
}

function candidateOf(exam: OrderableExam): ExamCandidate {
  return {
    serviceId: exam.serviceId,
    code: exam.code,
    name: exam.name,
    category: exam.category,
  };
}

/** AS-109. The exam an accepted proposal was chosen as, when it was. */
function acceptedCodeOf(suggestion: SuggestionView): string[] {
  return suggestion.acceptedCode ? [suggestion.acceptedCode] : [];
}

/** AS-107 (AS-020). The note's row, or the stretch of the conversation. */
function sourceOf(
  origin: ExamOrigin,
  noteId: string | undefined,
): SuggestionSource {
  if (origin.kind === 'transcript') {
    return { kind: 'transcript', fromMs: origin.fromMs, toMs: origin.toMs };
  }
  return { kind: 'chart', table: 'clinical_note', id: noteId! };
}
