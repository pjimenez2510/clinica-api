/**
 * What is the next piece of work, and what is stopping it.
 *
 * WHY THIS IS A SCRIPT AND NOT A PROMPT. An orchestrator that decides what to
 * do next by reading documents and forming an impression will pick a different
 * thing on Tuesday than it picked on Monday, and neither choice is auditable.
 * This computes the answer from the artefacts — deliverables declared in each
 * SPEC.md, requirements named by tests, blockers written in the spec itself —
 * so "what's next" is a fact anyone can re-derive, not a judgement call.
 *
 * It never decides anything a human has to decide. Open questions are reported
 * as blockers, never resolved.
 *
 * Usage: node --experimental-strip-types scripts/estado.mts [--json]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const MODULES_DIR = join(REPO_ROOT, 'src', 'modules');
const JSON_OUTPUT = process.argv.includes('--json');

/** `### E1 — Reservar sin pisar a nadie *(P1)*`, `### A2 — …`, `### C3 — …` */
// Prettier rewrites `*(P1)*` as `_(P1)_` when it formats the SPEC, so both
// emphasis styles must parse — the first version read only `*` and every
// priority silently became "P?" after one formatting pass.
//
// CUALQUIER LETRA, no sólo `E`. Esto se escribió cuando el único módulo con
// SPEC era `agenda` y sus entregas se llamaban E1 a E7. Al nacer los demás
// —A de `auth`, C de configuración, O de `organization`, S de `staff`— el
// guion dejó de ver NINGUNA de sus entregas, y como el informe se construye
// con lo que encuentra, cinco módulos enteramente construidos aparecían con
// sus requisitos «sin pertenecer a ninguna entrega». No faltaba trabajo:
// faltaba una letra en esta expresión, y el informe decía lo contrario con
// toda seguridad. Un estado que se equivoca callando es peor que no tenerlo.
// Y LA PRIORIDAD ADMITE COMPAÑÍA. `_(P1, ya construida en Fase 0)_` y
// `_(P1, cruza módulos)_` no casaban con `\((P\d)\)`, así que el paréntesis
// entero se quedaba dentro del título —que salía con el markdown crudo— y la
// prioridad caía a «P?». Justo en las entregas que llevan una nota es donde
// más importa leerla bien: son las excepciones.
const DELIVERABLE =
  /^###\s+([A-Z]\d+)\s+—\s+(.+?)\s*(?:[*_]\((P\d)[^)]*\)[*_])?\s*$/gm;
