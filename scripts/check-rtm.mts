/**
 * Requirements traceability matrix: normativa → REQ-### → <MOD>-### → prueba.
 *
 * WHY IT IS GENERATED AND NOT WRITTEN. A traceability matrix maintained by hand
 * is wrong within weeks, and a wrong matrix is worse than none: it answers "is
 * this covered?" with confidence and no evidence. This script derives the whole
 * thing from the three artefacts that are already the source of truth, and
 * fails when they disagree.
 *
 * Two failure modes are hard errors:
 *   - a REQ refined by a module requirement that does not exist, which means the
 *     requirement was renamed or deleted and REQUISITOS.md still points at it;
 *   - the summary table in REQUISITOS.md being stale.
 *
 * A REQ with no refinement at all is NOT an error. Most of this system is not
 * built yet, and making that visible is the point of the document.
 *
 * Usage:
 *   node --experimental-strip-types scripts/check-rtm.mts           # check
 *   node --experimental-strip-types scripts/check-rtm.mts --write   # regenerate
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = process.cwd();
const DOCS = resolve(REPO_ROOT, '..', 'clinica-docs');
const REQUIREMENTS_FILE = join(DOCS, 'REQUISITOS.md');
const MODULES_DIR = join(REPO_ROOT, 'src', 'modules');
const WRITE = process.argv.includes('--write');

/**
 * Explicit delimiters, and not "from this heading to that phrase".
 *
 * The first version used the literal `pnpm rtm` as the end marker — which the
 * generated block itself contains, so each run truncated at its own output and
 * the check never converged. A generated region has to be delimited by
 * something that cannot appear inside it.
 */
const SUMMARY_START = '<!-- RTM:INICIO';
const SUMMARY_END = '<!-- RTM:FIN -->';

