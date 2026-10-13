import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  CODING_CONTEXT_READER,
  acceptsNewContent,
  type CodingContextReader,
  type CodingEncounter,
} from '../../../shared/clinical/coding-context.port';
import {
  RECORDING_AUTHORIZATION,
  type RecordingAuthorization,
} from '../../../shared/clinical/recording-authorization.port';
import { DomainError } from '../../../shared/domain/errors/domain-error';
import {
  AssistantEncounterClosedError,
  AssistantEncounterNotFoundError,
  AssistantRecordingNotAuthorizedError,
  AssistantTranscriptEmptyError,
} from '../domain/assistant.errors';
import type { TranscriptLine } from '../domain/note-draft';
import {
  readPreparationByRules,
  sentencesOf,
  type PreparationProposal,
  type Speaker,
} from '../domain/preparation-reading';

import { ASSISTANT_DEMO } from './diagnosis-proposal.service';
import { LLM_CLIENT, type LlmClient } from './llm-client.port';
import {
  PREPARATION_LISTENING_STORE,
  type ListeningStore,
} from './listening.store';
import { PSEUDONYMIZER, type Pseudonymizer } from './pseudonymizer.port';
import { readPreparation } from './read-preparation';

/** AS-251. How long the person preparing waits for the assistant before the rules read. */
export const PREPARATION_READING_LIMIT_MS = 20_000;

/**
 * AS-251. Whether the assistant may read at all: the demonstration, or the
 * remote switch on (`ASSISTANT_ALLOW_REMOTE`) AND the preparation's own
 * (`ASSISTANT_PREPARATION_REMOTE`, off until measured, P7). Off, nothing is
 * pseudonymized, sent or trailed as sent.
 */
export const PREPARATION_ASSISTANT = Symbol('PREPARATION_ASSISTANT');

/**
 * Revisión (seguridad): the same preparation read again with nothing new said
 * is answered from memory, not paid again, for this long.
 */
const KEPT_READING_MS = 10 * 60_000;
const KEPT_READINGS = 100;

/** The audit trail's name (EN-122): the preparation left for a provider. */
const EXPORT_RESOURCE = 'assistant_preparation_reading';

/** AS-245. Who asks: where they take and dictate the vitals, with the assistant on. */
export interface PreparationRequester {
  userId: string;
  sites: 'all' | readonly string[];
  ip?: string;
  userAgent?: string;
}

/** AS-245. What the screen receives: the proposal, the lines it was read from, and by whom. */
export interface PreparationReading extends Omit<
  PreparationProposal,
  'speakers'
> {
  reader: 'assistant' | 'rules';
  demo: boolean;
  lines: (TranscriptLine & { speaker: Speaker | null })[];
  upToMs: number;
}

/**
 * AS-245 to AS-252 (B3). The preparation listened to, read into a proposal for
 * the taking's form. Nothing here writes into the taking (P1), and nothing of
 * the reading is kept (AS-252): the transcript stays where the listening put
 * it, the proposal goes back to the screen.
 */
@Injectable()
export class PreparationReadingService {
  private readonly logger = new Logger(PreparationReadingService.name);
  /** By attention: the last reading by the assistant, the stretch it read, and when. */
  private readonly kept = new Map<string, { upToMs: number; at: number; proposal: PreparationProposal }>(); // prettier-ignore

  constructor(
    @Inject(CODING_CONTEXT_READER) private readonly context: CodingContextReader, // prettier-ignore
    @Inject(PREPARATION_LISTENING_STORE) private readonly transcripts: ListeningStore, // prettier-ignore
    @Inject(PSEUDONYMIZER) private readonly pseudonymizer: Pseudonymizer,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    @Inject(ACCESS_AUDIT_RECORDER) private readonly audit: AccessAuditRecorder,
    @Inject(RECORDING_AUTHORIZATION)
    private readonly recording: RecordingAuthorization,
    @Inject(ASSISTANT_DEMO) private readonly demo: boolean,
    @Inject(PREPARATION_ASSISTANT) private readonly assistant: boolean,
  ) {}

