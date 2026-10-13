import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccessAuditRecorder } from '../../../shared/audit/access-audit.port';
import type {
  CodingContextReader,
  CodingEncounter,
  CodingEncounterStatus,
} from '../../../shared/clinical/coding-context.port';
import type { RecordingAuthorization } from '../../../shared/clinical/recording-authorization.port';
import {
  AssistantEncounterClosedError,
  AssistantEncounterNotFoundError,
  AssistantRecordingNotAuthorizedError,
  AssistantTranscriptEmptyError,
  LlmCallFailed,
  PseudonymizerFailedError,
} from '../domain/assistant.errors';
import type { TranscriptLine } from '../domain/note-draft';

import type { LlmClient, PseudonymizedText } from './llm-client.port';
import type { ListeningStore } from './listening.store';
import { PreparationReadingService } from './preparation-reading.service';
import type { Pseudonymizer } from './pseudonymizer.port';

const ENCOUNTER_ID = '01900000-0000-7000-8000-000000000001';
const LINES: TranscriptLine[] = [
  { startMs: 0, endMs: 3_000, text: '¿Qué le trae por aquí, señora Rosa Quishpe?' }, // prettier-ignore
  { startMs: 3_000, endMs: 6_000, text: 'Me duele la espalda y el pecho.' },
  { startMs: 6_000, endMs: 9_000, text: 'Presión 120 sobre 80, pulso 72.' },
];

function encounter(status: CodingEncounterStatus = 'OPEN'): CodingEncounter {
  return {
    id: ENCOUNTER_ID,
    patientId: 'patient-1',
    siteId: 'site-1',
    practitionerUserId: 'a-doctor',
    status,
    clinicalDate: 'irrelevant',
  };
}

/** The model's answer for LINES, as a provider would give it. */
const ANSWER = {
  lines: [
    { line: 'L1', speaker: 'nursing' },
    { line: 'L2', speaker: 'patient' },
    { line: 'L3', speaker: 'nursing' },
  ],
  values: [
    { field: 'systolicBp', line: 'L3', quote: 'Presión 120 sobre 80', said: 120, unit: 'none' }, // prettier-ignore
    { field: 'diastolicBp', line: 'L3', quote: 'Presión 120 sobre 80', said: 80, unit: 'none' }, // prettier-ignore
    {
      field: 'heartRate',
      line: 'L3',
      quote: 'pulso 72',
      said: 72,
      unit: 'none',
    },
  ],
  heightPosition: null,
  complaint: { line: 'L2', quote: 'Me duele la espalda y el pecho' },
};

function scene(
  over: {
    found?: CodingEncounter | null;
    lines?: TranscriptLine[];
    authorized?: boolean;
    assistant?: boolean;
    llm?: () => Promise<unknown>;
    pseudonymizer?: () => Promise<unknown>;
  } = {},
) {
  const context = {
    encounter: vi.fn(() => Promise.resolve(over.found === undefined ? encounter() : over.found)), // prettier-ignore
    people: vi.fn(() => Promise.resolve({ patient: ['Rosa Quishpe'], staff: ['Carmen Salazar'] })), // prettier-ignore
  } as unknown as CodingContextReader;
  const store = { transcript: vi.fn(() => Promise.resolve(over.lines ?? LINES)) } as unknown as ListeningStore; // prettier-ignore
  const pseudonymizer = {
    pseudonymize: vi.fn(
      over.pseudonymizer ??
        ((input: { text: string }) =>
          Promise.resolve({
            cleared: input.text.replace('Rosa Quishpe', '[PERSONA_1]') as PseudonymizedText, // prettier-ignore
            replacements: [{ placeholder: '[PERSONA_1]', original: 'Rosa Quishpe', kind: 'PERSON' }], // prettier-ignore
            dateShiftDays: 0,
          })),
    ),
  } as unknown as Pseudonymizer;
  const llm = {
    generate: vi.fn(
      over.llm ?? (() => Promise.resolve({ value: ANSWER, provider: 'fake', model: 'm', requestId: 'r', runId: 'run-1' })), // prettier-ignore
    ),
  } as unknown as LlmClient;
  const audit = { record: vi.fn(() => Promise.resolve()) } as unknown as AccessAuditRecorder; // prettier-ignore
  const recording = {
    isAuthorized: vi.fn(() => Promise.resolve(over.authorized ?? true)),
    grant: vi.fn(),
  } as unknown as RecordingAuthorization;
  const service = new PreparationReadingService(
    context,
    store,
    pseudonymizer,
    llm,
    audit,
    recording,
    false,
    over.assistant ?? true,
  );
  return {
    service,
    pseudonymize: pseudonymizer.pseudonymize as ReturnType<typeof vi.fn>, // eslint-disable-line @typescript-eslint/unbound-method
    generate: llm.generate as ReturnType<typeof vi.fn>, // eslint-disable-line @typescript-eslint/unbound-method
    record: audit.record as ReturnType<typeof vi.fn>, // eslint-disable-line @typescript-eslint/unbound-method
  };
}