/** `| **REQ-001** | text | origin | AG-020, AG-021 |` */
const REQ_ROW = /^\|\s*\*\*(REQ-\d{3})\*\*\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/gm;
/** `- **AG-001** — …` inside a module SPEC.md */
const SPEC_DECLARATION = /^\s*[-*]\s*\*\*([A-Z]{2,4}-\d{3})\*\*/gm;
const ID = /\b[A-Z]{2,4}-\d{3}\b/g;
const TEST_TITLE =
  /\b(?:it|test|describe)(?:\.\w+)*\s*\(\s*(['"`])([^'"`]+)\1/g;

/**
 * The area a REQ is grouped under, by the number bands of the sections of
 * REQUISITOS.md. Only the number is read: a REQ numbered outside its
 * section's band is grouped by its number, not by where it is written.
 */
const AREA_OF = (n: number): string =>
  n < 20
    ? 'Historia clínica'
    : n < 40
      ? 'Reporte estadístico'
      : n < 50
        ? 'Habilitación'
        : n < 70
          ? 'Prescripción'
          : n < 80
            ? 'Certificados e IESS'
            : n < 110
              ? 'Facturación'
              : n < 140
                ? 'Protección de datos'
                : n < 160
                  ? 'Agenda y operación'
                  : 'No funcionales';

const AREAS = [
  'Historia clínica',
  'Reporte estadístico',
  'Habilitación',
  'Prescripción',
  'Certificados e IESS',
  'Facturación',
  'Protección de datos',
  'Agenda y operación',
  'No funcionales',
];

/** `statSync` throws on a missing path; this answers `false` instead. */
function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Every `.ts` file under `dir`, recursively, skipping `node_modules` and `dist`. */
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

/** Every requirement id declared by a module SPEC.md. */
function readModuleRequirements(): Map<string, string> {
  const owner = new Map<string, string>();
  if (!exists(MODULES_DIR)) return owner;

  for (const entry of readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const spec = join(MODULES_DIR, entry.name, 'SPEC.md');
    if (!exists(spec)) continue;
    for (const match of readFileSync(spec, 'utf8').matchAll(SPEC_DECLARATION)) {
      if (match[1]) owner.set(match[1], entry.name);
    }
  }
  return owner;
}

/** Every requirement id named by a test title. */
function readTestedIds(): Set<string> {
  const tested = new Set<string>();
  for (const dir of ['src', 'test']
    .map((d) => join(REPO_ROOT, d))
    .filter(exists)) {
    for (const file of walkTypeScript(dir)) {
      for (const [, , title] of readFileSync(file, 'utf8').matchAll(
        TEST_TITLE,
      )) {
        for (const id of title?.match(ID) ?? []) tested.add(id);
      }
    }
  }
  return tested;
}

// ---------------------------------------------------------------------------

if (!exists(REQUIREMENTS_FILE)) {
  console.log(
    'RTM: `../clinica-docs/REQUISITOS.md` no está presente. Se omite.\n' +
      '     Es lo normal al clonar `clinica-api` por separado; no es un fallo.',
  );
  process.exit(0);
}

const source = readFileSync(REQUIREMENTS_FILE, 'utf8');
const moduleRequirements = readModuleRequirements();
const tested = readTestedIds();

/** One row of the REQ table: its id, its area and the module requirements it names as refinements. */
interface Requirement {
  id: string;
  area: string;
  refinements: string[];
}

const requirements: Requirement[] = [];
for (const row of source.matchAll(REQ_ROW)) {
  const id = row[1] ?? '';
  const refinements = (row[4] ?? '').match(ID) ?? [];
  requirements.push({
    id,
    area: AREA_OF(Number(id.slice(4))),
    refinements: [...refinements],
  });
}

if (requirements.length === 0) {
  console.error(
    'RTM: no se encontró ninguna fila `| **REQ-###** |` en REQUISITOS.md.',
  );
  process.exit(1);
}

// --- Hard error: a REQ pointing at a module requirement that does not exist ---
const ghosts = requirements.flatMap((requirement) =>
  requirement.refinements
    .filter((id) => !moduleRequirements.has(id))
    .map((id) => `${requirement.id} → ${id}`),
);

// --- Summary, derived ---
const counts = new Map<
  string,
  { total: number; refined: number; tested: number }
>();
for (const area of AREAS) counts.set(area, { total: 0, refined: 0, tested: 0 });

for (const requirement of requirements) {
  const bucket = counts.get(requirement.area);
  if (!bucket) continue;
  bucket.total += 1;
  if (requirement.refinements.length > 0) bucket.refined += 1;
  if (requirement.refinements.some((id) => tested.has(id))) bucket.tested += 1;
}

const summary = [
  `${SUMMARY_START} — generado por \`pnpm rtm:write\`. Todo lo que hay entre estos dos`,
  '     marcadores se reescribe; editarlo a mano se pierde en la siguiente pasada. -->',
  '',
  '| Área | REQ | Con refinamiento | Con prueba |',
  '|---|---|---|---|',
  ...AREAS.map((area) => {
    const c = counts.get(area) ?? { total: 0, refined: 0, tested: 0 };
    return `| ${area} | ${c.total} | ${c.refined} | ${c.tested} |`;
  }),
  `| **Total** | **${requirements.length}** | **${requirements.filter((r) => r.refinements.length > 0).length}** | **${requirements.filter((r) => r.refinements.some((id) => tested.has(id))).length}** |`,
  '',
].join('\n');

const start = source.indexOf(SUMMARY_START);
const end = source.indexOf(SUMMARY_END, start);
if (start === -1 || end === -1) {
  console.error(
    `RTM: no se encontraron los marcadores "${SUMMARY_START} … ${SUMMARY_END}" en REQUISITOS.md.`,
  );
  process.exit(1);
}

const rebuilt = source.slice(0, start) + summary + source.slice(end);
const stale = rebuilt !== source;

if (WRITE && stale) {
  writeFileSync(REQUIREMENTS_FILE, rebuilt);
  console.log('RTM: resumen de REQUISITOS.md regenerado.');
}

// --- Report ---
const refined = requirements.filter((r) => r.refinements.length > 0).length;
const withTest = requirements.filter((r) =>
  r.refinements.some((id) => tested.has(id)),
).length;

console.log(
  `RTM: ${requirements.length} requisitos de sistema · ${refined} refinados en un SPEC.md · ` +
    `${withTest} con al menos una prueba que los alcanza.`,
);
console.log(
  `     ${moduleRequirements.size} requisitos de módulo declarados, ${tested.size} nombrados por alguna prueba.`,
);

if (ghosts.length > 0) {
  console.error(
    '\nRTM: REQUISITOS.md apunta a requisitos de módulo que no existen.\n' +
      'O se renombraron y el documento quedó atrás, o se borraron y la trazabilidad es falsa:\n  ' +
      ghosts.join('\n  '),
  );
  process.exit(1);
}

if (stale && !WRITE) {
  console.error(
    '\nRTM: el resumen de REQUISITOS.md está desactualizado. Corre `pnpm rtm:write`.',
  );
  process.exit(1);
}

process.exit(0);
