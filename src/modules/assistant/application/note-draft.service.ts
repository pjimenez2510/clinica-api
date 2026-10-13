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
import {
  ASSISTANT_SITE_SWITCH,
  type AssistantSiteSwitch,
} from '../../../shared/clinical/assistant-site-switch.port';
import {
  RECORDING_AUTHORIZATION,
  type RecordingAuthorization,
} from '../../../shared/clinical/recording-authorization.port';
import { DomainError } from '../../../shared/domain/errors/domain-error';
import { LiveEventBus } from '../../../shared/events/live-event-bus';
import {
  AssistantDraftCancelledError,
  AssistantDraftFailedError,
  AssistantDraftInterruptedError,
  AssistantDraftRetryLimitError,
  AssistantEncounterClosedError,
  AssistantEncounterNotFoundError,
  AssistantNoteNotOpenError,
  AssistantNotEncounterOwnerError,
  AssistantProposalNotKeptError,
  AssistantTranscriptEmptyError,
  SuggestionNotFoundError,
  AssistantRecordingNotAuthorizedError,
} from '../domain/assistant.errors';
import {
  asStoredSection,
  type DraftPhrase,
  draftDue,
  type NoteDraftStatus,
  shownSections,
  type TranscriptLine,
} from '../domain/note-draft';
import type { SuggestionStatus, SuggestionView } from '../domain/suggestion';

