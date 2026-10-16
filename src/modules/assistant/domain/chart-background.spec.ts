import { describe, expect, it } from 'vitest';

import {
  backedChart,
  currentChartReading,
  sentenceOf,
  shownChart,
  type ChartAnswer,
  type StoredChartProposal,
} from './chart-background';
import { conversationOf, type TranscriptLine } from './note-draft';

/** The libreto's lines, as the recogniser would give them. */
const LINES: TranscriptLine[] = [
  { startMs: 0, endMs: 4_000, text: '¿Es alérgica a algún medicamento?' },
  { startMs: 4_500, endMs: 7_000, text: 'No, que yo sepa, a ninguno.' },
  { startMs: 7_500, endMs: 11_000, text: '¿Alguna enfermedad que tenga usted o su familia?' }, // prettier-ignore
  { startMs: 11_500, endMs: 14_000, text: 'Yo no. Mi mamá es hipertensa.' },
  { startMs: 14_500, endMs: 18_000, text: 'Soy alérgica a la amoxicilina, me da ronchas.' }, // prettier-ignore
];
const { markers } = conversationOf(LINES);
const same = (text: string) => text;

function answer(overrides: Partial<ChartAnswer> = {}): ChartAnswer {
  return { noKnownAllergies: null, allergies: [], history: [], ...overrides };
}

describe('what the conversation said of the chart (AS-260, AS-262)', () => {
  it('AS-260 the libreto: «sin alergias conocidas» and «Hipertensión arterial · Madre», each with the stretch of its line', () => {
    const { kept, dropped } = backedChart({
      answer: answer({
        noKnownAllergies: { source: 'L2' },
        history: [{ kind: 'FAMILY', description: 'Hipertensión arterial', relative: 'Madre', source: 'L4' }], // prettier-ignore
      }),
      markers,
      restore: same,
    });

    expect(dropped).toBe(0);
    expect(kept).toEqual([
      { kind: 'chart-no-allergy', text: 'Sin alergias conocidas', fromMs: 4_500, toMs: 7_000 }, // prettier-ignore
      { kind: 'chart-history', text: 'Hipertensión arterial · Madre', history: 'FAMILY', description: 'Hipertensión arterial', relative: 'Madre', fromMs: 11_500, toMs: 14_000 }, // prettier-ignore
    ]);
  });

  it('AS-262 an allergy whose substance its line names is kept; one its line does not name is dropped and counted', () => {
    const { kept, dropped } = backedChart({
      answer: answer({
        allergies: [
          { substance: 'Amoxicilina', reaction: 'ronchas', source: 'L5' },
          { substance: 'Penicilina', reaction: null, source: 'L5' },
          { substance: 'Látex', reaction: null, source: 'L9' },
        ],
      }),
      markers,
      restore: same,
    });

    expect(kept).toEqual([
      { kind: 'chart-allergy', text: 'Amoxicilina · ronchas', substance: 'Amoxicilina', reaction: 'ronchas', fromMs: 14_500, toMs: 18_000 }, // prettier-ignore
    ]);
    expect(dropped).toBe(2);
  });

  it('AS-262 a family entry needs a relative of the list said with the disease; a question backs nothing', () => {
    const { kept, dropped } = backedChart({
      answer: answer({
        history: [
          { kind: 'FAMILY', description: 'Hipertensión arterial', relative: 'Padre', source: 'L4' }, // prettier-ignore
          { kind: 'FAMILY', description: 'Hipertensión arterial', relative: 'Vecina', source: 'L4' }, // prettier-ignore
          { kind: 'FAMILY', description: 'Hipertensión arterial', relative: null, source: 'L4' }, // prettier-ignore
          { kind: 'PERSONAL', description: 'Asma', relative: null, source: 'L3' }, // prettier-ignore
        ],
      }),
      markers,
      restore: same,
    });

    expect(dropped).toBe(4);
    expect(kept).toEqual([]);
  });

  it('AS-262 (review G1, I2) what is asked, denied or not said is no record; what is stated is', () => {
    const talk: TranscriptLine[] = [
      { startMs: 0, endMs: 1, text: '¿Es alérgico a la penicilina?' },
      { startMs: 2, endMs: 3, text: 'No.' },
      { startMs: 4, endMs: 5, text: 'Me duele la garganta desde ayer.' },
      { startMs: 6, endMs: 7, text: 'Mi mamá me trajo. Yo tengo asma desde niña.' }, // prettier-ignore
      { startMs: 8, endMs: 9, text: 'No soy alérgico a nada, pero mi papá no es diabético.' }, // prettier-ignore
    ];
    const { markers: talked } = conversationOf(talk);
    const { kept } = backedChart({
      answer: answer({
        noKnownAllergies: { source: 'L3' },
        allergies: [{ substance: 'Penicilina', reaction: null, source: 'L1' }],
        history: [
          { kind: 'FAMILY', description: 'Diabetes mellitus', relative: 'Madre', source: 'L4' }, // prettier-ignore
          { kind: 'FAMILY', description: 'Diabetes mellitus', relative: 'Padre', source: 'L5' }, // prettier-ignore
          { kind: 'PERSONAL', description: 'Asma', relative: null, source: 'L4' }, // prettier-ignore
        ],
      }),
      markers: talked,
      restore: same,
    });
    expect(kept.map((each) => each.text)).toEqual(['Asma']);

    const denied = backedChart({ answer: answer({ noKnownAllergies: { source: 'L5' } }), markers: talked, restore: same }); // prettier-ignore
    expect(denied.kept.map((each) => each.text)).toEqual(['Sin alergias conocidas']); // prettier-ignore
  });

  it('AS-262 «sin alergias» beside an allergy of the same reading is no proposal; with no line, neither', () => {
    const both = backedChart({
      answer: answer({
        noKnownAllergies: { source: 'L2' },
        allergies: [{ substance: 'amoxicilina', reaction: null, source: 'L5' }],
      }),
      markers,
      restore: same,
    });
    expect(both.kept.map((each) => each.kind)).toEqual(['chart-allergy']);
    expect(both.dropped).toBe(1);

    const unbacked = backedChart({ answer: answer({ noKnownAllergies: { source: null } }), markers, restore: same }); // prettier-ignore
    expect(unbacked).toEqual({ kept: [], dropped: 1 });
  });

  it('AS-262 the pseudonymizer’s markers are put back, and an entry said twice is proposed once', () => {
    const { kept } = backedChart({
      answer: answer({
        allergies: [
          { substance: 'amoxicilina', reaction: '[PERSONA_1] dice ronchas', source: 'L5' }, // prettier-ignore
          { substance: 'Amoxicilina', reaction: null, source: 'L5' },
        ],
      }),
      markers,
      restore: (text) => text.replace('[PERSONA_1]', 'Lucía'),
    });

    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ reaction: 'Lucía dice ronchas' });
  });
});

