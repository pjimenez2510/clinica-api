import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

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
import { LiveEventBus } from '../../../shared/events/live-event-bus';
import {
  AssistantDraftFailedError,
  AssistantDraftInterruptedError,
  AssistantEncounterClosedError,
  AssistantEncounterNotFoundError,
  AssistantNoteNotOpenError,
  AssistantNotEncounterOwnerError,
  AssistantProposalNotKeptError,
  AssistantTranscriptEmptyError,
  SuggestionNotFoundError,
} from '../domain/assistant.errors';
import { buildLexicon, type Lexicon } from '../domain/lexicon';
import {
  type DraftPhrase,
  draftDue,
  type NoteDraftStatus,
  shownSections,
  type StoredDraftSection,
  type TranscriptLine,
} from '../domain/note-draft';
import type { SuggestionStatus, SuggestionView } from '../domain/suggestion';

import { ASSISTANT_DEMO } from './diagnosis-proposal.service';
import { LISTENING_STORE, type ListeningStore } from './listening.store';
import { LLM_CLIENT, type LlmClient } from './llm-client.port';
import {
  NOTE_DRAFT_STORE,
  type NoteDraftStore,
  type StoredNoteDraft,
} from './note-draft.store';
import { draftableSections, writeNoteDraft } from './note-writer';
import { PSEUDONYMIZER, type Pseudonymizer } from './pseudonymizer.port';
import {
  type SuggestionRequester,
  SuggestionService,
} from './suggestion.service';
import type { TranscriptObserver } from './transcript-observer.port';

export const NOTE_DRAFT_CLOCK = Symbol('NOTE_DRAFT_CLOCK');

/** AS-093. The draft's own deadline: a physician is waiting for it. */
export const DRAFT_LIMIT_MS = 60_000;
/** AS-086. Drafts written at once in this installation (SigmAI R-02: one). */
export const DRAFTS_AT_ONCE = 4;
/** AS-092. The vocabulary is read again after an hour. */
const VOCABULARY_TTL_MS = 3_600_000;

/** The audit trail's names (EN-122): the transcript sent, the draft read. */
const EXPORT_RESOURCE = 'assistant_note_draft_reading';
const READ_RESOURCE = 'assistant_note_draft';

export interface DraftRequester {
  userId: string;
  /** Where the requester may write the history (`record:write`) and use the assistant. */
  writeSites: 'all' | readonly string[];
  ip?: string;
  userAgent?: string;
}

/** A section of the draft as the screen shows it (AS-096). */
export interface DraftSectionView {
  id: string;
  section: string;
  title: string;
  text: string;
  phrases: DraftPhrase[];
  status: SuggestionStatus;
  /** AS-029, AS-099. Written by the demonstration's script, not by a model. */
  demo: boolean;
}

export interface DraftOverview {
  /** The newest draft asked for, whatever its state; null when none was. */
  draft: {
    id: string;
    status: NoteDraftStatus;
    upToMs: number;
    failureCode: string | null;
    requestedAt: Date;
    finishedAt: Date | null;
  } | null; // prettier-ignore
  /** How far the sections shown go, in the listening's clock. */
  coveredUpToMs: number;
  /** How far the transcript goes. */
  transcriptUpToMs: number;
  sections: DraftSectionView[];
  demo: boolean;
}

/** What `ai_suggestion.proposal` holds for a section of the draft. */
interface SectionProposal {
  draftId: string;
  section: string;
  title: string;
  text: string;
  phrases: DraftPhrase[];
  demo: boolean;
}

/**
 * AS-086 to AS-097. The draft of the consultation note (C2): asked for by the
 * physician or by the listening, written apart — at most four at once, one
 * per attention —, kept as one proposal per section, and accepted or
 * discarded section by section.
 *
 * Nothing is written into the note here (P1): accepting only links the
 * proposal to the note the screen saved, with `If-Match`, through the note's
 * own route. Nothing signs.
 *
 * The drafts are written in this process (D-249 §6); `note_draft` keeps the
 * state, so a restart leaves what was in flight failed with its reason.
 */
