/**
 * Keeps every module SPEC.md and the test suite from drifting apart.
 *
 * WHY THIS EXISTS. A specification that nobody verifies stops being true
 * within weeks, and an agent then works against a description of a system that
 * no longer exists — the failure mode reported everywhere spec-driven
 * development is used at scale. Prose cannot detect that. A test can.
 *
 * It fails in BOTH directions on purpose:
 *   - a requirement nobody tests is a promise with no proof;
 *   - a test citing a requirement that does not exist means the requirement was
 *     renamed or deleted and the test was left behind, still green, verifying
 *     something the specification no longer claims.
 *
 * A SPEC.md whose `**Estado:**` starts with "borrador" is only checked for
 * well-formedness. Requirements are meant to be written before the code, so a
 * draft with no tests yet is the normal state, not a failure. Promoting it to
 * "vigente" is the moment the module becomes accountable for them.
 *
 * Same shape as `error-catalogue.spec.ts`: read the source, compare, fail loud.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

// From the project root, for the same reason as `error-catalogue.spec.ts`:
// this file compiles into CommonJS output, where `import.meta` is unavailable.
const REPO_ROOT = process.cwd();
const MODULES_DIR = join(REPO_ROOT, 'src', 'modules');

/** `- **AG-001** — El sistema DEBERÁ …` — a declaration, not a mention. */
const DECLARATION = /^\s*[-*]\s*\*\*([A-Z]{2,4}-\d{3})\*\*/gm;
/**
 * Any requirement id appearing inside a test title.
 *
 * The denylist is not cosmetic: document identifiers share the shape of a
 * requirement id, and without it a test titled "… según ADR-010" is reported as
 * citing a requirement that does not exist. This test failed exactly that way
 * the first time it ran, on its own describe block.
 */
const DOCUMENT_PREFIXES = new Set(['ADR', 'RFC', 'ISO', 'IEC', 'IEEE', 'NIST']);
const REFERENCE = /\b([A-Z]{2,4})-(\d{3})\b/g;
const TEST_TITLE =
  /\b(?:it|test|describe)(?:\.\w+)*\s*\(\s*(['"`])([^'"`]+)\1/g;
const STATE_LINE = /^\*\*Estado:\*\*\s*(\S+)/m;

/**
 * Success criteria (`SC-001`) are outcomes, not behaviours: latency percentiles,
 * task completion times, "zero of X ever happens". They are declared in the same
 * SPEC.md and must still be unique and citable, but demanding a unit test for
 * each one would only produce fake tests that assert nothing. They are verified
 * by load tests, end-to-end runs or observation — evidence that lives outside
 * this suite.
 */
const OUTCOME_PREFIXES = new Set(['SC']);

const prefixOf = (id: string): string => id.split('-')[0] ?? '';

interface ModuleSpec {
  module: string;
  state: string;
  ids: string[];
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function walkTypeScript(dir: string): string[] {
  let found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found = found.concat(walkTypeScript(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

function readSpecs(): ModuleSpec[] {
  if (!exists(MODULES_DIR)) return [];

  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      module: entry.name,
      path: join(MODULES_DIR, entry.name, 'SPEC.md'),
    }))
    .filter((spec) => exists(spec.path))
    .map(({ module, path }) => {
      const source = readFileSync(path, 'utf8');
      const ids: string[] = [];
      for (const match of source.matchAll(DECLARATION)) {
        if (match[1]) ids.push(match[1]);
      }
      return {
        module,
        state: STATE_LINE.exec(source)?.[1]?.toLowerCase() ?? 'sin-estado',
        ids,
      };
    });
}

/** Requirement id → the test files whose titles name it. */
function readTestedIds(): Map<string, string[]> {
  const tested = new Map<string, string[]>();
  const files = ['src', 'test']
    .map((dir) => join(REPO_ROOT, dir))
    .filter(exists)
    .flatMap(walkTypeScript);

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const titleMatch of source.matchAll(TEST_TITLE)) {
      const title = titleMatch[2];
      if (!title) continue;
      for (const reference of title.matchAll(REFERENCE)) {
        const [id, prefix] = reference;
        if (!prefix || DOCUMENT_PREFIXES.has(prefix)) continue;
        tested.set(id, [...(tested.get(id) ?? []), relative(REPO_ROOT, file)]);
      }
    }
  }
  return tested;
}

const specs = readSpecs();
const tested = readTestedIds();
const declared = new Set(specs.flatMap((spec) => spec.ids));

describe('trazabilidad de requisitos', () => {
  it('no declara el mismo identificador de requisito dos veces', () => {
    const seen = new Set<string>();
    const duplicated: string[] = [];
    for (const id of specs.flatMap((spec) => spec.ids)) {
      if (seen.has(id)) duplicated.push(id);
      seen.add(id);
    }
    expect(
      duplicated,
      `Identificadores repetidos: ${duplicated.join(', ')}`,
    ).toEqual([]);
  });

  it('no deja ningún SPEC.md sin estado declarado', () => {
    const orphans = specs
      .filter((spec) => spec.state === 'sin-estado')
      .map((spec) => spec.module);
    expect(
      orphans,
      `Falta la línea "**Estado:** borrador|vigente" en: ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  it('no cita en una prueba ningún requisito que no exista en un SPEC.md', () => {
    const ghosts = [...tested.entries()]
      .filter(([id]) => !declared.has(id))
      .map(([id, files]) => `${id} (en ${files.join(', ')})`);
    expect(
      ghosts,
      'Estas pruebas citan requisitos inexistentes. O el requisito se renombró y la prueba ' +
        `quedó atrás, o se borró y la prueba sigue en verde probando otra cosa:\n${ghosts.join('\n')}`,
    ).toEqual([]);
  });

  // A module is accountable for its requirements the moment its SPEC.md stops
  // being a draft. Until then only the checks above apply.
  const enforced = specs.filter((spec) => !spec.state.startsWith('borrador'));

  if (enforced.length === 0) {
    it('no tiene ningún SPEC.md vigente todavía', () => {
      expect(enforced).toEqual([]);
    });
  }

  for (const spec of enforced) {
    it(`cubre con al menos una prueba cada requisito vigente de ${spec.module}`, () => {
      const uncovered = spec.ids
        .filter((id) => !OUTCOME_PREFIXES.has(prefixOf(id)))
        .filter((id) => !tested.has(id));
      expect(
        uncovered,
        `El módulo "${spec.module}" declara requisitos sin ninguna prueba que los nombre: ` +
          `${uncovered.join(', ')}.\n` +
          'Añade la prueba, o baja el SPEC.md a "**Estado:** borrador" mientras se implementa.',
      ).toEqual([]);
    });
  }
});
