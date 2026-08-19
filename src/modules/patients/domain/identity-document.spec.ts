import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isDefinitiveDocument } from './identity-document';

describe('what counts as an identity document', () => {
  it('PA-015 does NOT count a PROVISIONAL marker as a document', () => {
    /**
     * `SN-001` written on the folder of an unconscious trauma case is a note,
     * not papers. Counted as a document it ends the provisional state and
     * declares the chart complete for the RDACAA with no identity document at
     * all — a monthly report row for somebody nobody can identify.
     */
    expect(isDefinitiveDocument({ type: 'PROVISIONAL' })).toBe(false);
  });

  it('PA-015 counts every real document, whoever issued it', () => {
    // A refugee card and a foreign id are documents. Refusing them would send
    // the desk back to registering migrants as provisional to get on with it,
    // which is the duplicate PA-012 already exists to prevent.
    expect(isDefinitiveDocument({ type: 'CEDULA' })).toBe(true);
    expect(isDefinitiveDocument({ type: 'PASSPORT' })).toBe(true);
    expect(isDefinitiveDocument({ type: 'REFUGEE_CARD' })).toBe(true);
    expect(isDefinitiveDocument({ type: 'FOREIGN_ID' })).toBe(true);
  });

  it('PA-014 says the same thing the partial unique index says', () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THE RULE IS THE DATABASE'S, AND THIS IS WHAT KEEPS THE COPY HONEST.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `patient_identifier_active_unique` excludes `type = 'PROVISIONAL'` from
     * uniqueness because a provisional marker identifies nobody. The predicate
     * is read from the migration rather than trusted: the day somebody decides
     * a marker does reserve a document, this file has to be decided again too.
     */
    const migrations = join(process.cwd(), 'prisma', 'migrations');
    const directory = readdirSync(migrations).find((name) =>
      name.endsWith('_clinical_core_constraints'),
    );
    expect(directory, 'the migration that creates the index').toBeDefined();

    const sql = readFileSync(
      join(migrations, directory ?? '', 'migration.sql'),
      'utf8',
    );
    const predicate = /patient_identifier_active_unique[\s\S]*?WHERE([\s\S]*?);/.exec(sql)?.[1]; // prettier-ignore
    expect(predicate, 'the index predicate').toBeDefined();
    expect(predicate).toMatch(/type\s*(<>|!=)\s*'PROVISIONAL'/);
  });
});