@Injectable()
export class NoteDraftService implements TranscriptObserver, OnModuleInit {
  private readonly logger = new Logger(NoteDraftService.name);
  private readonly waiting: StoredNoteDraft[] = [];
  private running = 0;
  private readonly inProgress = new Set<Promise<void>>();
  /** AS-087. Asked for while another was in flight: asked again after it. */
  private readonly again = new Map<string, string>();
  private lexicon: { value: Lexicon | null; readAt: number } | null = null;

  constructor(
    @Inject(CODING_CONTEXT_READER) private readonly context: CodingContextReader, // prettier-ignore
    @Inject(NOTE_DRAFT_CONTEXT_READER) private readonly notes: NoteDraftContextReader, // prettier-ignore
    @Inject(LISTENING_STORE) private readonly transcripts: ListeningStore,
    @Inject(NOTE_DRAFT_STORE) private readonly drafts: NoteDraftStore,
    @Inject(PSEUDONYMIZER) private readonly pseudonymizer: Pseudonymizer,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    private readonly suggestions: SuggestionService,
    @Inject(ACCESS_AUDIT_RECORDER) private readonly audit: AccessAuditRecorder,
    private readonly events: LiveEventBus,
    @Inject(NOTE_DRAFT_CLOCK) private readonly clock: () => Date,
    @Inject(ASSISTANT_DEMO) private readonly demo: boolean,
  ) {}

  /** AS-093. What a previous process left in flight did not finish. */
  async onModuleInit(): Promise<void> {
    try {
      const failed = await this.drafts.failInFlight(
        new AssistantDraftInterruptedError().code,
        this.clock(),
      );
      if (failed > 0) {
        this.logger.warn({ count: failed }, 'drafts interrupted by a restart');
      }
    } catch (error) {
      this.logger.warn({ error_code: codeOf(error) }, 'interrupted drafts could not be marked'); // prettier-ignore
    }
  }

  /** AS-086. «Pedir borrador» and «Volver a pedir». */
  async request(
    encounterId: string,
    requester: DraftRequester,
  ): Promise<DraftOverview> {
    const encounter = await this.ownLiveEncounter(encounterId, requester);
    await this.ask(encounter, requester.userId);
    return this.overview(encounter.id, requester);
  }

  /** AS-096. What the Nota tab shows. A read of the history. */
  async overview(
    encounterId: string,
    requester: DraftRequester,
  ): Promise<DraftOverview> {
    const encounter = await this.ownEncounter(encounterId, requester);
    const overview = await this.overviewOf(encounter, requester);
    await this.trail(encounter, requester, 'READ', READ_RESOURCE);
    return overview;
  }

  /** AS-094. Links a section to the note the screen saved it into. */
  async accept(
    input: { encounterId: string; suggestionId: string; noteId: string },
    requester: DraftRequester,
  ): Promise<DraftOverview> {
    const encounter = await this.ownLiveEncounter(input.encounterId, requester);
    const note = await this.notes.consultationDraft(encounter.id);
    if (!note || note.id !== input.noteId)
      throw new AssistantNoteNotOpenError();
    await this.sectionOf(encounter.id, input.suggestionId, requester);
    // AS-022. The store reads the section from the note itself, in the
    // transaction that decides: what the caller says is not the saved value.
    await this.suggestions.accept(
      { suggestionId: input.suggestionId, recordId: note.id },
      writer(requester),
    );
    return this.overview(encounter.id, requester);
  }

  /** AS-094, AS-038. The physician does not want this section. */
  async discard(
    input: { encounterId: string; suggestionId: string },
    requester: DraftRequester,
  ): Promise<DraftOverview> {
    const encounter = await this.ownLiveEncounter(input.encounterId, requester);
    await this.sectionOf(encounter.id, input.suggestionId, requester);
    await this.suggestions.discard(input.suggestionId, writer(requester));
    return this.overview(encounter.id, requester);
  }