  async read(
    encounterId: string,
    requester: PreparationRequester,
  ): Promise<PreparationReading> {
    const encounter = await this.liveEncounter(encounterId, requester);
    // AS-245 (AS-169). The conversation leaves for a provider only with it.
    if (!(await this.recording.isAuthorized(encounter.patientId))) {
      throw new AssistantRecordingNotAuthorizedError();
    }
    const lines = (await this.transcripts.transcript(encounter.id)).filter(
      (line) => line.text.trim() !== '',
    );
    if (lines.length === 0) throw new AssistantTranscriptEmptyError();

    // AS-250. Read by sentence: a line of the recogniser holds more than one turn.
    const sentences = sentencesOf(lines);
    const upToMs = lines.reduce((most, line) => Math.max(most, line.endMs), 0);
    const proposal = this.assistant
      ? (this.keptFor(encounter.id, upToMs) ??
        (await this.byAssistant(encounter, lines, requester)))
      : null;
    if (proposal) this.keep(encounter.id, upToMs, proposal);
    const read = proposal ?? readPreparationByRules(sentences);
    // AS-252. Counts and the reader: never a line, a phrase or a value.
    this.logger.log(
      {
        encounter_id: encounter.id,
        assistant_reader: proposal ? 'assistant' : 'rules',
        assistant_values: Object.keys(read.values).length,
        assistant_unclear: read.unclear.length,
        assistant_lines: sentences.length,
      },
      'assistant preparation read',
    );
    const { speakers, ...rest } = read;
    return {
      ...rest,
      reader: proposal ? 'assistant' : 'rules',
      demo: proposal !== null && this.demo,
      lines: sentences.map((line, at) => ({ ...line, speaker: speakers[at] ?? null })), // prettier-ignore
      upToMs,
    };
  }

  /** AS-245, AS-251. The assistant's reading, or null: then the rules read. */
  private async byAssistant(
    encounter: CodingEncounter,
    lines: readonly TranscriptLine[],
    requester: PreparationRequester,
  ): Promise<PreparationProposal | null> {
    // AS-251. The deadline of the person waiting, cleared as soon as it is read.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException('plazo', 'TimeoutError')), PREPARATION_READING_LIMIT_MS); // prettier-ignore
    try {
      const people = await this.context.people(encounter.id);
      // EN-122. The conversation leaves for a provider: who asked, first.
      await this.audit.record({
        userId: requester.userId,
        resourceType: EXPORT_RESOURCE,
        resourceId: encounter.id,
        action: 'EXPORT',
        ip: requester.ip,
        userAgent: requester.userAgent,
      });
      const { proposal } = await readPreparation(
        { pseudonymizer: this.pseudonymizer, llm: this.llm },
        {
          subject: encounter.patientId,
          names: people.patient,
          staff: people.staff,
          lines,
          encounterId: encounter.id,
          signal: deadline.signal,
        },
      );
      return proposal;
    } catch (error) {
      // AS-251, AS-252. Read without it, and say why by its code alone.
      this.logger.warn(
        {
          encounter_id: encounter.id,
          error_code: error instanceof DomainError ? error.code : 'UNEXPECTED',
        },
        'assistant preparation read by the rules',
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private keptFor(
    encounterId: string,
    upToMs: number,
  ): PreparationProposal | null {
    // prettier-ignore
    const kept = this.kept.get(encounterId);
    if (!kept || kept.upToMs !== upToMs) return null;
    return Date.now() - kept.at <= KEPT_READING_MS ? kept.proposal : null;
  }

  private keep(
    encounterId: string,
    upToMs: number,
    proposal: PreparationProposal,
  ): void {
    // prettier-ignore
    this.kept.delete(encounterId);
    this.kept.set(encounterId, { upToMs, at: Date.now(), proposal });
    // The oldest go first: a map, kept in the order of insertion.
    while (this.kept.size > KEPT_READINGS) {
      this.kept.delete(this.kept.keys().next().value!);
    }
  }

  /** AS-245. At a site of the requester's, still taking content; whose it is does not matter. */
  private async liveEncounter(
    encounterId: string,
    requester: PreparationRequester,
  ): Promise<CodingEncounter> {
    const encounter = await this.context.encounter(encounterId, requester.sites); // prettier-ignore
    if (!encounter) throw new AssistantEncounterNotFoundError();
    if (!acceptsNewContent(encounter.status)) {
      throw new AssistantEncounterClosedError();
    }
    return encounter;
  }
}
