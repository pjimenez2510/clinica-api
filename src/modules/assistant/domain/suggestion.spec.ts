import { describe, expect, it } from 'vitest';

import { SuggestionAlreadyDecidedError } from './assistant.errors';
import {
  decisionOf,
  normalisedEditDistance,
  type SuggestionView,
} from './suggestion';

const proposed = (overrides: Partial<SuggestionView> = {}): SuggestionView => ({
  id: 'suggestion-1',
  encounterId: 'encounter-1',
  aiRunId: 'run-1',
  kind: 'note-section',
  proposal: { section: 'motivoConsulta', text: 'Cefalea de tres días' },
  sources: [{ kind: 'transcript', fromMs: 1_000, toMs: 4_000 }],
  status: 'PROPOSED',
  distance: null,
  record: null,
  proposedAt: new Date(0),
  decidedBy: null,
  decidedAt: null,
  ...overrides,
});

describe('a suggestion of the assistant (AS-021 to AS-023)', () => {
  it('AS-022 the distance is the edit distance over the longer text, from 0 to 1', () => {
    expect(normalisedEditDistance('Cefalea', 'Cefalea')).toBe(0);
    expect(normalisedEditDistance('', '')).toBe(0);
    expect(normalisedEditDistance('abcd', 'abcf')).toBe(0.25);
    expect(normalisedEditDistance('abc', '')).toBe(1);
    expect(normalisedEditDistance('kitten', 'sitting')).toBeCloseTo(3 / 7);
  });

  it('AS-021 AS-022 a section kept as proposed is ACCEPTED with distance 0 and links the note', () => {
    expect(
      decisionOf(proposed(), {
        outcome: 'accept',
        recordId: 'note-1',
        saved: 'Cefalea de tres días',
      }),
    ).toEqual({
      status: 'ACCEPTED',
      distance: 0,
      record: { kind: 'clinical_note', id: 'note-1' },
    });
  });

  it('AS-022 a section the doctor changed is ACCEPTED_WITH_CHANGES with its distance, whatever the caller thinks', () => {
    const decision = decisionOf(proposed(), {
      outcome: 'accept',
      recordId: 'note-1',
      saved: 'Cefalea de dos días',
    });
    expect(decision.status).toBe('ACCEPTED_WITH_CHANGES');
    expect(decision.distance).toBeGreaterThan(0);
    expect(decision.distance).toBeLessThanOrEqual(1);
  });

  it('AS-022 a diagnosis counts 0 when the saved code is one of those proposed, and 1 when it is not', () => {
    const diagnosis = proposed({
      kind: 'diagnosis',
      proposal: { problem: 'Cefalea', codes: ['R51', 'G44.2'] },
    });
    expect(
      decisionOf(diagnosis, {
        outcome: 'accept',
        recordId: 'd-1',
        saved: 'G44.2',
      }),
    ).toEqual({
      status: 'ACCEPTED',
      distance: 0,
      record: { kind: 'encounter_diagnosis', id: 'd-1' },
    });
    expect(
      decisionOf(diagnosis, {
        outcome: 'accept',
        recordId: 'd-1',
        saved: 'G43.9',
      }),
    ).toMatchObject({ status: 'ACCEPTED_WITH_CHANGES', distance: 1 });
    // One code instead of a list says the same.
    expect(
      decisionOf(proposed({ kind: 'diagnosis', proposal: { code: 'R51' } }), {
        outcome: 'accept',
        recordId: 'd-1',
        saved: 'R51',
      }),
    ).toMatchObject({ status: 'ACCEPTED', distance: 0 });
  });

  it('AS-021 each kind links the record of its own table', () => {
    for (const [kind, table] of [
      ['prescription-item', 'prescription'],
      ['order-item', 'service_order'],
    ] as const) {
      expect(
        decisionOf(proposed({ kind, proposal: { text: 'x' } }), {
          outcome: 'accept',
          recordId: 'r-1',
          saved: 'x',
        }).record,
      ).toEqual({ kind: table, id: 'r-1' });
    }
  });

  it('AS-021 a discarded one links nothing and has no distance', () => {
    expect(decisionOf(proposed(), { outcome: 'discard' })).toEqual({
      status: 'DISCARDED',
      distance: null,
      record: null,
    });
  });

  it('AS-023 a decided one is not decided again', () => {
    for (const status of [
      'ACCEPTED',
      'ACCEPTED_WITH_CHANGES',
      'DISCARDED',
    ] as const) {
      expect(() =>
        decisionOf(proposed({ status }), { outcome: 'discard' }),
      ).toThrow(SuggestionAlreadyDecidedError);
    }
  });
});