describe('what Antecedentes shows (AS-263, AS-264)', () => {
  const stored = (id: string, proposal: Record<string, unknown>, status: StoredChartProposal['status'] = 'PROPOSED'): StoredChartProposal => ({ id, status, proposal }); // prettier-ignore
  const proposals = [
    stored('s-1', { kind: 'chart-no-allergy', text: 'Sin alergias conocidas', fromMs: 4_500, toMs: 7_000 }), // prettier-ignore
    stored('s-2', { kind: 'chart-allergy', text: 'Amoxicilina · ronchas', substance: 'Amoxicilina', reaction: 'ronchas', fromMs: 14_500, toMs: 18_000 }), // prettier-ignore
    stored('s-3', { kind: 'chart-history', text: 'Hipertensión arterial · Madre', history: 'FAMILY', description: 'Hipertensión arterial', relative: 'Madre', fromMs: 11_500, toMs: 14_000 }), // prettier-ignore
  ];
  const empty = { allergies: [], absence: false, history: [] };

  it('AS-263 on an empty chart every proposal shows, with the line read again from the transcript', () => {
    const shown = shownChart([proposals[0]!, proposals[2]!], [], empty, LINES);

    expect(shown.map((each) => [each.id, each.quote, each.conflict])).toEqual([
      ['s-1', 'No, que yo sepa, a ninguno.', null],
      ['s-3', 'Mi mamá es hipertensa.', null],
    ]);
  });

  it('AS-264 (review G1) beside an allergy said and undecided, «sin alergias» is never offered', () => {
    expect(shownChart(proposals, [], empty, LINES).map((each) => each.id)).toEqual(['s-2', 's-3']); // prettier-ignore
  });

  it('AS-263 (review G1) an allergy of an earlier reading still undecided stays when a later reading missed it', () => {
    const at = (ms: number) => new Date(ms);
    const stored = [
      { ...proposals[1]!, aiRunId: 'run-1', proposedAt: at(1), kind: 'chart-allergy' }, // prettier-ignore
      { ...proposals[0]!, id: 's-4', aiRunId: 'run-2', proposedAt: at(2), kind: 'chart-no-allergy' }, // prettier-ignore
    ];

    const current = currentChartReading(stored);

    expect(current.map((each) => each.id)).toEqual(['s-4', 's-2']);
    expect(shownChart(current, [], empty, LINES).map((each) => each.id)).toEqual(['s-2']); // prettier-ignore
  });

  it('AS-263 what the chart already has is not proposed again; nor what was discarded, in a later reading', () => {
    const chart = {
      allergies: ['AMOXICILINA'],
      absence: false,
      history: [{ kind: 'FAMILY' as const, description: 'hipertensión arterial', relative: 'Madre' }], // prettier-ignore
    };
    expect(shownChart(proposals, [], chart, LINES).map((each) => each.id)).toEqual(['s-1']); // prettier-ignore
    expect(shownChart(proposals, ['Sin alergias conocidas'], empty, LINES).map((each) => each.id)).toEqual(['s-2', 's-3']); // prettier-ignore
    expect(shownChart(proposals, [], { ...empty, absence: true }, LINES).map((each) => each.id)).toEqual(['s-2', 's-3']); // prettier-ignore
  });

  it('AS-292 a history entry the chart has in other words shows what the chart says, not as new', () => {
    const own = stored('s-5', { kind: 'chart-history', text: 'Hipertensión arterial', history: 'PERSONAL', description: 'Hipertensión arterial', relative: null, fromMs: 11_500, toMs: 14_000 }); // prettier-ignore
    const chart = {
      ...empty,
      history: [
        {
          kind: 'PERSONAL' as const,
          description: 'HIPERTENSO',
          relative: null,
        },
        {
          kind: 'FAMILY' as const,
          description: 'DIABETES 4',
          relative: 'MADRE',
        },
      ],
    };
    const diabetes = stored('s-6', { kind: 'chart-history', text: 'Diabetes mellitus · Madre', history: 'FAMILY', description: 'Diabetes mellitus', relative: 'Madre', fromMs: 11_500, toMs: 14_000 }); // prettier-ignore

    const shown = shownChart([own, diabetes, proposals[2]!], [], chart, LINES);

    expect(shown.map((each) => [each.id, each.alreadyAs])).toEqual([
      ['s-5', 'HIPERTENSO'],
      ['s-6', 'DIABETES 4 · MADRE'],
      // Positive control: the mother's hypertension is not the patient's own.
      ['s-3', null],
    ]);
  });

  it('AS-264 with an active allergy on the chart, «sin alergias» shows its conflict and is never offered as is', () => {
    const chart = { allergies: ['Penicilina'], absence: false, history: [] };

    const [none] = shownChart(proposals.slice(0, 1), [], chart, LINES);

    expect(none).toMatchObject({ id: 's-1', conflict: 'active-allergy' });
  });

  it('AS-263 a decided proposal, or one whose line the transcript no longer has, is not shown', () => {
    const decided = [stored('s-9', { kind: 'chart-history', text: 'Asma', history: 'PERSONAL', description: 'Asma', relative: null, fromMs: 7_500, toMs: 11_000 }, 'ACCEPTED')]; // prettier-ignore
    expect(shownChart(decided, [], empty, LINES)).toEqual([]);
    expect(shownChart(proposals, [], empty, [])).toEqual([]);
  });
});

