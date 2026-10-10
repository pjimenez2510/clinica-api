import { describe, expect, it } from 'vitest';

import { Cedula } from '../../src/shared/domain/value-objects/cedula.vo';

import { useDatabase } from './setup/database';

/**
 * PA-011. The cedula rule lives in two places that cannot share code: the
 * `Cedula` value object, which every form calls, and `is_valid_cedula()`,
 * which `patient_identifier_cedula_valid` calls for whatever arrives without
 * a form (an import, a `psql`). This sweep is what keeps them one rule: every
 * province code, both sides of the third-digit limit, every check digit.
 *
 * Without surrounding spaces: the forms trim before asking (zod and
 * `Cedula.create`), the database receives what was stored.
 */
const db = useDatabase();

function candidates(): string[] {
  const values: string[] = [];
  for (let province = 0; province <= 31; province += 1) {
    for (const third of ['0', '5', '6', '9']) {
      const base = `${String(province).padStart(2, '0')}${third}123456`;
      for (let check = 0; check <= 9; check += 1)
        values.push(`${base}${check}`);
    }
  }
  return [...values, '171003406', '17100340655', '17100340a5'];
}

describe('PA-011 una sola regla de cédula en la aplicación y en la base', () => {
  it('PA-011 is_valid_cedula() acepta exactamente las cédulas que acepta Cedula', async () => {
    const values = candidates();
    const rows = await db().$queryRaw<{ value: string; valid: boolean }[]>`
      SELECT v AS "value", is_valid_cedula(v) AS "valid"
        FROM unnest(${values}::text[]) AS v`;

    const disagreements = rows.filter(
      (row) => row.valid !== Cedula.isValid(row.value),
    );
    expect(rows).toHaveLength(values.length);
    expect(disagreements).toEqual([]);
    // Positive control: the sweep holds valid ones, not only refusals.
    expect(rows.filter((row) => row.valid).length).toBeGreaterThan(40);
  });
});
