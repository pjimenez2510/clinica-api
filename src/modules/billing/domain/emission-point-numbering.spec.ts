import { describe, expect, it } from 'vitest';

import {
  numberingView,
  type NumberingRecord,
} from './emission-point-numbering';

const record = (over: Partial<NumberingRecord> = {}): NumberingRecord => ({
  emissionPointId: '0199a000-0000-7000-8000-000000000001',
  emissionPointCode: '001',
  emissionPointActive: true,
  documentType: '01',
  usedUpTo: 18,
  nextSequential: null,
  previousSystemLast: null,
  lastChange: null,
  ...over,
});

describe('BI-309 lo que saldrá de cada punto', () => {
  it('BI-309 sin número fijado sale el mayor usado más uno', () => {
    expect(numberingView(record()).nextToIssue).toBe(19);
    expect(numberingView(record({ usedUpTo: 0 })).nextToIssue).toBe(1);
  });

  it('BI-309 con número fijado por encima, sale ése', () => {
    expect(numberingView(record({ nextSequential: 100 })).nextToIssue).toBe(
      100,
    );
  });

  it('BI-309 un número fijado que ya se alcanzó no hace volver atrás', () => {
    // Fixed at 100 and issued up to 130: the next is 131, never 100.
    expect(
      numberingView(record({ nextSequential: 100, usedUpTo: 130 })).nextToIssue,
    ).toBe(131);
  });

  it('BI-309 avisa sólo cuando lo que saldrá no supera el último del sistema anterior', () => {
    expect(
      numberingView(record({ previousSystemLast: 19 })).belowPreviousSystem,
    ).toBe(true);
    expect(
      numberingView(record({ previousSystemLast: 18 })).belowPreviousSystem,
    ).toBe(false);
    expect(numberingView(record()).belowPreviousSystem).toBe(false);
  });
});
