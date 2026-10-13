import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import type { AccessAuditRecorder } from '../../../shared/audit/access-audit.port';
import type {
  ChartBackgroundReader,
  ChartRecord,
} from '../../../shared/clinical/chart-background.port';
import type {
  CodingContextReader,
  CodingEncounter,
} from '../../../shared/clinical/coding-context.port';
import {
  AssistantEncounterClosedError,
  AssistantNotEncounterOwnerError,
  PseudonymizerFailedError,
  SuggestionChartMismatchError,
  SuggestionNotFoundError,
} from '../domain/assistant.errors';
import type { TranscriptLine } from '../domain/note-draft';
import type { SuggestionView } from '../domain/suggestion';

import { CHART_PURPOSE } from './chart-background.prompts';
import { ChartProposalService } from './chart-proposal.service';
import type { ListeningStore } from './listening.store';
import type {
  LlmAnswer,
  LlmClient,
  LlmRequest,
  PseudonymizedText,
} from './llm-client.port';
import type { Pseudonymizer } from './pseudonymizer.port';
import type { NewSuggestion } from './suggestion.store';
import type { SuggestionService } from './suggestion.service';

const DOCTOR = 'user-doctor';
const ENCOUNTER: CodingEncounter = {
  id: 'enc-1',
  patientId: 'pat-1',
  siteId: 'site-1',
  practitionerUserId: DOCTOR,
  status: 'OPEN',
  clinicalDate: '2026-10-13', // fecha-fija: dato del doble, no se compara con el reloj
};
const LINES: TranscriptLine[] = [
  { startMs: 0, endMs: 4_000, text: '¿Es alérgica a algún medicamento?' },
  { startMs: 4_500, endMs: 7_000, text: 'No, que yo sepa, a ninguno.' },
  { startMs: 11_500, endMs: 14_000, text: 'Yo no. Mi mamá es hipertensa.' },
];
const ANSWER = {
  noKnownAllergies: { source: 'L2' },
  allergies: [],
  history: [{ kind: 'FAMILY', description: 'Hipertensión arterial', relative: 'Madre', source: 'L3' }], // prettier-ignore
};

/** Replaces the names it is given, as the real one does. */
const pseudonymizer: Pseudonymizer = {
  pseudonymize: (input) =>
    Promise.resolve({
      cleared: input.text.split('Lucía').join('[PERSONA_1]') as PseudonymizedText, // prettier-ignore
      replacements: [{ placeholder: '[PERSONA_1]', original: 'Lucía', kind: 'name' }], // prettier-ignore
      dateShiftDays: 0,
    }),
};

function model(value: unknown = ANSWER, runId: string | null = 'run-1') {
  const sent: LlmRequest<z.ZodType>[] = [];
  const client: LlmClient = {
    generate<Shape extends z.ZodType>(request: LlmRequest<Shape>) {
      sent.push(request);
      return Promise.resolve({ value, provider: 'fake', model: 'fake', requestId: 'r', runId } as LlmAnswer<z.infer<Shape>>); // prettier-ignore
    },
  };
  return { client, sent };
}

function store() {
  const stored: SuggestionView[] = [];
  const proposed: NewSuggestion[] = [];
  let clock = 1_000;
  const service = {
    propose: vi.fn((news: readonly NewSuggestion[]) => {
      proposed.push(...news);
      for (const each of news) {
        stored.push({
          id: `sug-${stored.length + 1}`,
          encounterId: each.encounterId,
          aiRunId: each.aiRunId,
          kind: each.kind,
          proposal: each.proposal,
          sources: each.sources,
          status: 'PROPOSED',
          distance: null,
          record: null,
          proposedAt: new Date((clock += 1)),
          decidedBy: null,
          decidedAt: null,
        });
      }
      return Promise.resolve(stored);
    }),
    accept: vi.fn(({ suggestionId }: { suggestionId: string }) => {
      const found = stored.find((each) => each.id === suggestionId)!;
      found.status = 'ACCEPTED';
      return Promise.resolve(found);
    }),
    discard: vi.fn((suggestionId: string) => {
      const found = stored.find((each) => each.id === suggestionId)!;
      found.status = 'DISCARDED';
      return Promise.resolve(found);
    }),
    ofEncounter: vi.fn(() => Promise.resolve([...stored])),
  };
  return { service: service as unknown as SuggestionService, raw: service, stored, proposed }; // prettier-ignore
}