  /** AS-087. Three more minutes of conversation since the last draft asked for. */
  transcriptGrew(encounterId: string, upToMs: number): void {
    this.quietly(encounterId, async () => {
      const last = await this.drafts.latest(encounterId);
      if (!draftDue(upToMs, last?.upToMs ?? null)) return;
      await this.askForOwner(encounterId);
    });
  }

  /** AS-087. The physician stopped listening: what was said last is drafted. */
  listeningStopped(encounterId: string): void {
    this.quietly(encounterId, () => this.askForOwner(encounterId));
  }

  /** Every draft this process is writing or has queued, settled. For tests and shutdown. */
  async settled(): Promise<void> {
    while (this.inProgress.size > 0 || this.waiting.length > 0) {
      await Promise.allSettled([...this.inProgress]);
    }
  }

  /**
   * AS-086. The draft of the stretch transcribed so far: the one it already
   * has, the failed one put back in the queue, or a new one — unless another
   * stretch is in flight, which this one waits behind.
   */
  private async ask(
    encounter: CodingEncounter,
    userId: string,
  ): Promise<StoredNoteDraft> {
    if (!(await this.notes.consultationDraft(encounter.id))) {
      throw new AssistantNoteNotOpenError();
    }
    const lines = await this.transcripts.transcript(encounter.id);
    if (lines.length === 0) throw new AssistantTranscriptEmptyError();
    const upToMs = Math.max(...lines.map((line) => line.endMs));

    const existing = await this.drafts.ofStretch(encounter.id, upToMs);
    if (existing?.status === 'FAILED') {
      const again = await this.drafts.requeue(
        existing.id,
        userId,
        this.clock(),
      );
      if (again) return this.enqueue(again);
    } else if (existing) {
      return existing;
    }
    const inFlight = await this.drafts.inFlight(encounter.id);
    if (inFlight) {
      this.again.set(encounter.id, userId);
      return inFlight;
    }
    const queued = await this.drafts.queue({
      encounterId: encounter.id,
      upToMs,
      requestedBy: userId,
      at: this.clock(),
    });
    if (queued) return this.enqueue(queued);
    // Another request got there first: answer that one.
    const taken =
      (await this.drafts.ofStretch(encounter.id, upToMs)) ??
      (await this.drafts.inFlight(encounter.id));
    if (!taken) throw new AssistantDraftFailedError();
    return taken;
  }

  /** AS-087. In the name of the attention's professional, only while it is live with its note open. */
  private async askForOwner(encounterId: string): Promise<void> {
    const encounter = await this.context.encounter(encounterId, 'all');
    if (!encounter || !acceptsNewContent(encounter.status)) return;
    if (!(await this.notes.consultationDraft(encounterId))) return;
    try {
      await this.ask(encounter, encounter.practitionerUserId);
    } catch (error) {
      if (error instanceof AssistantTranscriptEmptyError) return;
      throw error;
    }
  }

  private enqueue(draft: StoredNoteDraft): StoredNoteDraft {
    this.waiting.push(draft);
    this.drain();
    return draft;
  }

  private drain(): void {
    while (this.running < DRAFTS_AT_ONCE && this.waiting.length > 0) {
      const draft = this.waiting.shift()!;
      this.running += 1;
      const done: Promise<void> = this.write(draft).finally(() => {
        this.running -= 1;
        this.inProgress.delete(done);
        this.drain();
      });
      this.inProgress.add(done);
    }
  }

