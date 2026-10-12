import { createHash } from 'node:crypto';

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
  NOTE_DRAFT_CONTEXT_READER,
  type NoteDraftContextReader,
} from '../../../shared/clinical/note-draft-context.port';
import { DomainError } from '../../../shared/domain/errors/domain-error';
import {
  AssistantEncounterClosedError,
  AssistantEncounterNotFoundError,
  AssistantNoteNotOpenError,
  AssistantNotEncounterOwnerError,
  AssistantProposalNotKeptError,
  AssistantReadingInProgressError,
  AssistantTranscriptEmptyError,
  SuggestionNotFoundError,
} from '../domain/assistant.errors';
import type { TranscriptLine } from '../domain/note-draft';
import {
  currentQuestions,
  noteDigestInput,
  type QuestionView,
} from '../domain/note-questions';
import type { SuggestionView } from '../domain/suggestion';

import { ASSISTANT_DEMO } from './diagnosis-proposal.service';
import { LexiconCache } from './lexicon-cache';
import { LISTENING_STORE, type ListeningStore } from './listening.store';
import { LLM_CLIENT, type LlmClient } from './llm-client.port';
import { NOTE_DRAFT_CLOCK } from './note-draft.service';
import {
  NOTE_QUESTION_CHECK_STORE,
  type NoteQuestionCheckStore,
} from './note-question-check.store';
import { askNoteQuestions } from './note-questions';
import { draftableSections } from './note-writer';
import { PSEUDONYMIZER, type Pseudonymizer } from './pseudonymizer.port';
import {
  type SuggestionRequester,
  SuggestionService,
} from './suggestion.service';

/** AS-124. A review's own deadline: the physician is waiting for it. */
export const QUESTIONS_LIMIT_MS = 45_000;

/** The audit trail's names (EN-122): what was sent, what was read. */
const EXPORT_RESOURCE = 'assistant_note_questions_reading';
const READ_RESOURCE = 'assistant_note_questions';

export interface QuestionRequester {
  userId: string;
  /** Where the requester may write the history (`record:write`) and use the assistant. */
  writeSites: 'all' | readonly string[];
  ip?: string;
  userAgent?: string;
}

export interface QuestionsOverview {
  questions: QuestionView[];
  /** When the review on screen was made; null when there was none. */
  checkedAt: Date | null;
  /** How far the transcript goes, in the listening's clock. */
  transcriptUpToMs: number;
  demo: boolean;
}

/**
 * AS-119 to AS-125. The questions «Para completar la nota» (C3): asked for by
 * the physician, read now, kept as the latest review and its proposals, and
 * put away one by one. Nothing here writes into the note nor stands in the
 * way of signing it (P1, P8).
 *
 * Read like the exams (D3): one review in flight per attention, in memory,
 * because the physician waits for the answer — an installation is one API
 * (D-241 §8).
 */
@Injectable()
export class NoteQuestionService {
  private readonly logger = new Logger(NoteQuestionService.name);
  private readonly checking = new Set<string>();
  private readonly lexicon: LexiconCache;

  constructor(
    @Inject(CODING_CONTEXT_READER) private readonly context: CodingContextReader, // prettier-ignore
    @Inject(NOTE_DRAFT_CONTEXT_READER) private readonly notes: NoteDraftContextReader, // prettier-ignore
    @Inject(LISTENING_STORE) private readonly transcripts: ListeningStore,
    @Inject(NOTE_QUESTION_CHECK_STORE) private readonly checks: NoteQuestionCheckStore, // prettier-ignore
    @Inject(PSEUDONYMIZER) private readonly pseudonymizer: Pseudonymizer,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    private readonly suggestions: SuggestionService,
    @Inject(ACCESS_AUDIT_RECORDER) private readonly audit: AccessAuditRecorder,
    @Inject(NOTE_DRAFT_CLOCK) private readonly clock: () => Date,
    @Inject(ASSISTANT_DEMO) private readonly demo: boolean,
  ) {
    this.lexicon = new LexiconCache(notes, clock, this.logger, codeOf);
  }