import { ASSISTANT_DEMO } from './diagnosis-proposal.service';
import { LexiconCache } from './lexicon-cache';
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
/** AS-086. Drafts written at once in this installation (SigmAI wrote one, for every attention: R-02). */
export const DRAFTS_AT_ONCE = 4;
/** AS-093. Times a stretch may be asked for: each one paid a call. */
export const DRAFT_MAX_ATTEMPTS = 3;

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
  /** The text accepted earlier for this section: «Actualizar» swaps it instead of adding twice. */
  acceptedBefore: string | null;
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
  /** AS-143, AS-147. The draft being written, and how to cut its call. */
  private readonly writing = new Map<string, { encounterId: string; stop: AbortController }>(); // prettier-ignore
  private readonly lexicon: LexiconCache;

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
    @Inject(ASSISTANT_SITE_SWITCH)
    private readonly siteSwitch: AssistantSiteSwitch,
    @Inject(RECORDING_AUTHORIZATION)
    private readonly recording: RecordingAuthorization,
  ) {
    this.lexicon = new LexiconCache(notes, clock, this.logger, codeOf);
  }

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
    // AS-169 (revisión clínica G1). The draft is written from the patient's
    // voice: without the authorization it does not leave for a provider.
    if (!(await this.recording.isAuthorized(encounter.patientId))) {
      throw new AssistantRecordingNotAuthorizedError();
    }
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
    await this.sectionOf(encounter, input.suggestionId, requester);
    // AS-022. The store reads the section from the note itself, in the
    // transaction that decides: what the caller says is not the saved value.
    await this.suggestions.accept(
      { suggestionId: input.suggestionId, recordId: note.id },
      writer(requester),
    );
    this.announce(encounter.siteId, requester.userId);
    return this.overview(encounter.id, requester);
  }

  /** AS-094, AS-038. The physician does not want this section. */
  async discard(
    input: { encounterId: string; suggestionId: string },
    requester: DraftRequester,
  ): Promise<DraftOverview> {
    const encounter = await this.ownLiveEncounter(input.encounterId, requester);
    await this.sectionOf(encounter, input.suggestionId, requester);
    await this.suggestions.discard(input.suggestionId, writer(requester));
    this.announce(encounter.siteId, requester.userId);
    return this.overview(encounter.id, requester);
  }

  /**
   * AS-147. «Dejar de esperar»: the draft queued or being written is
   * cancelled, as at the signature (AS-143); without one, nothing changes.
   */
  async stopWaiting(
    encounterId: string,
    requester: DraftRequester,
  ): Promise<DraftOverview> {
    const encounter = await this.ownLiveEncounter(encounterId, requester);
    if ((await this.cancel(encounter.id)) > 0) {
      // Who stopped it: `requested_by` still names who asked for it.
      await this.audit.record({
        userId: requester.userId,
        resourceType: READ_RESOURCE,
        resourceId: encounter.id,
        action: 'UPDATE',
        ip: requester.ip,
        userAgent: requester.userAgent,
      });
      this.announce(encounter.siteId, requester.userId);
    }
    return this.overview(encounter.id, requester);
  }

  /**
   * AS-143, AS-147. Cancels what the attention has queued or being written:
   * failed with `ASSISTANT_DRAFT_CANCELLED`, its call cut, nothing it returns
   * kept, and no later stretch asked for behind it. Answers how many.
   */
  async cancel(encounterId: string): Promise<number> {
    this.again.delete(encounterId);
    for (let index = this.waiting.length - 1; index >= 0; index -= 1) {
      if (this.waiting[index]!.encounterId === encounterId) this.waiting.splice(index, 1); // prettier-ignore
    }
    const cancelled = await this.drafts.cancelInFlight(
      encounterId,
      new AssistantDraftCancelledError().code,
      this.clock(),
    );
    for (const [, each] of this.writing) {
      if (each.encounterId === encounterId) each.stop.abort();
    }
    return cancelled.length;
  }

  /** AS-141. A draft of the attention is queued or being written. */
  async drafting(encounterId: string): Promise<boolean> {
    return (await this.drafts.inFlight(encounterId)) !== null;
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

  /** Every draft this process is writing, has queued or was asked to ask for, settled. For tests. */
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
    again = true,
  ): Promise<StoredNoteDraft> {
    const note = await this.notes.consultationDraft(encounter.id);
    // A template without prose sections has nothing a draft could write.
    if (!note || draftableSections(note.sections).length === 0) {
      throw new AssistantNoteNotOpenError();
    }
    const lines = await this.transcripts.transcript(encounter.id);
    if (lines.length === 0) throw new AssistantTranscriptEmptyError();
    const upToMs = Math.max(...lines.map((line) => line.endMs));

    const existing = await this.drafts.ofStretch(encounter.id, upToMs);
    if (existing?.status === 'FAILED') {
      if (existing.attempts >= DRAFT_MAX_ATTEMPTS) {
        throw new AssistantDraftRetryLimitError();
      }
      const requeued = await this.drafts.requeue(
        existing.id,
        userId,
        this.clock(),
        DRAFT_MAX_ATTEMPTS,
      );
      if (requeued) return this.enqueue(requeued, encounter.siteId);
      // Another stretch is in flight: this one waits behind it, below.
    } else if (existing) {
      return existing;
    }
    // The wish is written down BEFORE looking at what is in flight: a draft
    // that finishes in between still sees it and asks again (review I2).
    this.again.set(encounter.id, userId);
    const inFlight = await this.drafts.inFlight(encounter.id);
    if (inFlight) return inFlight;
    this.again.delete(encounter.id);
    const queued = await this.drafts.queue({
      encounterId: encounter.id,
      upToMs,
      requestedBy: userId,
      at: this.clock(),
    });
    if (queued) return this.enqueue(queued, encounter.siteId);
    // Another request got there first.
    const taken = await this.drafts.ofStretch(encounter.id, upToMs);
    if (taken) return taken;
    // Another stretch got the one place in flight: ask again behind it, or —
    // if it already finished — once more now.
    this.again.set(encounter.id, userId);
    const behind = await this.drafts.inFlight(encounter.id);
    if (behind) return behind;
    this.again.delete(encounter.id);
    if (again) return this.ask(encounter, userId, false);
    throw new AssistantDraftFailedError();
  }

  /** AS-161, AS-169. The site has the assistant on and the patient allows it. */
  private async transcriptUsable(encounter: CodingEncounter): Promise<boolean> {
    const enabled = await this.siteSwitch.enabledSites();
    return (
      enabled.includes(encounter.siteId) &&
      (await this.recording.isAuthorized(encounter.patientId))
    );
  }

  /** AS-087. In the name of the attention's professional, only while it is live with its note open. */
  private async askForOwner(encounterId: string): Promise<void> {
    const encounter = await this.context.encounter(encounterId, 'all');
    if (!encounter || !acceptsNewContent(encounter.status)) return;
    // AS-161, AS-169. The site switched off or the authorization revoked: the
    // tail the recogniser handed over asks for nothing, and what is queued
    // or being written stops (revisión clínica G1, M1).
    if (!(await this.transcriptUsable(encounter))) {
      await this.cancel(encounterId);
      return;
    }
    if (!(await this.notes.consultationDraft(encounterId))) return;
    // Only for the professional who listens: a listening started by someone
    // else, or an attention handed over since, asks for nothing (review).
    const listening = await this.transcripts.find(encounterId);
    if (listening?.startedBy !== encounter.practitionerUserId) return;
    try {
      await this.ask(encounter, encounter.practitionerUserId);
    } catch (error) {
      if (error instanceof AssistantTranscriptEmptyError) return;
      throw error;
    }
  }

  private enqueue(draft: StoredNoteDraft, siteId: string): StoredNoteDraft {
    this.waiting.push(draft);
    this.drain();
    // AS-102. The screen learns it is being written, and reads until it is.
    this.announce(siteId, draft.requestedBy);
    return draft;
  }

  /** AS-097. The fact of a change, to whoever it concerns; never its content. */
  private announce(siteId: string, userId: string): void {
    this.events.publish({ kind: 'assistant-draft', siteId, userIds: [userId] });
  }

  private drain(): void {
    while (this.running < DRAFTS_AT_ONCE && this.waiting.length > 0) {
      const draft = this.waiting.shift()!;
      this.running += 1;
      const done: Promise<void> = this.write(draft)
        // Nothing of a draft may bring the API down (review C1).
        .catch((error: unknown) =>
          this.logger.warn(
            { encounter_id: draft.encounterId, error_code: codeOf(error) },
            'assistant note draft could not be written',
          ),
        ) // prettier-ignore
        .finally(() => {
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
    let siteId: string | null = null;
    const stop = new AbortController();
    this.writing.set(draft.id, { encounterId: draft.encounterId, stop });
    try {
      if (!(await this.drafts.start(draft.id, this.clock()))) return;
      const encounter = await this.context.encounter(draft.encounterId, 'all');
      if (!encounter) throw new AssistantEncounterNotFoundError();
      siteId = encounter.siteId;
      if (!acceptsNewContent(encounter.status)) {
        throw new AssistantEncounterClosedError();
      }
      // AS-161, AS-169. Asked again when its turn comes: a draft queued
      // before the site was switched off, or the authorization revoked,
      // reaches no provider.
      if (!(await this.siteSwitch.enabledSites()).includes(encounter.siteId)) {
        throw new AssistantEncounterNotFoundError();
      }
      if (!(await this.recording.isAuthorized(encounter.patientId))) {
        throw new AssistantRecordingNotAuthorizedError();
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
          lexicon: await this.lexicon.get(),
        },
        {
          subject: encounter.patientId,
          names: people.patient,
          staff: people.staff,
          lines,
          template: draftableSections(note.sections),
          encounterId: encounter.id,
          signal: AbortSignal.any([AbortSignal.timeout(DRAFT_LIMIT_MS), stop.signal]), // prettier-ignore
        },
      );
      // AS-143, AS-147. Cancelled while the model answered: nothing is kept.
      if (stop.signal.aborted) throw new AssistantDraftCancelledError();
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
      if (!(await this.drafts.succeed(draft.id, runId, this.clock()))) {
        // It was failed meanwhile (a restart elsewhere): its proposals are
        // not shown, because only finished drafts are (AS-090).
        this.logger.warn({ encounter_id: encounter.id }, 'a draft finished after it was failed');
      } // prettier-ignore
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
      this.writing.delete(draft.id);
      if (siteId !== null) this.announce(siteId, draft.requestedBy);
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
    const [latest, done, doneIds, lines, stored] = await Promise.all([
      this.drafts.latest(encounter.id),
      this.drafts.latestDone(encounter.id),
      this.drafts.doneIds(encounter.id),
      this.transcripts.transcript(encounter.id),
      this.suggestions.ofEncounter(encounter.id, writer(requester), 'note-section'), // prettier-ignore
    ]);
    const views = new Map(stored.map((each) => [each.id, each]));
    const shown = shownSections(stored.map(asStoredSection), new Set(doneIds));
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
      sections: shown.map((each) => sectionView(views.get(each.section.id)!, each.acceptedBefore)), // prettier-ignore
      demo: this.demo,
    };
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

  /**
   * AS-096, AS-039. Its own professional, where they write. Absent and out of
   * reach are one answer (EN-121); another professional of the site is told
   * it is not theirs, as the listening and the CIE-10 do (AS-039, AS-045).
   */
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

  /**
   * The proposal, only when it is a section of this attention's draft that
   * the screen shows undecided: an older version, or one of a draft that did
   * not finish, is not accepted by its id (review M4).
   */
  private async sectionOf(
    encounter: CodingEncounter,
    suggestionId: string,
    requester: DraftRequester,
  ): Promise<SuggestionView> {
    const [stored, doneIds] = await Promise.all([
      this.suggestions.ofEncounter(encounter.id, writer(requester), 'note-section'), // prettier-ignore
      this.drafts.doneIds(encounter.id),
    ]);
    const shown = shownSections(stored.map(asStoredSection), new Set(doneIds));
    const found = shown.find(
      (each) => each.section.id === suggestionId && each.section.status === 'PROPOSED', // prettier-ignore
    );
    const view = found && stored.find((each) => each.id === suggestionId);
    if (!view) throw new SuggestionNotFoundError();
    return view;
  }

  /** AS-087. What the listening asked for runs apart, and its failure stays in the log. */
  private quietly(encounterId: string, work: () => Promise<void>): void {
    const done: Promise<void> = work()
      .catch((error: unknown) => {
        this.logger.warn(
          { encounter_id: encounterId, error_code: codeOf(error) },
          'the listening could not ask for a draft',
        );
      })
      .finally(() => this.inProgress.delete(done));
    this.inProgress.add(done);
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

function sectionView(
  view: SuggestionView,
  acceptedBefore: string | null,
): DraftSectionView {
  const proposal = view.proposal as unknown as SectionProposal;
  return {
    id: view.id,
    section: proposal.section,
    title: proposal.title,
    text: proposal.text,
    phrases: proposal.phrases,
    status: view.status,
    acceptedBefore,
    demo: proposal.demo,
  };
}
