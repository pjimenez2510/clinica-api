import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import type { AccessAuditRecorder } from '../../../shared/audit/access-audit.port';
import type {
  CodingContextReader,
  CodingEncounter,
} from '../../../shared/clinical/coding-context.port';
import type {
  DraftNote,
  NoteDraftContextReader,
} from '../../../shared/clinical/note-draft-context.port';
import { pruneToAllowlist } from '../../../shared/observability/log-privacy';
import {
  AssistantEncounterClosedError,
  AssistantEncounterNotFoundError,
  AssistantNoteNotOpenError,
  AssistantNotEncounterOwnerError,
  AssistantReadingInProgressError,
  AssistantTranscriptEmptyError,
  LlmCallFailed,
  SuggestionNotFoundError,
} from '../domain/assistant.errors';
import type { TranscriptLine } from '../domain/note-draft';
import {
  decisionOf,
  type SuggestionVerdict,
  type SuggestionView,
} from '../domain/suggestion';

import type { ListeningStore } from './listening.store';
import type {
  LlmAnswer,
  LlmClient,
  LlmRequest,
  PseudonymizedText,
} from './llm-client.port';
import type {
  NoteQuestionCheck,
  NoteQuestionCheckStore,
} from './note-question-check.store';
import {
  type QuestionRequester,
  NoteQuestionService,
} from './note-question.service';
import type { Pseudonymizer } from './pseudonymizer.port';
import type { SuggestionService } from './suggestion.service';
import type { NewSuggestion } from './suggestion.store';

/**
 * AS-119, AS-121 to AS-125. The questions «Para completar la nota» with every
 * port faked: who may ask, what is sent, what is kept, when nothing is asked
 * again, what fails and what the log is told.
 */
const DOCTOR = 'user-doctor';
const OTHER = 'user-other';
const ENCOUNTER = 'enc-1';
const SITE = 'site-1';

const SAID: TranscriptLine[] = [
  { startMs: 0, endMs: 6_000, text: 'Me duele la garganta y tengo fiebre, dice Rosa Quishpe.' }, // prettier-ignore
  { startMs: 6_000, endMs: 11_000, text: 'Tomé paracetamol.' },
];
const ANSWER = {
  questions: [
    { text: '¿Hasta qué temperatura llegó la fiebre?', source: 'L1', section: 'enfermedadActual' }, // prettier-ignore
    { text: '¿Toma otro medicamento?', source: 'L2', section: 'enfermedadActual' }, // prettier-ignore
    { text: '¿Fuma?', source: 'L9', section: null },
  ],
};

class World {
  encounter: CodingEncounter = {
    id: ENCOUNTER,
    patientId: 'patient-1',
    siteId: SITE,
    practitionerUserId: DOCTOR,
    status: 'OPEN',
    clinicalDate: 'dia-de-la-atencion',
  };
  note: DraftNote | null = {
    id: 'note-1',
    written: { motivoConsulta: 'Dolor de garganta.' },
    sections: [
      { key: 'motivoConsulta', title: 'Motivo de consulta', help: '', kind: 'TEXT' }, // prettier-ignore
      { key: 'enfermedadActual', title: 'Enfermedad o problema actual', help: '', kind: 'TEXT' }, // prettier-ignore
    ],
  };
  lines: TranscriptLine[] = [...SAID];
  checks: NoteQuestionCheck[] = [];
  suggestions: SuggestionView[] = [];
  audits: { action: string; resourceType: string; userId: string | null }[] =
    [];
  prompts: string[] = [];
  signals: (AbortSignal | undefined)[] = [];
  answer: unknown = ANSWER;
  llmFails: Error | null = null;
  gate: Promise<void> | null = null;
  clock = 1_000;

