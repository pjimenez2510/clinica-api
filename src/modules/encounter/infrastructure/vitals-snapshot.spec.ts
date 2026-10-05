import { describe, expect, it } from 'vitest';

import { vitalsRowFromSnapshot } from './prisma-encounter.repository';

/**
 * EN-211. A version is the row as `to_jsonb` wrote it the day it was replaced.
 * The table grows; an old snapshot does not. Reading it must never fail.
 */
describe('vitalsRowFromSnapshot', () => {
  it('EN-211 una instantánea anterior a una columna se lee con esa columna vacía, sin fallar', () => {
    const row = vitalsRowFromSnapshot(
      {
        encounter_id: '00000000-0000-7000-8000-000000000001',
        measured_at: new Date().toISOString(),
        weight_kg: 68.4,
      },
      new Map(),
    );

    expect(row.weightKg?.toNumber()).toBe(68.4);
    expect(row.hemoglobinCorrectedGDl).toBeNull();
    expect(row.heartRate).toBeNull();
    expect(row.heightPosition).toBeNull();
    expect(row.recordedBy).toBeNull();
    expect(row.correctedAt).toBeNull();
  });

  it('EN-211 nombra a los autores que conoce, por su id', () => {
    const author = { id: 'user-1', firstName: 'Carmen', lastName: 'Salazar' };
    const row = vitalsRowFromSnapshot(
      {
        encounter_id: '00000000-0000-7000-8000-000000000001',
        measured_at: new Date().toISOString(),
        recorded_by: 'user-1',
        corrected_by: 'user-gone',
      },
      new Map([['user-1', author]]),
    );

    expect(row.recordedBy).toEqual(author);
    expect(row.correctedBy).toBeNull();
  });
});
