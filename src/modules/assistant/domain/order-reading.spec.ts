import { describe, expect, it } from 'vitest';

import {
  backedExams,
  blockOf,
  offeredCandidates,
  type ReadExam,
} from './order-reading';
import { decisionOf, type SuggestionView } from './suggestion';

/**
 * AS-103, AS-104, AS-105, AS-109. The rules of «Proponer exámenes» that need
 * no model, no database and no clock. Every note and conversation here is
 * invented.
 */
const CATALOGUE = [
  { serviceId: 's-bh', code: 'LAB-BH', name: 'Biometría hemática completa', category: 'LABORATORY' as const }, // prettier-ignore
  { serviceId: 's-glu', code: 'LAB-GLUCOSA-AYUNAS', name: 'Glucosa en ayunas', category: 'LABORATORY' as const }, // prettier-ignore
  { serviceId: 's-emo', code: 'LAB-EMO', name: 'Elemental y microscópico de orina (EMO)', category: 'LABORATORY' as const }, // prettier-ignore
  { serviceId: 's-rx', code: 'IMG-RX-TORAX', name: 'Radiografía de tórax', category: 'IMAGING' as const }, // prettier-ignore
  { serviceId: 's-eco', code: 'IMG-ECO-ABDOMINAL', name: 'Ecografía abdominal', category: 'IMAGING' as const }, // prettier-ignore
  { serviceId: 's-ura', code: 'LAB-UROCULTIVO', name: 'Urocultivo', category: 'LABORATORY' as const }, // prettier-ignore
];

const plan = (text: string) => [{ key: 'plan', text }];
const read = (quote: string, candidates: number[] = [1]): ReadExam => ({
  requested: 'examen',
  quote,
  candidates,
});

describe('the sentence that asks for an exam (AS-103)', () => {
  it('AS-103 keeps an exam whose sentence the note writes, with the note’s own sentence and its section', () => {
    const note = plan('Se solicita biometría hemática y glucosa en ayunas. Control en una semana.'); // prettier-ignore
    const backed = backedExams({
      read: [read('biometría hemática y glucosa en ayunas', [1, 2])],
      cleared: note[0]!.text,
      sections: note,
      transcript: [],
      restore: (text) => text,
    });

    expect(backed.dropped).toBe(0);
    expect(backed.kept).toEqual([
      {
        requested: 'examen',
        quote: 'Se solicita biometría hemática y glucosa en ayunas.',
        candidates: [1, 2],
        origin: { kind: 'note', section: 'plan' },
      },
    ]);
  });

  it('AS-103 an exam the note only mentions —a result it brings, one done before, one not needed— backs nothing; the same exam asked for does', () => {
    const cases = [
      [
        'Trae biometría hemática del mes pasado, normal.',
        'biometría hemática del mes pasado',
      ],
      [
        'Resultado de glucosa en ayunas de 110 mg/dL.',
        'glucosa en ayunas de 110',
      ],
      [
        'Ecografía abdominal previa sin hallazgos.',
        'Ecografía abdominal previa sin hallazgos',
      ],
      [
        'Ya tiene radiografía de tórax de ayer.',
        'radiografía de tórax de ayer',
      ],
      ['No requiere radiografía de tórax.', 'radiografía de tórax'],
      [
        'Urocultivo realizado la semana pasada: negativo.',
        'Urocultivo realizado la semana pasada',
      ],
    ] as const;
    for (const [text, quote] of cases) {
      const note = plan(text);
      const backed = backedExams({ read: [read(quote)], cleared: text, sections: note, transcript: [], restore: (t) => t }); // prettier-ignore
      expect(backed.kept, text).toEqual([]);
      expect(backed.dropped, text).toBe(1);
    }
    // Positive control: asked for, the same words back a line.
    const asked = 'Se pide radiografía de tórax de control.';
    const backed = backedExams({ read: [read('radiografía de tórax de control')], cleared: asked, sections: plan(asked), transcript: [], restore: (t) => t }); // prettier-ignore
    expect(backed.kept).toHaveLength(1);
  });

  it('AS-103 what denies the exam AFTER the quoted words, or anywhere as a condition or a later visit, backs nothing (review G1)', () => {
    const cases = [
      ['Biometría hemática previa normal.', 'Biometría hemática'],
      ['Ecografía abdominal previa sin hallazgos.', 'Ecografía abdominal'],
      ['Glucosa en ayunas reportada en 110 mg/dL.', 'Glucosa en ayunas'],
      ['Biometría hemática: no requiere por ahora.', 'Biometría hemática'],
      [
        'Se le explicó que la radiografía de tórax no es necesaria.',
        'radiografía de tórax',
      ],
      [
        'Si no mejora en 48 horas, radiografía de tórax.',
        'radiografía de tórax',
      ],
      [
        'Si persiste la fiebre, solicitar biometría hemática.',
        'solicitar biometría hemática',
      ],
      ['Perfil lipídico en el próximo control.', 'Perfil lipídico'],
      ['Ecografía abdominal anterior sin cambios.', 'Ecografía abdominal'],
    ] as const;
    for (const [text, quote] of cases) {
      const backed = backedExams({ read: [read(quote)], cleared: text, sections: plan(text), transcript: [], restore: (t) => t }); // prettier-ignore
      expect(backed.kept, text).toEqual([]);
    }
  });

  it('AS-103 a request that only shares a word with a denial is kept: «ya que tiene», and the clause after a result (review 3)', () => {
    const asked = [
      [
        'Se solicita biometría hemática ya que tiene fiebre.',
        'biometría hemática',
      ],
      [
        'Trae EMO normal, se solicita urocultivo con antibiograma.',
        'urocultivo con antibiograma',
      ],
      ['Glucosa en ayunas y control con resultados.', 'Glucosa en ayunas'],
    ] as const;
    for (const [text, quote] of asked) {
      const backed = backedExams({ read: [read(quote)], cleared: text, sections: plan(text), transcript: [], restore: (t) => t }); // prettier-ignore
      expect(backed.kept, text).toHaveLength(1);
    }
  });

  it('AS-103 a sentence that is not in the note, or is too short to mean anything, backs nothing', () => {
    const text = 'Se solicita biometría hemática.';
    const run = (quote: string) =>
      backedExams({ read: [read(quote)], cleared: text, sections: plan(text), transcript: [], restore: (t) => t }).kept; // prettier-ignore
    expect(run('se solicita hemograma')).toEqual([]);
    expect(run('biometría')).toEqual([]);
    expect(run('solicita biometría hemática')).toHaveLength(1);
  });

  it('AS-103 a sentence of the conversation carries the stretch it was said in, across two segments', () => {
    const transcript = [
      { startMs: 0, endMs: 4_000, text: 'Buenos días, cuénteme qué le pasa.' },
      { startMs: 4_000, endMs: 9_500, text: 'Le voy a pedir una ecografía' },
      {
        startMs: 9_500,
        endMs: 12_000,
        text: 'abdominal para ver la vesícula.',
      },
    ];
    const cleared = transcript.map((each) => each.text).join('\n');
    const backed = backedExams({
      read: [read('pedir una ecografía abdominal', [5])],
      cleared,
      sections: [],
      transcript,
      restore: (t) => t,
    });

    expect(backed.kept).toEqual([
      {
        requested: 'examen',
        quote: 'Le voy a pedir una ecografía abdominal para ver la vesícula.',
        candidates: [5],
        origin: { kind: 'transcript', fromMs: 4_000, toMs: 12_000 },
      },
    ]);
  });

  it('AS-103 the note is searched before the conversation, and the placeholders the model kept are put back', () => {
    const text = 'Biometría hemática a [PERSONA_1] mañana.';
    const backed = backedExams({
      read: [read('Biometría hemática a [PERSONA_1]')],
      cleared: text,
      sections: plan('Biometría hemática a Rosa mañana.'),
      transcript: [
        { startMs: 0, endMs: 1_000, text: 'Biometría hemática a Rosa' },
      ],
      restore: (t) => t.replace('[PERSONA_1]', 'Rosa'),
    });
    expect(backed.kept[0]?.origin).toEqual({ kind: 'note', section: 'plan' });
    expect(backed.kept[0]?.quote).toBe('Biometría hemática a Rosa mañana.');
  });
});