  context: CodingContextReader = {
    encounter: (id, sites) =>
      Promise.resolve(
        id === this.encounter.id && (sites === 'all' || sites.includes(SITE))
          ? this.encounter
          : null,
      ),
    people: () => Promise.resolve({ patient: ['Rosa', 'Quishpe'], staff: ['Ana', 'Ruiz'] }), // prettier-ignore
    consultationNote: () => Promise.reject(new Error('not used')),
    recordedCodes: () => Promise.reject(new Error('not used')),
    diagnosisOf: () => Promise.reject(new Error('not used')),
    patientHistory: () => Promise.reject(new Error('not used')),
    clinicFrequency: () => Promise.reject(new Error('not used')),
  };

  notes: NoteDraftContextReader = {
    consultationDraft: () => Promise.resolve(this.note),
    vocabulary: () => Promise.resolve({ principles: ['Paracetamol'], protectedWords: [] }), // prettier-ignore
  };

  transcripts = {
    transcript: () => Promise.resolve(this.lines),
  } as unknown as ListeningStore;

  store: NoteQuestionCheckStore = {
    // As the database: the review and its questions together, or neither.
    record: (check, questions) => {
      if (!this.note) return Promise.reject(new AssistantNoteNotOpenError());
      this.checks.push(check);
      return this.suggestionService
        .propose(questions, { userId: DOCTOR, sites: [SITE] })
        .then(() => undefined);
    },
    latest: (encounterId) =>
      Promise.resolve(this.checks.filter((each) => each.encounterId === encounterId).at(-1) ?? null), // prettier-ignore
  };

  pseudonymizer: Pseudonymizer = {
    pseudonymize: (input) =>
      Promise.resolve({
        cleared: input.text.split('Rosa Quishpe').join('[PERSONA_1]') as PseudonymizedText, // prettier-ignore
        replacements: [{ placeholder: '[PERSONA_1]', original: 'Rosa Quishpe', kind: 'name' }], // prettier-ignore
        dateShiftDays: 0,
      }),
  };

  llm: LlmClient = {
    generate: async <Shape extends z.ZodType>(
      request: LlmRequest<Shape>,
    ): Promise<LlmAnswer<z.infer<Shape>>> => {
      this.prompts.push(request.prompt);
      this.signals.push(request.signal);
      if (this.gate) await this.gate;
      if (this.llmFails) throw this.llmFails;
      return {
        value: request.answer.parse(this.answer),
        provider: 'gemini',
        model: 'gemini-3.8-flash',
        requestId: 'request',
        runId: `run-${this.prompts.length}`,
      };
    },
  };

  suggestionService = {
    propose: (suggestions: NewSuggestion[]) => {
      const views = suggestions.map((each, index): SuggestionView => ({
        id: `q-${this.suggestions.length + index + 1}`,
        encounterId: each.encounterId,
        aiRunId: each.aiRunId,
        kind: each.kind,
        proposal: each.proposal,
        sources: each.sources,
        status: 'PROPOSED',
        distance: null,
        record: null,
        proposedAt: new Date(this.clock),
        decidedBy: null,
        decidedAt: null,
      }));
      this.suggestions.push(...views);
      return Promise.resolve(views);
    },
    ofEncounter: () => Promise.resolve(this.suggestions),
    discard: (suggestionId: string) =>
      this.decide(suggestionId, { outcome: 'discard' }),
  } as unknown as SuggestionService;

  private decide(id: string, verdict: SuggestionVerdict) {
    const index = this.suggestions.findIndex((s) => s.id === id);
    const decision = decisionOf(this.suggestions[index]!, verdict);
    this.suggestions[index] = { ...this.suggestions[index]!, ...decision, decidedBy: DOCTOR, decidedAt: new Date(this.clock) }; // prettier-ignore
    return Promise.resolve(this.suggestions[index]);
  }

  audit: AccessAuditRecorder = {
    record: (entry) => {
      this.audits.push(entry);
      return Promise.resolve();
    },
  };

  service(demo = false) {
    return new NoteQuestionService(
      this.context,
      this.notes,
      this.transcripts,
      this.store,
      this.pseudonymizer,
      this.llm,
      this.suggestionService,
      this.audit,
      () => new Date(this.clock),
      demo,
    );
  }
}