function build(
  input: {
    llm?: LlmClient;
    records?: Record<string, ChartRecord>;
    allergies?: string[];
    encounter?: Partial<CodingEncounter>;
  } = {},
) {
  const suggestions = store();
  const context = {
    encounter: () => Promise.resolve({ ...ENCOUNTER, ...input.encounter }),
    people: () => Promise.resolve({ patient: ['Lucía'], staff: [] }),
  } as unknown as CodingContextReader;
  const chart: ChartBackgroundReader = {
    activeHistory: () => Promise.resolve([]),
    record: (_kind, id) => Promise.resolve(input.records?.[id] ?? null),
  };
  const transcripts = { transcript: () => Promise.resolve(LINES) } as unknown as ListeningStore; // prettier-ignore
  const audits: unknown[] = [];
  const audit: AccessAuditRecorder = { record: (entry) => { audits.push(entry); return Promise.resolve(); } }; // prettier-ignore
  const service = new ChartProposalService(
    context,
    chart,
    {
      activeForSurvivorOf: () =>
        Promise.resolve(
          (input.allergies ?? []).map((substanceText, at) => ({ id: `a-${at}`, patientId: 'pat-1', substanceConceptId: null, substanceText, reaction: null, criticality: 'UNABLE_TO_ASSESS' as const, recordedAt: new Date(0) })), // prettier-ignore
        ),
    },
    { standingAbsenceFor: () => Promise.resolve(null) },
    transcripts,
    pseudonymizer,
    input.llm ?? model().client,
    suggestions.service,
    audit,
    false,
  );
  return { service, suggestions, audits };
}

const doctor = { userId: DOCTOR, writeSites: 'all' as const };
const record = (overrides: Partial<ChartRecord> = {}): ChartRecord => ({
  patientId: 'pat-1',
  authorId: DOCTOR,
  recordedAt: new Date(10_000),
  text: 'Sin alergias conocidas',
  ...overrides,
});

describe('ChartProposalService — reading the chart from the conversation (AS-260)', () => {
  it('AS-260 proposes each entry its line backs, of its class and with its stretch, in the name of who asked', async () => {
    const { client, sent } = model();
    const { service, suggestions } = build({ llm: client });

    const count = await service.readFrom({ encounter: ENCOUNTER, lines: LINES, requestedBy: DOCTOR, lexicon: null }); // prettier-ignore

    expect(count).toBe(2);
    expect(sent[0]).toMatchObject({ purpose: CHART_PURPOSE, tier: 'quality' });
    expect(sent[0]!.prompt).toContain('[L2] No, que yo sepa, a ninguno.');
    expect(
      suggestions.proposed.map((each) => [
        each.kind,
        each.proposal.text,
        each.sources,
      ]),
    ).toEqual([
      // prettier-ignore
      ['chart-no-allergy', 'Sin alergias conocidas', [{ kind: 'transcript', fromMs: 4_500, toMs: 7_000 }]], // prettier-ignore
      ['chart-history', 'Hipertensión arterial · Madre', [{ kind: 'transcript', fromMs: 11_500, toMs: 14_000 }]], // prettier-ignore
    ]);
    expect(suggestions.raw.propose).toHaveBeenCalledWith(expect.any(Array), { userId: DOCTOR, sites: 'all' }); // prettier-ignore
  });

  it('AS-025 AS-260 an identifier still in the cleared conversation fails closed: no call, nothing proposed', async () => {
    const { client, sent } = model();
    const { service, suggestions } = build({ llm: client });
    const lines = [
      { startMs: 0, endMs: 1_000, text: 'Mi cédula es 1710034065' },
    ];

    await expect(service.readFrom({ encounter: ENCOUNTER, lines, requestedBy: DOCTOR, lexicon: null })).rejects.toBeInstanceOf(PseudonymizerFailedError); // prettier-ignore
    expect(sent).toHaveLength(0);
    expect(suggestions.proposed).toHaveLength(0);
  });

  it('AS-260 an answer that was not kept in ai_run proposes nothing', async () => {
    const { service, suggestions } = build({ llm: model(ANSWER, null).client });

    await expect(service.readFrom({ encounter: ENCOUNTER, lines: LINES, requestedBy: DOCTOR, lexicon: null })).resolves.toBe(0); // prettier-ignore
    expect(suggestions.proposed).toHaveLength(0);
  });
});

