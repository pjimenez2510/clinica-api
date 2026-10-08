import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * DOC-013. NO CODE PURGES AN ARCHIVED DOCUMENT.
 *
 * The database already refuses `DELETE` and `TRUNCATE` on `document_render`
 * (DOC-005, `documents-immutable.spec.ts`), and the repository offers no method
 * that tries (DOC-011). What is left is the third way a purge arrives: a job, a
 * script or another module writing the statement somebody believed was
 * allowed. Retention is a conservation policy (art. 15 of the ACESS norm and
 * the fifteen years of `site_parameter`), and the day there is one it will be a
 * decision with its own requirement — never a line slipped into `src`.
 */

const SRC = join(import.meta.dirname, '..', '..', '..');

/** What a purge of the archive looks like, through Prisma or in raw SQL. */
const PURGE = [
  /documentRender\s*\.\s*delete(?:Many)?\s*\(/,
  /DELETE\s+FROM\s+"?document_render"?/i,
  /TRUNCATE\b[^;]*\bdocument_render\b/i,
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.spec\.ts$/.test(name) ? [path] : [];
  });
}

function purgesIn(text: string): boolean {
  return PURGE.some((pattern) => pattern.test(text));
}

describe('DOC-013 el sistema no purga documentos archivados', () => {
  it('DOC-013 reconoce una purga cuando la ve (control positivo)', () => {
    expect(purgesIn('await tx.documentRender.deleteMany({ where: {} })')).toBe(true); // prettier-ignore
    expect(purgesIn('DELETE FROM document_render WHERE rendered_at < $1')).toBe(true); // prettier-ignore
    expect(purgesIn('TRUNCATE TABLE document_render')).toBe(true);
    expect(purgesIn('tx.documentRender.create({ data })')).toBe(false);
  });

  it('DOC-013 ningún código de src borra ni vacía document_render', () => {
    const files = sources(SRC);
    // The walk reached the code that writes the archive, not an empty folder.
    expect(files.map((file) => relative(SRC, file))).toContain(
      'modules/documents/infrastructure/prisma-document.repository.ts',
    );

    const offenders = files
      .filter((file) => purgesIn(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));

    expect(offenders).toEqual([]);
  });
});
