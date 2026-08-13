/**
 * One board for the whole system: backend and interface, module by module.
 *
 * WHY A THIRD SCRIPT. `pnpm estado` in each repository answers "what do I do
 * next here". Neither answers "is this module finished", which is the only
 * question that matters when the goal is a clinic that can actually operate: a
 * booking endpoint nobody can reach from a screen is not a delivered feature.
 * This reads both sides and reports the pair.
 *
 * A deliverable is DONE only when both halves have tests naming its
 * requirements. Backend-only shows as half, never as complete.
 *
 * Usage: node --experimental-strip-types scripts/estado-proyecto.mts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const API = process.cwd();
const WEB = resolve(API, '..', 'clinica-web');
const MODULES = join(API, 'src', 'modules');
const CONTRACT = join(WEB, 'app', 'shared', 'api', 'schema.d.ts');

// Both emphasis styles: prettier rewrites `*(P1)*` as `_(P1)_`.
//
// CUALQUIER LETRA, no sólo `E`: ver la nota extensa en `estado.mts`. Aquí el
// efecto era aún más engañoso, porque este informe dice cuántas entregas están
// completas «de punta a punta» — y contaba sobre siete, las de `agenda`, como
// si `auth`, `organization`, `specialties`, `staff` y `configuration` no
// tuvieran ninguna.
// La prioridad admite compañía —`_(P1, cruza módulos)_`—; ver `estado.mts`.
const DELIVERABLE =
  /^###\s+([A-Z]\d+)\s+—\s+(.+?)\s*(?:[*_]\((P\d)[^)]*\)[*_])?\s*$/;
const COVERS = /\*\*Cubre:\*\*\s*([^\n]*(?:\n(?!\s*\n|###|##)[^\n]*)*)/;
const RANGE = /\b([A-Z]{2,4})-(\d{3})\s+a\s+(?:[A-Z]{2,4}-)?(\d{3})/g;
const SINGLE = /\b([A-Z]{2,4}-\d{3})\b/g;
const DECLARATION = /^\s*[-*]\s*\*\*([A-Z]{2,4}-\d{3})\*\*/gm;
const TEST_TITLE =
  /\b(?:it|test|describe)(?:\.\w+)*\s*\(\s*(['"`])([^'"`]+)\1/g;
const ENDPOINT = /^\s+"(\/api\/[^"]+)"/gm;
const OUTCOME_PREFIXES = new Set(['SC']);

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function walk(dir: string, ext: string): string[] {
  if (!exists(dir)) return [];
  let found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === '.nuxt'
    )
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found = found.concat(walk(full, ext));
    else if (entry.name.endsWith(ext)) found.push(full);
  }
  return found;
}

/** Requirement ids named by test titles under the given roots. */
function testedIn(roots: string[]): Set<string> {
  const tested = new Set<string>();
  for (const root of roots) {
    for (const file of walk(root, '.ts')) {
      for (const [, , title] of readFileSync(file, 'utf8').matchAll(
        TEST_TITLE,
      )) {
        for (const id of title?.match(SINGLE) ?? []) tested.add(id);
      }
    }
  }
  return tested;
}

function expand(text: string, declared: Set<string>): string[] {
  const ids = new Set<string>();
  let rest = text;
  for (const [whole, prefix, from, to] of [...text.matchAll(RANGE)]) {
    for (let n = Number(from); n <= Number(to); n += 1) {
      const id = `${prefix}-${String(n).padStart(3, '0')}`;
      if (declared.has(id)) ids.add(id);
    }
    rest = rest.replace(whole, ' ');
  }
  for (const [id] of rest.matchAll(SINGLE)) if (declared.has(id)) ids.add(id);
  return [...ids].sort();
}

const backendTested = testedIn([join(API, 'src'), join(API, 'test')]);
const frontendTested = testedIn([join(WEB, 'app')]);

const contract = exists(CONTRACT) ? readFileSync(CONTRACT, 'utf8') : '';
const exposed = new Set(
  [...contract.matchAll(ENDPOINT)]
    .map((m) => (m[1] ?? '').split('/')[3] ?? '')
    .filter(Boolean),
);

const bar = (done: number, total: number): string =>
  total === 0
    ? '····'
    : '█'.repeat(Math.round((done / total) * 4)).padEnd(4, '·');

console.log('\n  MÓDULO / ENTREGA            BACKEND      INTERFAZ     ESTADO');
console.log('  ' + '─'.repeat(66));

let totalDeliverables = 0;
let complete = 0;

for (const entry of exists(MODULES)
  ? readdirSync(MODULES, { withFileTypes: true })
  : []) {
  if (!entry.isDirectory()) continue;
  const spec = join(MODULES, entry.name, 'SPEC.md');
  if (!exists(spec)) continue;

  const source = readFileSync(spec, 'utf8');
  const declared = new Set<string>();
  for (const m of source.matchAll(DECLARATION)) {
    const id = m[1];
    if (id && !OUTCOME_PREFIXES.has(id.split('-')[0] ?? '')) declared.add(id);
  }

  const apiReady = exposed.has(entry.name);
  console.log(
    `\n  ■ ${entry.name}${apiReady ? '' : '   (la API aún no expone endpoints)'}`,
  );

  for (const raw of source.split(/^###\s+/m).slice(1)) {
    const parsed = DELIVERABLE.exec(`### ${raw.split('\n')[0] ?? ''}`);
    if (!parsed) continue;
    const requirements = expand(COVERS.exec(raw)?.[1] ?? '', declared);
    if (requirements.length === 0) continue;

    const back = requirements.filter((id) => backendTested.has(id)).length;
    const front = requirements.filter((id) => frontendTested.has(id)).length;
    const total = requirements.length;

    totalDeliverables += 1;
    const done = back === total && front > 0;
    if (done) complete += 1;

    const estado = done
      ? 'completo'
      : back === total
        ? 'falta interfaz'
        : back > 0
          ? 'backend en curso'
          : 'sin empezar';

    console.log(
      `    ${(parsed[1] ?? '').padEnd(3)} ${(parsed[2] ?? '').slice(0, 22).padEnd(23)}` +
        `${bar(back, total)} ${String(back).padStart(2)}/${String(total).padEnd(2)}  ` +
        `${bar(front, total)} ${String(front).padStart(2)}/${String(total).padEnd(2)}  ${estado}`,
    );
  }
}

console.log('\n  ' + '─'.repeat(66));
console.log(
  `  ${complete} de ${totalDeliverables} entregas completas de punta a punta.\n` +
    '  Una entrega está completa cuando sus requisitos tienen prueba en los DOS lados.\n' +
    '  Un endpoint al que nadie llega desde una pantalla no es una función entregada.\n',
);
