import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  CODING_CONTEXT_READER,
  acceptsNewContent,
  type CodingContextReader,
} from '../../../shared/clinical/coding-context.port';
import {
  AssistantEncounterClosedError,
  AssistantEncounterNotFoundError,
  DictationNotHeardError,
  DictationUnavailableError,
} from '../domain/assistant.errors';
import {
  readDictatedVitals,
  type DictatedVitals,
} from '../domain/dictated-vitals';

import {
  DICTATION_TRANSCRIBER,
  type DictationHeard,
  type DictationTranscriber,
} from './dictation-transcriber.port';

/** AS-196. Two minutes of speech: the longest dictation the screen records (SigmAI). */
export const MAX_DICTATION_SECONDS = 120;

/**
 * AS-186. Dictations this API sends to the recogniser at once. `clinica-ai`
 * queues every recognition behind one, the consultation's listening
 * included: more than this and a busy morning would starve the listening.
 */
export const MAX_DICTATIONS_IN_FLIGHT = 2;

/** AS-185. Where the requester may take vitals AND dictate them. */
export interface DictationRequester {
  sites: 'all' | readonly string[];
}

/** AS-180. What one dictation gives back: a proposal, and what it was read from. */
export interface VitalsDictation extends DictatedVitals {
  heard: string;
}

/**
 * AS-180 to AS-186, AS-196. The vital signs said aloud, read into a proposal
 * for the taking's form.
 *
 * Nothing here writes: the taking is still written by «Guardar», through the
 * route of the taking, with its author (EN-143). Nothing is read from the
 * record either beyond the attention's site and state, so a dictation is not
 * trailed as a read; the recording and the text live for the length of the
 * call (AS-184).
 */
@Injectable()
export class VitalsDictationService {
  private readonly logger = new Logger(VitalsDictationService.name);
  private inFlight = 0;

  constructor(
    @Inject(CODING_CONTEXT_READER)
    private readonly context: CodingContextReader,
    @Inject(DICTATION_TRANSCRIBER)
    private readonly transcriber: DictationTranscriber,
  ) {}

  /** AS-196. What the screen needs before it records: the longest dictation. */
  async limits(
    encounterId: string,
    requester: DictationRequester,
  ): Promise<{ maxSeconds: number }> {
    await this.liveEncounter(encounterId, requester);
    return { maxSeconds: MAX_DICTATION_SECONDS };
  }

  /** AS-180. Transcribes the recording and reads it; stores nothing. */
  async dictate(
    encounterId: string,
    recording: Buffer,
    requester: DictationRequester,
    /** Aborted when the screen gave up: the recogniser is freed at once. */
    signal?: AbortSignal,
  ): Promise<VitalsDictation> {
    await this.liveEncounter(encounterId, requester);
    if (this.inFlight >= MAX_DICTATIONS_IN_FLIGHT) {
      throw new DictationUnavailableError('busy');
    }
    this.inFlight += 1;
    let heard: DictationHeard;
    try {
      heard = await this.transcriber.transcribe(recording, signal);
    } finally {
      this.inFlight -= 1;
    }
    const text = heard.text.trim();
    if (text === '') {
      // AS-184. How long it was, never what was in it.
      this.logger.warn(
        {
          encounter_id: encounterId,
          duration_ms: Math.round(heard.seconds * 1000),
          result: 'silent',
        },
        'a dictation was recognised as nothing',
      );
      throw new DictationNotHeardError({
        kind: 'silent',
        seconds: heard.seconds,
      });
    }
    return { heard: text, ...readDictatedVitals(text) };
  }

  /**
   * AS-185. The attention, at a site of the requester's, still taking new
   * content. Whose attention it is does not matter: nursing takes the vitals.
   */
  private async liveEncounter(
    encounterId: string,
    requester: DictationRequester,
  ): Promise<void> {
    const encounter = await this.context.encounter(
      encounterId,
      requester.sites,
    );
    if (!encounter) throw new AssistantEncounterNotFoundError();
    if (!acceptsNewContent(encounter.status)) {
      throw new AssistantEncounterClosedError();
    }
  }
}