/** `**Cubre:** AG-001 a AG-003, AG-010 a AG-014, AG-017` */
const COVERS = /\*\*Cubre:\*\*\s*([^\n]*(?:\n(?!\s*\n|###|##)[^\n]*)*)/;
const RANGE = /\b([A-Z]{2,4})-(\d{3})\s+a\s+(?:[A-Z]{2,4}-)?(\d{3})/g;
const SINGLE = /\b([A-Z]{2,4}-\d{3})\b/g;
const DECLARATION = /^\s*[-*]\s*\*\*([A-Z]{2,4}-\d{3})\*\*/gm;
const STATE_LINE = /^\*\*Estado:\*\*\s*(\S+)/m;
const TEST_TITLE =
  /\b(?:it|test|describe)(?:\.\w+)*\s*\(\s*(['"`])([^'"`]+)\1/g;
const NEEDS_CLARIFICATION = /\[NECESITA ACLARACIÓN\][^\n]*(?:\n>\s*[^\n]*)*/g;
const MISSING_SCHEMA = /\*\*Falta esquema\.\*\*[^\n]*(?:\n>\s*[^\n]*)*/g;
const OUTCOME_PREFIXES = new Set(['SC']);

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

/**
 * Expands `AG-001 a AG-003` into the ids that actually exist.
 *
 * A range is written for humans and does not promise that every number inside
 * it was used: agenda declares AG-035 to AG-039 with no AG-034. Intersecting
 * with the declared set is what keeps a deliverable from claiming coverage of
 * requirements nobody ever wrote.
 */
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
  for (const [id] of rest.matchAll(SINGLE)) {
    if (declared.has(id)) ids.add(id);
  }
  return [...ids].sort();
}

function readTestedIds(): Set<string> {
  const tested = new Set<string>();
  for (const dir of ['src', 'test']
    .map((d) => join(REPO_ROOT, d))
    .filter(exists)) {
    for (const file of walkTypeScript(dir)) {
      for (const [, , title] of readFileSync(file, 'utf8').matchAll(
        TEST_TITLE,
      )) {
        for (const id of title?.match(SINGLE) ?? []) tested.add(id);
      }
    }
  }
  return tested;
}

interface Deliverable {
  id: string;
  title: string;
  priority: string;
  requirements: string[];
  tested: string[];
}

interface ModuleState {
  module: string;
  state: string;
  declared: number;
  deliverables: Deliverable[];
  blockers: string[];
  orphans: string[];
}

const tested = readTestedIds();
const modules: ModuleState[] = [];

for (const entry of exists(MODULES_DIR)
  ? readdirSync(MODULES_DIR, { withFileTypes: true })
  : []) {
  if (!entry.isDirectory()) continue;
  const specPath = join(MODULES_DIR, entry.name, 'SPEC.md');
  if (!exists(specPath)) continue;

  const source = readFileSync(specPath, 'utf8');
  const declared = new Set<string>();
  for (const match of source.matchAll(DECLARATION)) {
    const id = match[1];
    if (id && !OUTCOME_PREFIXES.has(id.split('-')[0] ?? '')) declared.add(id);
  }

  const deliverables: Deliverable[] = [];
  const sections = source.split(/^###\s+/m);
  for (const raw of sections.slice(1)) {
    const header = `### ${raw.split('\n')[0] ?? ''}`;
    DELIVERABLE.lastIndex = 0;
    const parsed = DELIVERABLE.exec(header);
    if (!parsed) continue;
    const covers = COVERS.exec(raw)?.[1] ?? '';
    const requirements = expand(covers, declared);
    deliverables.push({
      id: parsed[1] ?? '',
      title: parsed[2] ?? '',
      priority: parsed[3] ?? 'P?',
      requirements,
      tested: requirements.filter((id) => tested.has(id)),
    });
  }

  const covered = new Set(deliverables.flatMap((d) => d.requirements));
  modules.push({
    module: entry.name,
    state: STATE_LINE.exec(source)?.[1]?.toLowerCase() ?? 'sin-estado',
    declared: declared.size,
    deliverables,
    blockers: [
      ...(source.match(NEEDS_CLARIFICATION) ?? []),
      ...(source.match(MISSING_SCHEMA) ?? []),
    ].map((b) =>
      b
        .replace(/\s*\n>\s*/g, ' ')
        .replace(/\*\*/g, '')
        .trim(),
    ),
    orphans: [...declared].filter((id) => !covered.has(id)).sort(),
  });
}

if (JSON_OUTPUT) {
  console.log(JSON.stringify({ modules }, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------------------

if (modules.length === 0) {
  console.log(
    'Ningún módulo tiene SPEC.md todavía. Empieza con `/spec-modulo <módulo>`.',
  );
  process.exit(0);
}

for (const module of modules) {
  console.log(
    `\n■ ${module.module}  —  ${module.declared} requisitos · estado: ${module.state}`,
  );

  for (const deliverable of module.deliverables) {
    const total = deliverable.requirements.length;
    const done = deliverable.tested.length;
    const bar =
      total === 0
        ? '·'.repeat(10)
        : '█'.repeat(Math.round((done / total) * 10)).padEnd(10, '·');
    const mark = total > 0 && done === total ? '✔' : done > 0 ? '~' : ' ';
    console.log(
      `  ${mark} ${deliverable.id.padEnd(3)} ${bar} ${String(done).padStart(2)}/${String(total).padEnd(2)} ` +
        `${deliverable.priority}  ${deliverable.title}`,
    );
  }

  if (module.orphans.length > 0) {
    console.log(
      `  ⚠ ${module.orphans.length} requisitos no pertenecen a ninguna entrega: ${module.orphans.join(', ')}`,
    );
  }

  if (module.blockers.length > 0) {
    console.log(
      `  ⛔ ${module.blockers.length} bloqueos declarados en la especificación:`,
    );
    for (const blocker of module.blockers) {
      console.log(
        `     · ${blocker.slice(0, 140)}${blocker.length > 140 ? '…' : ''}`,
      );
    }
  }
}

// --- Next work, computed ---------------------------------------------------

const candidates = modules.flatMap((module) =>
  module.deliverables
    .filter(
      (d) =>
        d.requirements.length > 0 && d.tested.length < d.requirements.length,
    )
    .map((d) => ({
      module: module.module,
      blockers: module.blockers.length,
      ...d,
    })),
);

candidates.sort(
  (a, b) =>
    a.priority.localeCompare(b.priority) ||
    b.tested.length / b.requirements.length -
      a.tested.length / a.requirements.length ||
    a.id.localeCompare(b.id),
);

console.log('\n' + '─'.repeat(70));

const next = candidates[0];
if (!next) {
  console.log(
    'Sin trabajo pendiente: todas las entregas declaradas tienen sus requisitos probados.',
  );
  process.exit(0);
}

console.log(
  `SIGUIENTE: ${next.module} · ${next.id} (${next.priority}) — ${next.title}\n` +
    `           ${next.requirements.length - next.tested.length} requisitos sin prueba: ` +
    `${next.requirements
      .filter((id) => !tested.has(id))
      .slice(0, 12)
      .join(', ')}` +
    `${next.requirements.length - next.tested.length > 12 ? '…' : ''}`,
);

if (next.blockers > 0) {
  console.log(
    `\n⛔ El módulo "${next.module}" tiene ${next.blockers} bloqueos sin resolver.\n` +
      '   Léelos arriba: pueden impedir esta entrega o solo alguna de sus partes.\n' +
      '   Las decisiones de negocio y de esquema NO las toma un agente.',
  );
}

console.log(
  `\n${candidates.length} entregas pendientes en total. ` +
    'Ejecuta `/avanzar` para que el orquestador tome la siguiente.',
);