  /**
   * AS-088 to AS-093, AS-095, AS-097. Writes one draft. Any failure leaves it
   * failed with its code and keeps nothing; the proposals of earlier drafts
   * are not touched.
   */
  private async write(draft: StoredNoteDraft): Promise<void> {
    if (!(await this.drafts.start(draft.id, this.clock()))) return;
    let siteId: string | null = null;
    try {
      const encounter = await this.context.encounter(draft.encounterId, 'all');
      if (!encounter) throw new AssistantEncounterNotFoundError();
      siteId = encounter.siteId;
      if (!acceptsNewContent(encounter.status)) {
        throw new AssistantEncounterClosedError();
      }
      const note = await this.notes.consultationDraft(encounter.id);
      if (!note) throw new AssistantNoteNotOpenError();
      const lines = (await this.transcripts.transcript(encounter.id)).filter(
        (line: TranscriptLine) => line.endMs <= draft.upToMs,
      );
      if (lines.length === 0) throw new AssistantTranscriptEmptyError();
      const people = await this.context.people(encounter.id);
      // EN-122. The transcript leaves for a provider: who asked is in the
      // trail first.
      await this.audit.record({
        userId: draft.requestedBy,
        resourceType: EXPORT_RESOURCE,
        resourceId: encounter.id,
        action: 'EXPORT',
      });

      const written = await writeNoteDraft(
        {
          pseudonymizer: this.pseudonymizer,
          llm: this.llm,
          lexicon: await this.vocabulary(),
        },
        {
          subject: encounter.patientId,
          names: people.patient,
          staff: people.staff,
          lines,
          template: draftableSections(note.sections),
          encounterId: encounter.id,
          signal: AbortSignal.timeout(DRAFT_LIMIT_MS),
        },
      );
      if (written.runId === null) throw new AssistantProposalNotKeptError();
      const runId = written.runId;

      if (written.sections.length > 0) {
        // The store locks the attention: one closed meanwhile keeps nothing.
        await this.suggestions.propose(
          written.sections.map((section) => {
            const proposal: SectionProposal = {
              draftId: draft.id,
              section: section.section,
              title: section.title,
              text: section.text,
              phrases: section.phrases,
              demo: this.demo,
            };
            return {
              encounterId: encounter.id,
              aiRunId: runId,
              kind: 'note-section' as const,
              proposal: { ...proposal },
              sources: section.sources,
            };
          }),
          { userId: draft.requestedBy, sites: 'all' },
        );
      }
      await this.drafts.succeed(draft.id, runId, this.clock());
      // AS-095. Counts only: no phrase, no section text reaches the log.
      this.logger.log(
        {
          encounter_id: encounter.id,
          assistant_draft_sections: written.sections.length,
          assistant_draft_unsaid: written.sections.reduce((sum, section) => sum + section.phrases.filter((phrase) => phrase.unsaid).length, 0), // prettier-ignore
          assistant_draft_corrected: written.corrected,
          duration_ms: this.clock().getTime() - draft.requestedAt.getTime(),
        },
        'assistant note draft written',
      );
    } catch (error) {
      await this.drafts
        .fail(draft.id, codeOf(error), this.clock())
        .catch(() => undefined);
      this.logger.warn(
        { encounter_id: draft.encounterId, error_code: codeOf(error) },
        'assistant note draft failed',
      );
    } finally {
      if (siteId !== null) {
        // AS-097. The fact of a change, to whoever asked; never its content.
        this.events.publish({
          kind: 'assistant-draft',
          siteId,
          userIds: [draft.requestedBy],
        });
      }
      const waiting = this.again.get(draft.encounterId);
      if (waiting !== undefined) {
        this.again.delete(draft.encounterId);
        this.quietly(draft.encounterId, () => this.askForOwner(draft.encounterId)); // prettier-ignore
      }
    }
  }

  private async overviewOf(
    encounter: CodingEncounter,
    requester: DraftRequester,
  ): Promise<DraftOverview> {
    const [latest, done, lines, stored] = await Promise.all([
      this.drafts.latest(encounter.id),
      this.drafts.latestDone(encounter.id),
      this.transcripts.transcript(encounter.id),
      this.suggestions.ofEncounter(encounter.id, writer(requester), 'note-section'), // prettier-ignore
    ]);
    const views = new Map(stored.map((each) => [each.id, each]));
    const shown = shownSections(stored.map(asStoredSection), done?.id ?? null);
    return {
      draft: latest && {
        id: latest.id,
        status: latest.status,
        upToMs: latest.upToMs,
        failureCode: latest.failureCode,
        requestedAt: latest.requestedAt,
        finishedAt: latest.finishedAt,
      },
      coveredUpToMs: done?.upToMs ?? 0,
      transcriptUpToMs: lines.reduce((most, line) => Math.max(most, line.endMs), 0), // prettier-ignore
      sections: shown.map((each) => sectionView(views.get(each.id)!)),
      demo: this.demo,
    };
  }