  /** AS-122. What «Para completar la nota» shows. A read of the history. */
  async overview(
    encounterId: string,
    requester: QuestionRequester,
  ): Promise<QuestionsOverview> {
    const encounter = await this.ownEncounter(encounterId, requester);
    const overview = await this.overviewOf(encounter, requester);
    await this.trail(encounter, requester, 'READ', READ_RESOURCE);
    return overview;
  }

  /** AS-119, AS-123. «Sugerir preguntas», «Revisar de nuevo», and the screen on its own. */
  async check(
    encounterId: string,
    requester: QuestionRequester,
  ): Promise<QuestionsOverview> {
    const encounter = await this.ownLiveEncounter(encounterId, requester);
    if (this.checking.has(encounter.id)) {
      throw new AssistantReadingInProgressError();
    }
    this.checking.add(encounter.id);
    try {
      await this.review(encounter, requester);
    } finally {
      this.checking.delete(encounter.id);
    }
    return this.overview(encounter.id, requester);
  }

  /** AS-125, AS-038. «No hace falta»: a question on screen, put away. */
  async discard(
    input: { encounterId: string; suggestionId: string },
    requester: QuestionRequester,
  ): Promise<QuestionsOverview> {
    const encounter = await this.ownLiveEncounter(input.encounterId, requester);
    const { shown } = await this.shownOf(encounter, requester);
    if (!shown.some((each) => each.id === input.suggestionId)) {
      throw new SuggestionNotFoundError();
    }
    await this.suggestions.discard(input.suggestionId, writer(requester));
    return this.overview(encounter.id, requester);
  }

  private async review(
    encounter: CodingEncounter,
    requester: QuestionRequester,
  ): Promise<void> {
    const note = await this.notes.consultationDraft(encounter.id);
    if (!note) throw new AssistantNoteNotOpenError();
    const lines = (await this.transcripts.transcript(encounter.id)).filter(
      (line: TranscriptLine) => line.text.trim() !== '',
    );
    if (lines.length === 0) throw new AssistantTranscriptEmptyError();
    const upToMs = lines.reduce((most, line) => Math.max(most, line.endMs), 0);
    const template = draftableSections(note.sections);
    const noteDigest = createHash('sha256')
      .update(
        noteDigestInput(
          template.map((section) => ({
            key: section.key,
            text: note.written[section.key] ?? '',
          })),
        ),
      ) // prettier-ignore
      .digest('hex');

    // AS-123. Nothing new to read: the last review stands, and costs nothing.
    const last = await this.checks.latest(encounter.id);
    if (last && last.upToMs === upToMs && last.noteDigest === noteDigest) {
      return;
    }

    const [people, stored] = await Promise.all([
      this.context.people(encounter.id),
      this.suggestions.ofEncounter(encounter.id, writer(requester), 'note-question'), // prettier-ignore
    ]);
    // EN-122. The conversation and the note leave for a provider: who asked, first.
    await this.trail(encounter, requester, 'EXPORT', EXPORT_RESOURCE);

    const asked = await askNoteQuestions(
      {
        pseudonymizer: this.pseudonymizer,
        llm: this.llm,
        lexicon: await this.lexicon.get(),
      },
      {
        subject: encounter.patientId,
        names: people.patient,
        staff: people.staff,
        lines,
        template: note.sections,
        written: note.written,
        discarded: stored
          .filter((each) => each.status === 'DISCARDED')
          .flatMap(({ proposal }) =>
            typeof proposal.text === 'string' ? [proposal.text] : [],
          ),
        encounterId: encounter.id,
        signal: AbortSignal.timeout(QUESTIONS_LIMIT_MS),
      },
    );
    if (asked.runId === null) throw new AssistantProposalNotKeptError();
    const runId = asked.runId;

    // Up to 45 s went by: nothing is kept on an attention closed since.
    await this.ownLiveEncounter(encounter.id, requester);
    if (asked.kept.length > 0) {
      await this.suggestions.propose(
        asked.kept.map((question) => ({
          encounterId: encounter.id,
          aiRunId: runId,
          kind: 'note-question' as const,
          proposal: { ...question, demo: this.demo },
          sources: [{ kind: 'transcript' as const, fromMs: question.fromMs, toMs: question.toMs }], // prettier-ignore
        })),
        writer(requester),
      );
    }
    await this.checks.record({
      encounterId: encounter.id,
      aiRunId: runId,
      upToMs,
      noteDigest,
      asked: asked.kept.length,
      dropped: asked.dropped,
      requestedBy: requester.userId,
      checkedAt: this.clock(),
    });
    // AS-124. Counts only: no question, no line, no word of the note.
    this.logger.log(
      {
        encounter_id: encounter.id,
        assistant_questions: asked.kept.length,
        assistant_questions_without_line: asked.dropped,
      },
      'assistant note questions read',
    );
  }