const doctor: QuestionRequester = { userId: DOCTOR, writeSites: [SITE] };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NoteQuestionService — asking (AS-119, AS-121)', () => {
  it('AS-119 AS-121 asks the model and keeps the review and each backed question with its stretch, never its line', async () => {
    const world = new World();

    const checked = await world.service().check(ENCOUNTER, doctor);

    expect(checked.questions.map((each) => [each.text, each.quote])).toEqual([
      ['¿Hasta qué temperatura llegó la fiebre?', 'Me duele la garganta y tengo fiebre, dice Rosa Quishpe.'], // prettier-ignore
      ['¿Toma otro medicamento?', 'Tomé paracetamol.'],
    ]);
    expect(checked).toMatchObject({ checkedAt: new Date(1_000), transcriptUpToMs: 11_000, demo: false }); // prettier-ignore
    expect(world.checks).toEqual([
      expect.objectContaining({ encounterId: ENCOUNTER, aiRunId: 'run-1', upToMs: 11_000, asked: 2, dropped: 1, requestedBy: DOCTOR }), // prettier-ignore
    ]);
    expect(world.checks[0]!.noteDigest).toMatch(/^[0-9a-f]{64}$/);
    const kept = world.suggestions[0]!;
    expect(kept.kind).toBe('note-question');
    expect(kept.sources).toEqual([{ kind: 'transcript', fromMs: 0, toMs: 6_000 }]); // prettier-ignore
    expect(JSON.stringify(world.suggestions)).not.toContain('Me duele la garganta'); // prettier-ignore
    expect(world.prompts[0]).toContain('- motivoConsulta · Motivo de consulta: Dolor de garganta.'); // prettier-ignore
    expect(world.signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('AS-119 refuses without transcript, without a note open, and while another review of the attention is in flight', async () => {
    const world = new World();
    world.lines = [];
    await expect(world.service().check(ENCOUNTER, doctor)).rejects.toBeInstanceOf(AssistantTranscriptEmptyError); // prettier-ignore

    world.lines = [...SAID];
    world.note = null;
    await expect(world.service().check(ENCOUNTER, doctor)).rejects.toBeInstanceOf(AssistantNoteNotOpenError); // prettier-ignore

    world.note = new World().note;
    let release!: () => void;
    world.gate = new Promise((resolve) => (release = resolve));
    const service = world.service();
    const first = service.check(ENCOUNTER, doctor);
    await vi.waitFor(() => expect(world.prompts).toHaveLength(1));
    await expect(service.check(ENCOUNTER, doctor)).rejects.toBeInstanceOf(AssistantReadingInProgressError); // prettier-ignore
    release();
    await first;
    // Positive control: once it finished, the next one is asked.
    world.lines.push({ startMs: 11_000, endMs: 14_000, text: 'Y me duele el oído.' }); // prettier-ignore
    await service.check(ENCOUNTER, doctor);
    expect(world.prompts).toHaveLength(2);
    expect(world.audits.filter((each) => each.action === 'EXPORT')).toHaveLength(2); // prettier-ignore
  });

  it('AS-039 refuses another professional, an attention out of reach and a closed one, without calling the model', async () => {
    const world = new World();
    await expect(world.service().check(ENCOUNTER, { userId: OTHER, writeSites: [SITE] })).rejects.toBeInstanceOf(AssistantNotEncounterOwnerError); // prettier-ignore
    await expect(world.service().check(ENCOUNTER, { userId: DOCTOR, writeSites: ['site-2'] })).rejects.toBeInstanceOf(AssistantEncounterNotFoundError); // prettier-ignore
    world.encounter = { ...world.encounter, status: 'DISCONTINUED' };
    await expect(world.service().check(ENCOUNTER, doctor)).rejects.toBeInstanceOf(AssistantEncounterClosedError); // prettier-ignore
    expect(world.prompts).toHaveLength(0);
  });
});

describe('NoteQuestionService — the review on screen (AS-122, AS-123, AS-125)', () => {
  it('AS-123 the same transcript with the same note answers the last review without calling anyone', async () => {
    const world = new World();
    const service = world.service();
    await service.check(ENCOUNTER, doctor);

    const again = await service.check(ENCOUNTER, doctor);

    expect(world.prompts).toHaveLength(1);
    expect(world.checks).toHaveLength(1);
    expect(again.questions).toHaveLength(2);
    // Positive control: a word more in the note is asked again.
    world.note!.written = { ...world.note!.written, enfermedadActual: 'Fiebre de 38,5 °C.' }; // prettier-ignore
    await service.check(ENCOUNTER, doctor);
    expect(world.prompts).toHaveLength(2);
  });

  it('AS-122 AS-123 a later review replaces the earlier one, and one that leaves none empties the list', async () => {
    const world = new World();
    const service = world.service();
    await service.check(ENCOUNTER, doctor);
    world.note!.written = { ...world.note!.written, enfermedadActual: 'Fiebre de 38,5 °C.' }; // prettier-ignore
    world.answer = { questions: [] };

    const later = await service.check(ENCOUNTER, doctor);

    expect(later.questions).toEqual([]);
    expect(world.checks.at(-1)).toMatchObject({ asked: 0, aiRunId: 'run-2' });
    expect((await service.overview(ENCOUNTER, doctor)).questions).toEqual([]);
  });

  it('AS-122 shows nothing to another professional and leaves a READ for each read', async () => {
    const world = new World();
    const service = world.service();
    await service.check(ENCOUNTER, doctor);

    await expect(service.overview(ENCOUNTER, { userId: OTHER, writeSites: [SITE] })).rejects.toBeInstanceOf(AssistantNotEncounterOwnerError); // prettier-ignore
    const read = await service.overview(ENCOUNTER, doctor);

    expect(read.questions).toHaveLength(2);
    expect(world.audits.filter((each) => each.action === 'READ')).toHaveLength(2); // prettier-ignore
  });

  it('AS-125 a discarded question leaves the screen and does not come back in the next review', async () => {
    const world = new World();
    const service = world.service();
    const first = await service.check(ENCOUNTER, doctor);

    const after = await service.discard({ encounterId: ENCOUNTER, suggestionId: first.questions[0]!.id }, doctor); // prettier-ignore
    expect(after.questions.map((each) => each.text)).toEqual(['¿Toma otro medicamento?']); // prettier-ignore

    world.note!.written = { ...world.note!.written, planTratamiento: 'Control.' }; // prettier-ignore
    world.answer = { questions: [{ text: '¿HASTA qué temperatura llegó la fiebre', source: 'L1', section: null }] }; // prettier-ignore
    world.note!.written.enfermedadActual = 'Algo más.';
    const next = await service.check(ENCOUNTER, doctor);
    expect(next.questions).toEqual([]);
  });

  it('AS-125 a question discarded while the next review is on its way does not come back with it', async () => {
    const world = new World();
    const service = world.service();
    const first = await service.check(ENCOUNTER, doctor);
    world.note!.written = { ...world.note!.written, enfermedadActual: 'Fiebre.' }; // prettier-ignore
    let release!: () => void;
    world.gate = new Promise((resolve) => (release = resolve));

    const second = service.check(ENCOUNTER, doctor);
    await vi.waitFor(() => expect(world.prompts).toHaveLength(2));
    await service.discard({ encounterId: ENCOUNTER, suggestionId: first.questions[0]!.id }, doctor); // prettier-ignore
    release();
    const after = await second;

    expect(after.questions.map((each) => each.text)).toEqual(['¿Toma otro medicamento?']); // prettier-ignore
  });

  it('AS-124 an attention closed while the model answered keeps nothing', async () => {
    const world = new World();
    let release!: () => void;
    world.gate = new Promise((resolve) => (release = resolve));
    const service = world.service();

    const checking = service.check(ENCOUNTER, doctor);
    await vi.waitFor(() => expect(world.prompts).toHaveLength(1));
    world.encounter = { ...world.encounter, status: 'DISCONTINUED' };
    release();

    await expect(checking).rejects.toBeInstanceOf(
      AssistantEncounterClosedError,
    );
    expect(world.checks).toEqual([]);
    expect(world.suggestions).toEqual([]);
  });

  it('AS-124 a note signed while the model answered, the attention on hold, keeps nothing, and the same review unsigned keeps it (positive control)', async () => {
    const unsigned = new World();
    let releaseUnsigned!: () => void;
    unsigned.gate = new Promise((resolve) => (releaseUnsigned = resolve));
    const kept = unsigned.service().check(ENCOUNTER, doctor);
    await vi.waitFor(() => expect(unsigned.prompts).toHaveLength(1));
    releaseUnsigned();
    await kept;
    expect(unsigned.checks).toHaveLength(1);

    const world = new World();
    let release!: () => void;
    world.gate = new Promise((resolve) => (release = resolve));
    const checking = world.service().check(ENCOUNTER, doctor);
    await vi.waitFor(() => expect(world.prompts).toHaveLength(1));
    // Signed with the attention on hold (signing it otherwise discharges it,
    // which answers ASSISTANT_ENCOUNTER_CLOSED): no 002 in draft any more.
    world.encounter = { ...world.encounter, status: 'ON_HOLD' };
    world.note = null;
    release();

    await expect(checking).rejects.toBeInstanceOf(AssistantNoteNotOpenError);
    expect(world.checks).toEqual([]);
    expect(world.suggestions).toEqual([]);
  });

  it('AS-125 refuses discarding a question that is not on screen', async () => {
    const world = new World();
    const service = world.service();
    await service.check(ENCOUNTER, doctor);

    await expect(service.discard({ encounterId: ENCOUNTER, suggestionId: 'q-99' }, doctor)).rejects.toBeInstanceOf(SuggestionNotFoundError); // prettier-ignore
  });
});

describe('NoteQuestionService — failures and privacy (AS-124)', () => {
  it('AS-124 a provider that fails answers its error and keeps nothing, the earlier review untouched', async () => {
    const world = new World();
    const service = world.service();
    await service.check(ENCOUNTER, doctor);
    world.note!.written = { ...world.note!.written, enfermedadActual: 'Fiebre.' }; // prettier-ignore
    world.llmFails = new LlmCallFailed('gemini', 'provider-error', { model: 'gemini-3.8-flash', raw: null, status: 503 }); // prettier-ignore

    await expect(service.check(ENCOUNTER, doctor)).rejects.toBeInstanceOf(LlmCallFailed); // prettier-ignore

    expect(world.checks).toHaveLength(1);
    expect((await service.overview(ENCOUNTER, doctor)).questions).toHaveLength(2); // prettier-ignore
  });

  it('AS-124 the log carries counts, never the transcript, the note or a question', async () => {
    const world = new World();
    const logged: unknown[] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((...args) => void logged.push(args)); // prettier-ignore
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((...args) => void logged.push(args)); // prettier-ignore

    await world.service().check(ENCOUNTER, doctor);

    const text = JSON.stringify(logged.map((each) => pruneToAllowlist(each)));
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of ['garganta', 'Rosa', 'temperatura', 'paracetamol', 'Dolor']) {
      expect(text).not.toContain(secret);
    } // prettier-ignore
    expect(JSON.stringify(logged)).toContain('assistant_questions');
  });

  it('AS-127 says each question is of the demonstration when it is', async () => {
    const world = new World();

    const checked = await world.service(true).check(ENCOUNTER, doctor);

    expect(checked.demo).toBe(true);
    expect(checked.questions.every((each) => each.demo)).toBe(true);
  });
});
