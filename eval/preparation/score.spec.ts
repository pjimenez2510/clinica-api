import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPreparationCases, type PreparationCase } from './cases.ts';
import { literal, scoreCase, summarise, verdict, worded } from './score.ts';

const ITEM: PreparationCase = {
  id: 'T1',
  style: 'juguete',
  lines: [
    { speaker: 'nursing', text: '¿Qué le trae?' },
    { speaker: 'patient', text: 'Me duele la cabeza.' },
    {
      speaker: 'nursing',
      text: 'Presión 120 con 80, pesa ciento cincuenta libras.',
    },
  ],
  expected: { systolicBp: 120, diastolicBp: 80, weightKg: 68 },
  heightPosition: null,
  complaint: [1],
};
const LINES = ITEM.lines.map((line, at) => ({ startMs: at * 10_000, endMs: at * 10_000 + 9_000, text: line.text })); // prettier-ignore
const v = (value: number, quote: string | null, startMs: number | null = 20_000) => ({ value, quote, startMs }); // prettier-ignore

describe('AS-255 the scoring of a preparation', () => {
  it('SC-099 a value is literal when its phrase is in its line and says its number, in pounds or metres too', () => {
    expect(literal('weightKg', 68, 'pesa ciento cincuenta libras', LINES[2])).toBe(true); // prettier-ignore
    expect(literal('systolicBp', 130, 'Presión 120 con 80', LINES[2])).toBe(false); // prettier-ignore
    expect(literal('systolicBp', 120, 'Presión 120 sobre 80', LINES[2])).toBe(false); // prettier-ignore
    expect(literal('systolicBp', 120, null, LINES[2])).toBe(false);
    // Independent of the barrier: numbers with words between them are not one.
    const fever = { startMs: 0, endMs: 9_000, text: 'Desde hace 2 días con fiebre de 38.' }; // prettier-ignore
    expect(literal('heightCm', 238, 'hace 2 días con fiebre de 38', fever)).toBe(false); // prettier-ignore
    expect(literal('temperatureC', 36.5, 'treinta y seis y medio', { startMs: 0, endMs: 1, text: 'Temperatura treinta y seis y medio.' })).toBe(true); // prettier-ignore
    expect(literal('heightCm', 160, 'mide uno sesenta', { startMs: 0, endMs: 1, text: 'Mide uno sesenta.' })).toBe(true); // prettier-ignore
    // A pressure as the recogniser writes «con», or with a slash.
    expect(literal('diastolicBp', 80, 'perdón, 130,80', { startMs: 0, endMs: 1, text: 'Presión 130,85, perdón, 130,80.' })).toBe(true); // prettier-ignore
    expect(literal('systolicBp', 120, 'Presión 120/80', { startMs: 0, endMs: 1, text: 'Presión 120/80.' })).toBe(true); // prettier-ignore
    expect(literal('heartRate', 80, 'Presión 120/80', { startMs: 0, endMs: 1, text: 'Presión 120/80.' })).toBe(false); // prettier-ignore
  });

  it('SC-100 SC-101 counts right, wrong, empty and invented values, the reason and the speakers', () => {
    const scored = scoreCase({
      item: ITEM,
      arm: 'escrito',
      voice: '—',
      lines: LINES,
      latencyMs: 1_200,
      reading: {
        values: { systolicBp: v(120, 'Presión 120 con 80'), diastolicBp: v(70, 'Presión 120 con 80'), heartRate: v(80, 'Presión 120 con 80') }, // prettier-ignore
        heightPosition: null,
        unclear: ['weightKg'],
        complaint: {
          text: 'Me duele la cabeza.',
          quote: 'Me duele la cabeza.',
          startMs: 10_000,
        },
        speakers: ['nursing', 'patient', 'patient'],
      },
    });
    const outcome = Object.fromEntries(scored.values.map((each) => [each.field, each.outcome])); // prettier-ignore
    expect(outcome).toEqual({ systolicBp: 'correct', diastolicBp: 'wrong', weightKg: 'empty', heartRate: 'invented' }); // prettier-ignore
    expect(scored.notLiteral).toBe(1);
    expect(scored.complaint).toBe('correct');
    expect(scored.speakers).toEqual({ right: 2, lines: 3 });

    const summary = summarise([scored]);
    expect(summary).toMatchObject({ expected: 3, correct: 1, serious: 2, notLiteral: 1, complaintRight: 1, speakersRight: 2 }); // prettier-ignore
    expect(verdict(summary)).toEqual({
      sc099: false,
      sc100: false,
      sc101: false,
    });
  });

  it('SC-101 a reason proposed where the patient gave none is invented; an unanswered reading counts apart', () => {
    const none = { ...ITEM, complaint: null };
    const scored = scoreCase({ item: none, arm: 'oido', voice: 'x', lines: LINES, latencyMs: 1, reading: { values: {}, heightPosition: null, unclear: [], complaint: { text: 'Me duele la cabeza.', quote: 'Me duele la cabeza.', startMs: 10_000 }, speakers: [] } }); // prettier-ignore
    expect(scored.complaint).toBe('invented');
    const failed = scoreCase({ item: ITEM, arm: 'oido', voice: 'x', lines: LINES, latencyMs: null, reading: null }); // prettier-ignore
    expect(summarise([failed])).toMatchObject({ cases: 1, answered: 0, expected: 0 }); // prettier-ignore
  });

  it('EV-1 refuses a set that is not invented, and a reason on a line that is not the patient’s', () => {
    const dir = mkdtempSync(join(tmpdir(), 'preparaciones-'));
    const file = join(dir, 'p.json');
    writeFileSync(file, JSON.stringify({ origin: 'real', description: '', cases: [ITEM] })); // prettier-ignore
    expect(() => loadPreparationCases(file)).toThrow();
    writeFileSync(file, JSON.stringify({ origin: 'invented', description: '', cases: [{ ...ITEM, complaint: [0] }] })); // prettier-ignore
    expect(() => loadPreparationCases(file)).toThrow(/motivo/);
    writeFileSync(file, JSON.stringify({ origin: 'invented', description: '', cases: [ITEM] })); // prettier-ignore
    expect(loadPreparationCases(file).cases).toHaveLength(1);
  });

  it('AS-284 a number written «150 y 8» is said literally as 158, and «120 y 80» is no 200', () => {
    const rosa = { startMs: 0, endMs: 9_000, text: 'Pesa 72 kilos y la talla 150 y 8 centímetros un medida de pie.' }; // prettier-ignore
    expect(literal('heightCm', 158, 'la talla 150 y 8 centímetros', rosa)).toBe(true); // prettier-ignore
    expect(literal('heightCm', 158, 'la talla 150 y ocho', { ...rosa, text: 'la talla 150 y ocho' })).toBe(true); // prettier-ignore
    expect(literal('systolicBp', 200, 'Presión 120 y 80', { ...rosa, text: 'Presión 120 y 80' })).toBe(false); // prettier-ignore
  });

  it('AS-284 a reason is worded when it is not the phrase, has no first person and no fillers', () => {
    const quote = 'Ay, señorita, tengo un dolor de cabeza muy fuerte desde hace dos días y me siento mareada.'; // prettier-ignore
    expect(worded({ text: 'Dolor de cabeza muy fuerte desde hace dos días, con sensación de mareo', quote })).toBe(true); // prettier-ignore
    expect(worded({ text: quote, quote })).toBe(false);
    expect(worded({ text: 'Tengo dolor de cabeza desde hace dos días', quote })).toBe(false); // prettier-ignore
    expect(worded({ text: 'Señorita, dolor de cabeza desde hace dos días', quote })).toBe(false); // prettier-ignore
    expect(worded({ text: 'Dolor de cabeza y se siente mareada', quote })).toBe(true); // prettier-ignore

    const scored = scoreCase({ item: ITEM, arm: 'escrito', voice: '—', lines: LINES, latencyMs: 1, reading: { values: {}, heightPosition: null, unclear: [], complaint: { text: 'Dolor de cabeza.', quote: 'Me duele la cabeza.', startMs: 10_000 }, speakers: [] } }); // prettier-ignore
    expect(scored.complaintWorded).toBe(true);
    expect(summarise([scored])).toMatchObject({ complaintProposed: 1, complaintWorded: 1 }); // prettier-ignore
  });

  it('AS-284 «150 y 8» is literal only where AS-280 joins, and a worded reason that had to stay literal is serious', () => {
    const fever = { startMs: 0, endMs: 9_000, text: 'Temperatura 40 y 2.' };
    expect(literal('temperatureC', 42, 'Temperatura 40 y 2', fever)).toBe(false); // prettier-ignore
    expect(literal('temperatureC', 40.2, 'Temperatura 40 y 2', fever)).toBe(false); // prettier-ignore

    const item = { ...ITEM, complaintLiteral: true };
    const reading = (text: string) => ({ values: {}, heightPosition: null, unclear: [], complaint: { text, quote: 'Me duele la cabeza.', startMs: 10_000 }, speakers: [] }); // prettier-ignore
    const worded = scoreCase({ item, arm: 'escrito', voice: '—', lines: LINES, latencyMs: 1, reading: reading('Dolor de cabeza.') }); // prettier-ignore
    const kept = scoreCase({ item, arm: 'escrito', voice: '—', lines: LINES, latencyMs: 1, reading: reading('Me duele la cabeza.') }); // prettier-ignore
    expect([worded.complaintUnfaithful, kept.complaintUnfaithful]).toEqual([true, false]); // prettier-ignore
    expect(summarise([worded, kept])).toMatchObject({ complaintUnfaithful: 1, complaintProposed: 0 }); // prettier-ignore
  });
});
