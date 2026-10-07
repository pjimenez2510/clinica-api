import { describe, expect, it } from 'vitest';

import {
  type LateArrivalRow,
  medianMinutes,
  summariseLateArrival,
} from './late-arrival-metric';

/**
 * AG-141. The report, judged without a database. The instants derive from
 * one of today's, never typed.
 */
const BASE = new Date();
const minutes = (n: number) => new Date(BASE.getTime() + n * 60_000);

function arrival(
  delay: number,
  overrides: Partial<LateArrivalRow> = {},
): LateArrivalRow {
  return {
    siteId: 'norte',
    siteName: 'Norte',
    practitionerId: 'ana',
    practitionerName: 'Ana Villacís',
    startsAt: BASE,
    checkedInAt: minutes(delay),
    graceMinutes: 15,
    ...overrides,
  };
}

describe('AG-141 la llegada tardía de un periodo', () => {
  it('AG-141 sirve la mediana, cuántas pasan el umbral y sobre cuántas', () => {
    const report = summariseLateArrival([
      arrival(-20),
      arrival(5),
      arrival(16),
      arrival(40),
      arrival(180),
    ]);
    // Three hours late moves the mean and not the median.
    expect(report.overall).toEqual({
      arrivals: 5,
      late: 3,
      medianDelayMinutes: 16,
    });
  });

  it('AG-141 el umbral es el de la sede de cada llegada, y en el borde no cuenta (como AG-119)', () => {
    const report = summariseLateArrival([
      arrival(15),
      arrival(16, { siteId: 'sur', siteName: 'Sur', graceMinutes: 30 }),
    ]);
    expect(report.overall.late).toBe(0);
    expect(report.bySite.map((site) => site.siteName)).toEqual([
      'Norte',
      'Sur',
    ]);
  });

  it('AG-141 desglosa por profesional los mismos datos, ordenados por nombre', () => {
    const report = summariseLateArrival([
      arrival(30, { practitionerId: 'pablo', practitionerName: 'Pablo Mora' }),
      arrival(10),
      arrival(20),
    ]);
    expect(report.byPractitioner).toEqual([
      expect.objectContaining({ practitionerName: 'Ana Villacís', arrivals: 2, late: 1, medianDelayMinutes: 15 }), // prettier-ignore
      expect.objectContaining({ practitionerName: 'Pablo Mora', arrivals: 1, late: 1, medianDelayMinutes: 30 }), // prettier-ignore
    ]);
  });

  it('AG-141 sin llegadas la mediana es nula, no cero', () => {
    expect(summariseLateArrival([]).overall).toEqual({
      arrivals: 0,
      late: 0,
      medianDelayMinutes: null,
    });
    expect(medianMinutes([])).toBeNull();
    expect(medianMinutes([3, 4])).toBe(4);
  });
});