  /** AS-092. The vocabulary, read once an hour; without it nothing is corrected. */
  private async vocabulary(): Promise<Lexicon | null> {
    const now = this.clock().getTime();
    if (this.lexicon && now - this.lexicon.readAt < VOCABULARY_TTL_MS) {
      return this.lexicon.value;
    }
    try {
      const { principles, protectedWords } = await this.notes.vocabulary();
      this.lexicon = {
        value: buildLexicon({ targets: principles, protectedWords }),
        readAt: now,
      };
    } catch (error) {
      this.logger.warn({ error_code: codeOf(error) }, 'the lexicon could not be read'); // prettier-ignore
      this.lexicon = { value: null, readAt: now };
    }
    return this.lexicon.value;
  }

  private async trail(
    encounter: CodingEncounter,
    requester: DraftRequester,
    action: 'READ',
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

  /** AS-096, AS-039. Its own professional, where they write. EN-121: absent and out of reach are one answer. */
  private async ownEncounter(
    encounterId: string,
    requester: DraftRequester,
  ): Promise<CodingEncounter> {
    const encounter = await this.context.encounter(encounterId, requester.writeSites); // prettier-ignore
    if (!encounter) throw new AssistantEncounterNotFoundError();
    if (encounter.practitionerUserId !== requester.userId) {
      throw new AssistantNotEncounterOwnerError();
    }
    return encounter;
  }

  /** AS-086, AS-094. And the attention still takes new clinical content. */
  private async ownLiveEncounter(
    encounterId: string,
    requester: DraftRequester,
  ): Promise<CodingEncounter> {
    const encounter = await this.ownEncounter(encounterId, requester);
    if (!acceptsNewContent(encounter.status)) {
      throw new AssistantEncounterClosedError();
    }
    return encounter;
  }

  /** The proposal, only when it is a section of this attention's draft. */
  private async sectionOf(
    encounterId: string,
    suggestionId: string,
    requester: DraftRequester,
  ): Promise<SuggestionView> {
    const stored = await this.suggestions.ofEncounter(encounterId, writer(requester), 'note-section'); // prettier-ignore
    const found = stored.find((each) => each.id === suggestionId);
    if (!found) throw new SuggestionNotFoundError();
    return found;
  }

  /** AS-087. What the listening asked for runs apart, and its failure stays in the log. */
  private quietly(encounterId: string, work: () => Promise<void>): void {
    work().catch((error: unknown) => {
      this.logger.warn(
        { encounter_id: encounterId, error_code: codeOf(error) },
        'the listening could not ask for a draft',
      );
    });
  }
}

function writer(requester: DraftRequester): SuggestionRequester {
  return { userId: requester.userId, sites: requester.writeSites };
}

/** AS-093, AS-095. A failure is its code; anything else is the generic one. */
function codeOf(error: unknown): string {
  return error instanceof DomainError
    ? error.code
    : new AssistantDraftFailedError().code;
}

function asStoredSection(view: SuggestionView): StoredDraftSection {
  const proposal = view.proposal as Partial<SectionProposal>;
  return {
    id: view.id,
    draftId: String(proposal.draftId ?? ''),
    section: String(proposal.section ?? ''),
    text: String(proposal.text ?? ''),
    status: view.status,
    proposedAt: view.proposedAt,
  };
}

function sectionView(view: SuggestionView): DraftSectionView {
  const proposal = view.proposal as unknown as SectionProposal;
  return {
    id: view.id,
    section: proposal.section,
    title: proposal.title,
    text: proposal.text,
    phrases: proposal.phrases,
    status: view.status,
    demo: proposal.demo,
  };
}