  private async overviewOf(
    encounter: CodingEncounter,
    requester: QuestionRequester,
  ): Promise<QuestionsOverview> {
    const { shown, latest, transcriptUpToMs } = await this.shownOf(encounter, requester); // prettier-ignore
    return {
      questions: shown,
      checkedAt: latest?.checkedAt ?? null,
      transcriptUpToMs,
      demo: this.demo,
    };
  }

  /** AS-122. The questions of the latest review, less the discarded, with their lines read again. */
  private async shownOf(
    encounter: CodingEncounter,
    requester: QuestionRequester,
  ) {
    const [latest, stored, lines] = await Promise.all([
      this.checks.latest(encounter.id),
      this.suggestions.ofEncounter(encounter.id, writer(requester), 'note-question'), // prettier-ignore
      this.transcripts.transcript(encounter.id),
    ]);
    return {
      latest,
      shown: currentQuestions(latest?.aiRunId ?? null, stored.map(asStored), lines), // prettier-ignore
      transcriptUpToMs: lines.reduce((most, line) => Math.max(most, line.endMs), 0), // prettier-ignore
    };
  }

  private async trail(
    encounter: CodingEncounter,
    requester: QuestionRequester,
    action: 'READ' | 'EXPORT',
    resourceType: string,
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType,
      resourceId: encounter.id,
      action,
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }

  /**
   * AS-122, AS-039. Its own professional, where they write. Absent and out of
   * reach are one answer (EN-121).
   */
  private async ownEncounter(
    encounterId: string,
    requester: QuestionRequester,
  ): Promise<CodingEncounter> {
    const encounter = await this.context.encounter(encounterId, requester.writeSites); // prettier-ignore
    if (!encounter) throw new AssistantEncounterNotFoundError();
    if (encounter.practitionerUserId !== requester.userId) {
      throw new AssistantNotEncounterOwnerError();
    }
    return encounter;
  }

  /** AS-119, AS-125. And the attention still takes new clinical content. */
  private async ownLiveEncounter(
    encounterId: string,
    requester: QuestionRequester,
  ): Promise<CodingEncounter> {
    const encounter = await this.ownEncounter(encounterId, requester);
    if (!acceptsNewContent(encounter.status)) {
      throw new AssistantEncounterClosedError();
    }
    return encounter;
  }
}

function writer(requester: QuestionRequester): SuggestionRequester {
  return { userId: requester.userId, sites: requester.writeSites };
}

function asStored(view: SuggestionView) {
  return {
    id: view.id,
    aiRunId: view.aiRunId,
    status: view.status,
    proposedAt: view.proposedAt,
    proposal: view.proposal,
  };
}

/** AS-124. A failure is its code. */
function codeOf(error: unknown): string {
  return error instanceof DomainError ? error.code : 'UNEXPECTED';
}