const REQUESTER = { userId: 'nurse', sites: ['site-1'] as const };

afterEach(() => vi.restoreAllMocks());

describe('AS-245 AS-251 AS-252 PreparationReadingService', () => {
  it('AS-245 reads the preparation’s transcript with the assistant: values with their phrase, speakers, the reason, and the export trailed', async () => {
    const { service, record, pseudonymize } = scene();

    const reading = await service.read(ENCOUNTER_ID, REQUESTER);

    expect(reading).toMatchObject({
      reader: 'assistant',
      demo: false,
      upToMs: 9_000,
      values: {
        systolicBp: {
          value: 120,
          startMs: 6_000,
          quote: 'Presión 120 sobre 80',
        },
        heartRate: { value: 72, startMs: 6_000, quote: 'pulso 72' },
      },
      unclear: [],
      complaint: { text: 'Me duele la espalda y el pecho.', startMs: 3_000 },
    });
    expect(reading.lines.map((line) => line.speaker)).toEqual(['nursing', 'patient', 'nursing']); // prettier-ignore
    expect(pseudonymize).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'patient-1', names: ['Rosa Quishpe'], staff: ['Carmen Salazar'] }), // prettier-ignore
      expect.anything(),
    );
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'EXPORT', resourceType: 'assistant_preparation_reading', resourceId: ENCOUNTER_ID })); // prettier-ignore
  });

  it('AS-245 refuses an attention out of reach, a closed one, one without the authorization, and an empty transcript — before reading', async () => {
    await expect(scene({ found: null }).service.read(ENCOUNTER_ID, REQUESTER)).rejects.toBeInstanceOf(AssistantEncounterNotFoundError); // prettier-ignore
    await expect(scene({ found: encounter('DISCHARGED') }).service.read(ENCOUNTER_ID, REQUESTER)).rejects.toBeInstanceOf(AssistantEncounterClosedError); // prettier-ignore
    const unauthorized = scene({ authorized: false });
    await expect(unauthorized.service.read(ENCOUNTER_ID, REQUESTER)).rejects.toBeInstanceOf(AssistantRecordingNotAuthorizedError); // prettier-ignore
    expect(unauthorized.generate).not.toHaveBeenCalled();
    const empty = scene({ lines: [{ startMs: 0, endMs: 1_000, text: '  ' }] });
    await expect(empty.service.read(ENCOUNTER_ID, REQUESTER)).rejects.toBeInstanceOf(AssistantTranscriptEmptyError); // prettier-ignore
  });

  it('AS-251 without the assistant reads with the rules, sends nothing and trails no export', async () => {
    const { service, pseudonymize, generate, record } = scene({
      assistant: false,
    });

    const reading = await service.read(ENCOUNTER_ID, REQUESTER);

    expect(reading).toMatchObject({
      reader: 'rules',
      values: { systolicBp: { value: 120 }, diastolicBp: { value: 80 }, heartRate: { value: 72 } }, // prettier-ignore
      complaint: null,
    });
    expect(reading.lines.map((line) => line.speaker)).toEqual([null, null, null]); // prettier-ignore
    expect(pseudonymize).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('AS-251 falls back to the rules when the pseudonymizer or the provider fail', async () => {
    const cleared = scene({ pseudonymizer: () => Promise.reject(new PseudonymizerFailedError('unavailable')) }); // prettier-ignore
    await expect(cleared.service.read(ENCOUNTER_ID, REQUESTER)).resolves.toMatchObject({ reader: 'rules' }); // prettier-ignore
    expect(cleared.generate).not.toHaveBeenCalled();

    const failed = scene({ llm: () => Promise.reject(new LlmCallFailed('gemini', 'provider-error', { model: 'm', raw: null })) }); // prettier-ignore
    await expect(failed.service.read(ENCOUNTER_ID, REQUESTER)).resolves.toMatchObject({ reader: 'rules', values: { heartRate: { value: 72 } } }); // prettier-ignore
  });

  it('AS-251 gives up on the assistant after 20 s and reads with the rules', async () => {
    vi.useFakeTimers();
    try {
      const { service } = scene({
        llm: (request?: unknown) =>
          new Promise((_, reject) => {
            const signal = (request as { signal: AbortSignal }).signal;
            signal.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          }),
      });
      const reading = service.read(ENCOUNTER_ID, REQUESTER);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(reading).resolves.toMatchObject({ reader: 'rules' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('AS-252 logs counts and codes, never the transcript, a phrase or a name', async () => {
    const logged: unknown[][] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((...args) => void logged.push(args)); // prettier-ignore
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((...args) => void logged.push(args)); // prettier-ignore

    await scene().service.read(ENCOUNTER_ID, REQUESTER);
    await scene({ llm: () => Promise.reject(new LlmCallFailed('gemini', 'provider-error', { model: 'm', raw: null })) }).service.read(ENCOUNTER_ID, REQUESTER); // prettier-ignore

    const text = JSON.stringify(logged);
    expect(logged.length).toBeGreaterThan(0);
    for (const said of ['espalda', 'Presión', 'Quishpe', '120']) {
      expect(text).not.toContain(said);
    }
  });
});

describe('PreparationReadingService, revisión', () => {
  it('AS-245 the same preparation read again with nothing new said costs nothing', async () => {
    const { service, generate } = scene();
    await service.read(ENCOUNTER_ID, REQUESTER);
    await expect(service.read(ENCOUNTER_ID, REQUESTER)).resolves.toMatchObject({ reader: 'assistant' }); // prettier-ignore
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('AS-281 AS-282 the reason worded as the nurse writes it', () => {
  it('AS-281 asks the model for the wording and for «150 y 8» as 158, and an answer without the wording still stands', async () => {
    const { service, generate } = scene();
    await service.read(ENCOUNTER_ID, REQUESTER);

    const request = generate.mock.calls[0]![0] as { system: string; answer: { safeParse: (value: unknown) => { success: boolean } } }; // prettier-ignore
    expect(request.system).toContain('"written"');
    expect(request.system).toContain('"150 y 8"');
    // Without it, the reading still stands: the reason is the phrase (AS-282).
    expect(request.answer.safeParse(ANSWER).success).toBe(true);
    expect(request.answer.safeParse({ ...ANSWER, complaint: { ...ANSWER.complaint, written: 7 } }).success).toBe(false); // prettier-ignore
    expect(request.answer.safeParse({ ...ANSWER, complaint: { ...ANSWER.complaint, written: 'Dolor de espalda y pecho' } }).success).toBe(true); // prettier-ignore
  });

  it('AS-282 proposes the wording with the names put back, and the whole sentence as its source', async () => {
    const lines = [{ startMs: 0, endMs: 5_000, text: 'Me duele la espalda al cargar a Rosa Quishpe.' }]; // prettier-ignore
    const answer = { lines: [{ line: 'L1', speaker: 'patient' }], values: [], heightPosition: null, complaint: { line: 'L1', quote: 'me duele la espalda', written: 'Dolor en la espalda al cargar a [PERSONA_1]' } }; // prettier-ignore
    const { service } = scene({
      lines,
      llm: () => Promise.resolve({ value: answer, provider: 'fake', model: 'm', requestId: 'r', runId: 'run-1' }), // prettier-ignore
    });

    const reading = await service.read(ENCOUNTER_ID, REQUESTER);

    expect(reading.complaint).toEqual({ text: 'Dolor en la espalda al cargar a Rosa Quishpe', quote: lines[0]!.text, startMs: 0 }); // prettier-ignore
  });
});