describe('ChartProposalService — on screen, accepted and discarded (AS-263 to AS-265)', () => {
  async function read(input: Parameters<typeof build>[0] = {}) {
    const built = build(input);
    await built.service.readFrom({ encounter: ENCOUNTER, lines: LINES, requestedBy: DOCTOR, lexicon: null }); // prettier-ignore
    return built;
  }

  it('AS-263 shows the latest reading with each line read again, and leaves its read in the trail', async () => {
    const { service, audits } = await read();

    const overview = await service.overview('enc-1', doctor);

    expect(
      overview.proposals.map((each) => [each.id, each.text, each.quote]),
    ).toEqual([
      // prettier-ignore
      ['sug-1', 'Sin alergias conocidas', 'No, que yo sepa, a ninguno.'],
      [
        'sug-2',
        'Hipertensión arterial · Madre',
        'Yo no. Mi mamá es hipertensa.',
      ],
    ]);
    expect(audits).toEqual([expect.objectContaining({ resourceType: 'assistant_chart', action: 'READ' })]); // prettier-ignore
  });

  it('AS-039 only the attention’s own professional reads or decides them', async () => {
    const { service } = await read({ encounter: { practitionerUserId: 'other' } }); // prettier-ignore

    await expect(service.overview('enc-1', doctor)).rejects.toBeInstanceOf(AssistantNotEncounterOwnerError); // prettier-ignore
  });

  it('AS-265 links the record the physician just made for this patient; any other record is refused and nothing is decided', async () => {
    const { service, suggestions } = await read({
      records: {
        mine: record(),
        theirs: record({ patientId: 'pat-2' }),
        someoneElse: record({ authorId: 'user-nurse' }),
        before: record({ recordedAt: new Date(0) }),
      },
    });

    for (const recordId of ['theirs', 'someoneElse', 'before', 'missing']) {
      await expect(service.accept({ encounterId: 'enc-1', suggestionId: 'sug-1', recordId }, doctor)).rejects.toBeInstanceOf(SuggestionChartMismatchError); // prettier-ignore
    }
    expect(suggestions.raw.accept).not.toHaveBeenCalled();

    // Control: the patient's own, by who accepts, after the proposal.
    const after = await service.accept({ encounterId: 'enc-1', suggestionId: 'sug-1', recordId: 'mine' }, doctor); // prettier-ignore
    expect(suggestions.raw.accept).toHaveBeenCalledWith({ suggestionId: 'sug-1', recordId: 'mine' }, { userId: DOCTOR, sites: 'all' }); // prettier-ignore
    expect(after.proposals.map((each) => each.id)).toEqual(['sug-2']);
  });

  it('AS-264 «sin alergias» against an active allergy is shown with its conflict and never accepted', async () => {
    const { service, suggestions } = await read({ allergies: ['Penicilina'], records: { mine: record() } }); // prettier-ignore

    const overview = await service.overview('enc-1', doctor);
    expect(overview.proposals[0]).toMatchObject({ id: 'sug-1', conflict: 'active-allergy' }); // prettier-ignore
    await expect(service.accept({ encounterId: 'enc-1', suggestionId: 'sug-1', recordId: 'mine' }, doctor)).rejects.toBeInstanceOf(SuggestionChartMismatchError); // prettier-ignore
    expect(suggestions.raw.accept).not.toHaveBeenCalled();
  });

  it('AS-265 discards a shown proposal; one not shown, or on a closed attention, is refused', async () => {
    const { service } = await read();

    const after = await service.discard({ encounterId: 'enc-1', suggestionId: 'sug-2' }, doctor); // prettier-ignore
    expect(after.proposals.map((each) => each.id)).toEqual(['sug-1']);
    await expect(service.discard({ encounterId: 'enc-1', suggestionId: 'sug-2' }, doctor)).rejects.toBeInstanceOf(SuggestionNotFoundError); // prettier-ignore

    const closed = await read({ encounter: { status: 'DISCHARGED' } });
    await expect(closed.service.discard({ encounterId: 'enc-1', suggestionId: 'sug-1' }, doctor)).rejects.toBeInstanceOf(AssistantEncounterClosedError); // prettier-ignore
  });
});
