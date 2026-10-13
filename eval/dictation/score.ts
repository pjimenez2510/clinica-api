import { wilson, type Interval } from '../stats.ts';

import {
  DICTATED_FIELDS,
  type DictatedField,
  type DictationCase,
} from './cases.ts';

/** What one field of one dictation came out as (E-055's categories). */
export type Outcome = 'correct' | 'wrong' | 'empty' | 'invented' | 'empty-ok';

export interface Reading {
  signs: Partial<Record<DictatedField, number>>;
}

export interface Cell {
  id: string;
  category: string;
  arm: 'texto' | 'oido';
  voice: string;
  field: DictatedField;
  expected: number | null;
  got: number | null;
  outcome: Outcome;
  /** What was read: the phrase or what the recogniser wrote. */
  text: string;
}

/** Within half a tenth: every reading the taking keeps has one decimal at most. */
export function judge(
  expected: number | undefined,
  got: number | undefined,
): Outcome {
  if (expected === undefined)
    return got === undefined ? 'empty-ok' : 'invented';
  if (got === undefined) return 'empty';
  return Math.abs(got - expected) < 0.05 ? 'correct' : 'wrong';
}

export function cellsOf(
  item: DictationCase,
  arm: Cell['arm'],
  voice: string,
  text: string,
  reading: Reading,
): Cell[] {
  return DICTATED_FIELDS.map((field) => ({
    id: item.id,
    category: item.category,
    arm,
    voice,
    field,
    expected: item.expected[field] ?? null,
    got: reading.signs[field] ?? null,
    outcome: judge(item.expected[field], reading.signs[field]),
    text,
  }));
}

export interface Tally {
  expected: number;
  correct: number;
  wrong: number;
  empty: number;
  /** Of the fields nobody said. */
  invented: number;
  unsaid: number;
  /** SC-096: a value that is not the one said, or one nobody said. */
  serious: number;
  correctRate: Interval;
  emptyRate: Interval;
}

export function tally(cells: readonly Cell[]): Tally {
  const count = (outcome: Outcome) => cells.filter((cell) => cell.outcome === outcome).length; // prettier-ignore
  const correct = count('correct');
  const wrong = count('wrong');
  const empty = count('empty');
  const invented = count('invented');
  const expected = correct + wrong + empty;
  return {
    expected,
    correct,
    wrong,
    empty,
    invented,
    unsaid: invented + count('empty-ok'),
    serious: wrong + invented,
    correctRate: wilson(correct, expected),
    emptyRate: wilson(empty, expected),
  };
}

/** The cells grouped by one of their keys, in first-seen order. */
export function groupBy<K extends 'arm' | 'voice' | 'field' | 'category'>(
  cells: readonly Cell[],
  key: K,
): Map<Cell[K], Cell[]> {
  const groups = new Map<Cell[K], Cell[]>();
  for (const cell of cells) {
    groups.set(cell[key], [...(groups.get(cell[key]) ?? []), cell]);
  }
  return groups;
}

/** SC-095 and SC-096, written before measuring. */
export const SC095_MIN_CORRECT = 0.93;

export interface Verdict {
  sc095: boolean;
  sc096: boolean;
}

export function verdictOf(text: Tally, heard: Tally): Verdict {
  return {
    sc095: heard.expected > 0 && heard.correct / heard.expected >= SC095_MIN_CORRECT, // prettier-ignore
    sc096: text.serious === 0 && heard.serious === 0,
  };
}
