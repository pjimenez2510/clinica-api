import { describe, expect, it } from 'vitest';

import {
  backedProblems,
  baselineOf,
  currentReading,
  foldText,
  type OfferedCode,
} from './problem-coding';

const SECTIONS = [
  { key: 'motivoConsulta', text: 'Dolor de garganta' },
  {
    key: 'enfermedadActual',
    text: 'Ana refiere odinofagia de tres  días y fiebre de 38,5 °C. Tensión 150/95 en dos tomas.',
  },
];
const CLEARED =
  'Dolor de garganta\n[PERSONA_1] refiere odinofagia de tres días y fiebre de 38,5 °C. Tensión 150/95 en dos tomas.';
const restore = (text: string) => text.split('[PERSONA_1]').join('Ana');

describe('the phrase of a problem (AS-028)', () => {
  it('AS-028 keeps a problem whose phrase is in the note, ignoring case, accents and spaces, with its section', () => {
    const { kept, dropped } = backedProblems({
      named: [
        { problem: 'Faringitis aguda', quote: 'Odinofagia de tres dias', codes: ['J02.9'] }, // prettier-ignore
      ],
      cleared: CLEARED,
      sections: SECTIONS,
      restore,
    });

    expect(dropped).toBe(0);
    expect(kept).toEqual([
      {
        problem: 'Faringitis aguda',
        quote: 'Odinofagia de tres dias',
        section: 'enfermedadActual',
        codes: ['J02.9'],
      },
    ]);
  });

  it('AS-028 drops a problem whose phrase nobody wrote, and one too short to mean anything', () => {
    const { kept, dropped } = backedProblems({
      named: [
        { problem: 'Diabetes', quote: 'glucosa de 250 en ayunas', codes: ['E11.9'] }, // prettier-ignore
        { problem: 'Fiebre', quote: 'sí', codes: ['R50.9'] },
        // Control: the phrase that is there survives beside them.
        { problem: 'Hipertensión', quote: 'Tensión 150/95 en dos tomas', codes: ['I10'] }, // prettier-ignore
      ],
      cleared: CLEARED,
      sections: SECTIONS,
      restore,
    });

    expect(kept.map((problem) => problem.problem)).toEqual(['Hipertensión']);
    expect(dropped).toBe(2);
  });

  it('AS-028 puts the names back in what the physician reads, and checks the phrase against the note too', () => {
    const { kept } = backedProblems({
      named: [
        { problem: 'Faringitis de [PERSONA_1]', quote: '[PERSONA_1] refiere odinofagia', codes: [] }, // prettier-ignore
      ],
      cleared: CLEARED,
      sections: SECTIONS,
      restore,
    });

    expect(kept[0]).toMatchObject({
      problem: 'Faringitis de Ana',
      quote: 'Ana refiere odinofagia',
    });
  });

  it('AS-028 folds only case, accents, quotes and spaces: a paraphrase is not the phrase', () => {
    expect(foldText('  Odinofagia  de «TRES» Días ')).toBe('odinofagia de tres dias'); // prettier-ignore
    expect(foldText('dolor al tragar')).not.toBe(foldText('odinofagia'));
  });
});

const entry = (code: string): OfferedCode => ({
  conceptId: `c-${code}`,
  code,
  display: `Nombre de ${code}`,
});

describe('the baseline (AS-027)', () => {
  it('AS-027 offers the history first, then the clinic, without what is recorded, without repeats, five at most', () => {
    const resolved = new Map(
      ['I10.X', 'E11.9', 'J00.X', 'J02.9', 'K29.7', 'N39.0', 'M54.5'].map(
        (code) => [code, entry(code)],
      ),
    );

    const offered = baselineOf({
      history: [
        { code: 'I10.X', times: 3, lastUsedOn: '2026-01-02' }, // fecha-fija: dato, no reloj
        { code: 'E11.9', times: 1, lastUsedOn: '2025-11-10' }, // fecha-fija: dato, no reloj
      ],
      frequency: [
        { code: 'J00.X', times: 40, lastUsedOn: '2026-02-01' }, // fecha-fija: dato, no reloj
        { code: 'I10.X', times: 30, lastUsedOn: '2026-02-01' }, // fecha-fija: dato, no reloj
        { code: 'J02.9', times: 20, lastUsedOn: '2026-02-01' }, // fecha-fija: dato, no reloj
        { code: 'K29.7', times: 10, lastUsedOn: '2026-02-01' }, // fecha-fija: dato, no reloj
        { code: 'N39.0', times: 5, lastUsedOn: '2026-02-01' }, // fecha-fija: dato, no reloj
      ],
      recorded: ['J02.9'],
      resolved,
    });

    expect(offered.map(({ code, source }) => [code, source])).toEqual([
      ['I10.X', 'history'],
      ['E11.9', 'history'],
      ['J00.X', 'frequency'],
      ['K29.7', 'frequency'],
      ['N39.0', 'frequency'],
    ]);
    expect(offered[0]).toMatchObject({ display: 'Nombre de I10.X', times: 3 });
  });

  it('AS-027 a code the catalogue no longer has in force is not offered', () => {
    const offered = baselineOf({
      history: [{ code: 'U07.1', times: 2, lastUsedOn: '2025-01-01' }], // fecha-fija: dato, no reloj
      frequency: [{ code: 'J00.X', times: 9, lastUsedOn: '2026-01-01' }], // fecha-fija: dato, no reloj
      recorded: [],
      resolved: new Map([['J00.X', entry('J00.X')]]),
    });

    expect(offered.map(({ code }) => code)).toEqual(['J00.X']);
  });
});

describe('the reading on screen (AS-036, AS-038)', () => {
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);

  it('AS-036 AS-038 shows the latest reading only, without the discarded', () => {
    const shown = currentReading([
      { id: 'old', aiRunId: 'run-1', status: 'PROPOSED', proposedAt: at(0) },
      { id: 'a', aiRunId: 'run-2', status: 'PROPOSED', proposedAt: at(5) },
      { id: 'b', aiRunId: 'run-2', status: 'ACCEPTED', proposedAt: at(5) },
      { id: 'c', aiRunId: 'run-2', status: 'DISCARDED', proposedAt: at(5) },
    ]);

    expect(shown.map(({ id }) => id)).toEqual(['a', 'b']);
  });

  it('AS-036 with nothing read, nothing is shown', () => {
    expect(currentReading([])).toEqual([]);
  });
});
