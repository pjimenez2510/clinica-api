import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DOMAIN_ERROR_CODES } from './error-catalogue';

/**
 * Keeps the frozen catalogue honest against the source.
 *
 * Reading the files is deliberate: the alternative is importing every error
 * class, which would make this test drag in NestJS, Prisma and the whole
 * application graph to check a list of strings. What matters is that the two
 * cannot drift, and a regex over `readonly code = '…'` is exactly as reliable
 * as the convention it reads — which the linter already enforces.
 */
// From the project root, not `import.meta.dirname`: this file compiles into
// CommonJS output, where `import.meta` is not allowed. Vitest runs from the
// project root, and if that ever stops being true the "finds the error classes
// at all" assertion below fails loudly instead of passing on an empty walk.
const SOURCE_ROOT = join(process.cwd(), 'src');

function collectDeclaredCodes(): { code: string; file: string }[] {
  const found: { code: string; file: string }[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) {
        continue;
      }
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/readonly code = '([^']+)'/g)) {
        found.push({ code: match[1], file: path.replace(SOURCE_ROOT, 'src') });
      }
    }
  };

  walk(SOURCE_ROOT);
  return found;
}

describe('the public error catalogue', () => {
  const declared = collectDeclaredCodes();

  it('finds the error classes at all', () => {
    // If the walk breaks, every assertion below passes vacuously.
    expect(declared.length).toBeGreaterThan(10);
  });

  it('declares no code twice', () => {
    /**
     * The failure this prevents, which had already happened:
     * `SITE_SCOPE_DENIED` was declared by two classes at once. Clients branch
     * on the code, so two errors answering the same one is two different
     * situations a client cannot tell apart.
     */
    const seen = new Map<string, string[]>();
    for (const { code, file } of declared) {
      seen.set(code, [...(seen.get(code) ?? []), file]);
    }

    const duplicated = [...seen.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([code, files]) => `${code} in ${files.join(' and ')}`);

    expect(duplicated).toEqual([]);
  });

  it('matches the frozen catalogue exactly', () => {
    // Renaming a code is a line in a diff somebody reviews, not a silent
    // change that breaks an integrator's alert.
    const inSource = [...new Set(declared.map((d) => d.code))].sort();
    expect(inSource).toEqual([...DOMAIN_ERROR_CODES].sort());
  });

  it('uses SCREAMING_SNAKE_CASE throughout', () => {
    for (const code of DOMAIN_ERROR_CODES) {
      expect(code, `${code} is not SCREAMING_SNAKE_CASE`).toMatch(
        /^[A-Z][A-Z0-9_]*$/,
      );
    }
  });
});