describe('the candidates offered (AS-104)', () => {
  it('AS-104 keeps only the numbers it was offered, once each, at most five, in the model’s order', () => {
    expect(offeredCandidates([4, 9, 0, 4, 1, -2, 2.5], CATALOGUE).map((each) => each.code)).toEqual(['IMG-RX-TORAX', 'LAB-BH']); // prettier-ignore
    expect(offeredCandidates([1, 2, 3, 4, 5, 6], CATALOGUE)).toHaveLength(5);
    expect(offeredCandidates([], CATALOGUE)).toEqual([]);
  });
});

describe('why a candidate cannot be accepted now (AS-105, AS-106)', () => {
  it('AS-106 an exam already on a live order of the attention says so; another one does not', () => {
    const ordered = new Set(['LAB-BH']);
    expect(blockOf(CATALOGUE[0]!, ordered)).toBe('in-order');
    expect(blockOf(CATALOGUE[1]!, ordered)).toBeNull();
  });
});

describe('the distance of an accepted exam (AS-109, AS-022)', () => {
  const suggestion: SuggestionView = {
    id: 'p1',
    encounterId: 'e1',
    aiRunId: 'r1',
    kind: 'order-item',
    proposal: { codes: ['LAB-BH', 'LAB-GLUCOSA-AYUNAS'], quote: 'x' },
    sources: [],
    status: 'PROPOSED',
    distance: null,
    record: null,
    proposedAt: new Date(0),
    decidedBy: null,
    decidedAt: null,
  };

  it('AS-109 choosing any of the candidates is «tal cual» (0) and keeps which one; an exam that was not proposed is «con cambios» (1)', () => {
    expect(decisionOf(suggestion, { outcome: 'accept', recordId: 'o1', saved: 'LAB-GLUCOSA-AYUNAS' })).toEqual({ status: 'ACCEPTED', distance: 0, record: { kind: 'service_order', id: 'o1' }, acceptedCode: 'LAB-GLUCOSA-AYUNAS' }); // prettier-ignore
    expect(decisionOf(suggestion, { outcome: 'accept', recordId: 'o1', saved: 'LAB-EMO' }).distance).toBe(1); // prettier-ignore
  });
});
