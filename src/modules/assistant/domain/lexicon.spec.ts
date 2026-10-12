import { describe, expect, it } from 'vitest';

import { buildLexicon, correctLine } from './lexicon';

/**
 * AS-092 (D-247 §4). What the recogniser mangled, corrected towards the CNMB
 * before the model reads it — and never a word the clinic writes.
 */
const lexicon = buildLexicon({
  targets: ['Paracetamol', 'Losartán', 'Amoxicilina', 'Ibuprofeno', 'Enalapril', 'Amlodipino', 'Amilorida'], // prettier-ignore
  protectedWords: ['sarna', 'asma', 'faringitis', 'garganta', 'pacientes'],
});

describe('correctLine (AS-092)', () => {
  it('joins «para acetamol» into the drug the CNMB has', () => {
    const { text, changes } = correctLine(
      'Le doy para acetamol cada ocho horas.',
      lexicon,
    );

    expect(text).toBe('Le doy paracetamol cada ocho horas.');
    expect(changes).toBe(1);
  });

  it('joins a drug the recogniser split in two, keeping the capital', () => {
    expect(correctLine('Toma Los artán desde enero.', lexicon).text).toBe(
      'Toma Losartán desde enero.',
    );
  });

  it('corrects a word one edit away from a principle', () => {
    expect(correctLine('Le receto amoxicilna.', lexicon).text).toBe(
      'Le receto amoxicilina.',
    );
  });

  it('never touches a protected word, however close to another', () => {
    const line = 'Tiene sarna y asma, como otros pacientes.';
    expect(correctLine(line, lexicon)).toEqual({ text: line, changes: 0 });
  });

  it('leaves a word that is equally close to two principles', () => {
    // «prednisolna» is one edit from prednisona and one from prednisolona.
    const tied = buildLexicon({
      targets: ['Prednisona', 'Prednisolona'],
      protectedWords: [],
    });
    const line = 'Toma prednisolna.';
    expect(correctLine(line, tied).text).toBe(line);
  });

  it('does not join two words when the second is a word the clinic writes', () => {
    const line = 'Los pacientes llegan.';
    expect(correctLine(line, lexicon).text).toBe(line);
  });

  it('leaves short words alone', () => {
    const line = 'Para ver, dosis y más.';
    expect(correctLine(line, lexicon).text).toBe(line);
  });
});