describe('the sentence that says it (AS-261)', () => {
  const stretch =
    'algo para el dolor? Paracetamol de 500, cada 8 horas. ¿Es alérgica a algún medicamento? No, que yo sepa, a ninguno. ¿Alguna enfermedad que te';

  it('AS-261 a stretch of 20 s is cut to the sentence that says the proposal', () => {
    expect(sentenceOf({ kind: 'chart-no-allergy', text: 'Sin alergias conocidas', fromMs: 0, toMs: 1 }, stretch)).toBe('No, que yo sepa, a ninguno.'); // prettier-ignore
    expect(sentenceOf({ kind: 'chart-history', text: 'x', history: 'FAMILY', description: 'Hipertensión arterial', relative: 'Madre', fromMs: 0, toMs: 1 }, 'usted o su familia. Yo no. Mi mamá es hipertensa. Vamos a revisarla.')).toBe('Mi mamá es hipertensa.'); // prettier-ignore
  });

  it('AS-261 an unpunctuated stretch is cut to the words around what says it', () => {
    const plain = 'usted o su familia yo no mi mamá es hipertensa vamos a revisarla abra la boca la faringe está enrojecida con placas blancas'; // prettier-ignore
    expect(sentenceOf({ kind: 'chart-history', text: 'x', history: 'FAMILY', description: 'Hipertensión arterial', relative: 'Madre', fromMs: 0, toMs: 1 }, plain)).toBe('…o su familia yo no mi mamá es hipertensa vamos a revisarla…'); // prettier-ignore
  });

  it('AS-261 with nothing that says it, the whole stretch', () => {
    const plain = 'el paciente dice que todo está bien';
    expect(sentenceOf({ kind: 'chart-history', text: 'x', history: 'PERSONAL', description: 'Asma', relative: null, fromMs: 0, toMs: 1 }, plain)).toBe(plain); // prettier-ignore
  });
});
