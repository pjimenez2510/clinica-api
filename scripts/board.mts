/**
 * The state of the whole system, computed from its artefacts: every
 * deliverable of every SPEC.md with its backend and interface coverage, and
 * every flow of `clinica-docs/FLUJOS.md` with whether its Playwright walk
 * passed.
 *
 * WHY A MODULE. Three reports need the same answer: `pnpm estado` (what next,
 * here), `pnpm estado:proyecto` (both halves, module by module) and
 * `pnpm roadmap:check` (does the ROADMAP tell the truth). Three copies of the
 * parsing is how the previous ones drifted —the `E\d+` that only knew agenda,
 * the priority that swallowed its note— and how each fix had to be made three
 * times. The regular expressions below carry the history of those fixes.
 *
 * WHY A SOURCE. `estado` reports the working tree of whoever runs it; the
 * ROADMAP describes `main`. `gitSource(repo, 'main')` reads files out of a ref
 * without touching any checkout, so the principal session can check the ROADMAP
 * while another session has a feature branch checked out in the same folder.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// --- Sources ------------------------------------------------------------------

export interface Source {
  /** Human label: a folder, or `repo@ref`. */
  label: string;
  /** Repository-relative paths under `dir` ending in `ext`, recursively. */
  list(dir: string, ext: string): string[];
  read(path: string): string | null;
}

const SKIP = new Set(['node_modules', 'dist', '.nuxt', '.output', 'coverage']);

export function workingTree(root: string): Source {
  const walk = (dir: string, ext: string): string[] => {
    const full = join(root, dir);
    if (!existsSync(full) || !statSync(full).isDirectory()) return [];
    let found: string[] = [];
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found = found.concat(walk(path, ext));
      else if (entry.name.endsWith(ext)) found.push(path);
    }
    return found;
  };
  return {
    label: root,
    list: walk,
    read: (path) => {
      try {
        return readFileSync(join(root, path), 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/**
 * Files of `ref` without a checkout. Every text file the reports read (`.ts`,
 * `.md`, `.json`) is fetched in ONE `git cat-file --batch`: one `git show` per
 * file took thirteen seconds for both repositories, too slow for a Stop hook.
 */
export function gitSource(repo: string, ref: string): Source {
  let files: string[] = [];
  try {
    files = execFileSync(
      'git',
      ['-C', repo, 'ls-tree', '-r', '--name-only', ref],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    )
      .split('\n')
      .filter(Boolean);
  } catch {
    // A missing repository or ref used to read as «0 de 0» and pass for a state.
    throw new Error(
      `No se puede leer ${ref} en ${repo}: ¿existe el repositorio y la rama?`,
    );
  }
  const wanted = files.filter(
    (f) => /\.(ts|md|json)$/.test(f) && !f.split('/').some((s) => SKIP.has(s)),
  );
  const contents = new Map<string, string>();
  if (wanted.length > 0) {
    const out = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], {
      input: wanted.map((f) => `${ref}:${f}`).join('\n') + '\n',
      maxBuffer: 512 * 1024 * 1024,
    });
    let at = 0;
    for (const file of wanted) {
      const eol = out.indexOf(10, at);
      const header = out.subarray(at, eol).toString('utf8');
      at = eol + 1;
      const size = Number(header.split(' ')[2]);
      if (!header.includes(' blob ') || Number.isNaN(size)) continue; // «missing»
      contents.set(file, out.subarray(at, at + size).toString('utf8'));
      at += size + 1;
    }
  }
  return {
    label: `${repo}@${ref}`,
    list: (dir, ext) =>
      files.filter(
        (f) =>
          (dir === '' || f.startsWith(`${dir}/`)) &&
          f.endsWith(ext) &&
          !f.split('/').some((s) => SKIP.has(s)),
      ),
    read: (path) => contents.get(path) ?? null,
  };
}

// --- Parsing ------------------------------------------------------------------

// Both emphasis styles: prettier rewrites `*(P1)*` as `_(P1)_`.
// ANY LETTER, not just `E`: `auth`, `configuration`, `organization`, `staff`
// name theirs A, C, O, S, and the first version saw none of them.
// The priority may carry company —`_(P1, cruza módulos)_`— and must not leak
// into the title.
export const DELIVERABLE =
  /^###\s+([A-Z]\d+)\s+—\s+(.+?)\s*(?:[*_]\((P\d)[^)]*\)[*_])?\s*$/;
export const COVERS = /\*\*Cubre:\*\*\s*([^\n]*(?:\n(?!\s*\n|###|##)[^\n]*)*)/;
/**
 * `**Solo servidor:** AU-001, AU-003. Cómo se hashea…` — requirements with no
 * visible half, declared in the SPEC.md with the reason beside them. They leave
 * the INTERFACE'S DENOMINATOR, never the numerator. ONLY UP TO THE FIRST FULL
 * STOP: the explanation must be able to name other requirements without
 * declaring them (that bit once: «eso es AU-002» excluded a visible one).
 * No declaration means no discount: silence owes interface.
 */
export const SERVER_ONLY = /\*\*Solo servidor:\*\*\s*([^.]*)\./;
/**
 * `**Solo interfaz:** AU-044. Lo cuenta el navegador…` — the mirror image: a
 * requirement whose whole behaviour lives in the browser. It leaves the
 * BACKEND'S denominator, never the numerator. Same full-stop rule as above.
 */
export const SCREEN_ONLY = /\*\*Solo interfaz:\*\*\s*([^.]*)\./;
export const RANGE = /\b([A-Z]{2,4})-(\d{3})\s+a\s+(?:[A-Z]{2,4}-)?(\d{3})/g;
export const SINGLE = /\b([A-Z]{2,4}-\d{3})\b/g;
export const DECLARATION = /^\s*[-*]\s*\*\*([A-Z]{2,4}-\d{3})\*\*/gm;
export const TEST_TITLE =
  /\b(?:it|test|describe)(?:\.\w+)*\s*\(\s*(['"`])([^'"`]+)\1/g;
const ENDPOINT = /^\s+"(\/api\/[^"]+)"/gm;
const OUTCOME_PREFIXES = new Set(['SC']);
const FLOW = /^##\s+(F-\d{2})\s+—\s+(.+?)\s*$/;
const FLOW_ACTOR = /\*\*Quién · cuándo:\*\*\s*([^,(\n]+)/;
const FLOW_DELIVERABLES =
  /\*\*Entregas:\*\*\s*([^\n]*(?:\n(?!\s*\n|\*\*)[^\n]*)*)/;
const FLOW_WALK = /\*\*Recorrido:\*\*\s*`([^`]+)`/;

/** A range yields only the ids actually declared, so a gap is never invented. */
export function expand(text: string, declared: Set<string>): string[] {
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

/** Requirement ids named by test titles in the given files. */
function testedBy(source: Source, dirs: string[]): Set<string> {
  const tested = new Set<string>();
  for (const dir of dirs) {
    for (const file of source.list(dir, '.ts')) {
      for (const [, , title] of (source.read(file) ?? '').matchAll(
        TEST_TITLE,
      )) {
        for (const id of title?.match(SINGLE) ?? []) tested.add(id);
      }
    }
  }
  return tested;
}

/**
 * Whether the API exposes a module. Endpoints are `/api/v1/<segment>/…`, and
 * the segment is the plural resource while the folder is the singular module:
 * `encounters` ↔ `encounter`, `prescriptions` ↔ `prescription`. Comparing them
 * verbatim printed «la API aún no expone endpoints» for two modules whose
 * endpoints were in the contract — a false negative that sent work to the
 * backend that was already done.
 */
export function isExposed(module: string, segments: Set<string>): boolean {
  return (
    segments.has(module) ||
    segments.has(`${module}s`) ||
    (module.endsWith('s') && segments.has(module.slice(0, -1)))
  );
}

// --- The board ------------------------------------------------------------------

export type DeliverableState =
  | 'completo'
  | 'interfaz parcial'
  | 'falta interfaz'
  | 'backend en curso'
  | 'sin empezar';

export interface Deliverable {
  module: string;
  id: string;
  title: string;
  priority: string;
  /** All requirements the deliverable covers. */
  total: number;
  /** Of those, named by a backend test. */
  back: number;
  /** Requirements with a visible half (total minus server-only). */
  frontTotal: number;
  /** Of those, named by an interface test. */
  front: number;
  state: DeliverableState;
}

export interface ModuleBoard {
  module: string;
  apiExposed: boolean;
  deliverables: Deliverable[];
}

export function computeBoard(api: Source, web: Source): ModuleBoard[] {
  const backendTested = testedBy(api, ['src', 'test']);
  const frontendTested = testedBy(web, ['app']);
  const contract = web.read('app/shared/api/schema.d.ts') ?? '';
  const segments = new Set(
    [...contract.matchAll(ENDPOINT)]
      .map((m) => (m[1] ?? '').split('/')[3] ?? '')
      .filter(Boolean),
  );

  const specs = api
    .list('src/modules', 'SPEC.md')
    .filter((f) => /^src\/modules\/[^/]+\/SPEC\.md$/.test(f))
    .sort();

  return specs.map((spec) => {
    const module = spec.split('/')[2]!;
    const source = api.read(spec) ?? '';
    const declared = new Set<string>();
    for (const m of source.matchAll(DECLARATION)) {
      const id = m[1];
      if (id && !OUTCOME_PREFIXES.has(id.split('-')[0] ?? '')) declared.add(id);
    }
    const deliverables: Deliverable[] = [];
    for (const raw of source.split(/^###\s+/m).slice(1)) {
      const parsed = DELIVERABLE.exec(`### ${raw.split('\n')[0] ?? ''}`);
      if (!parsed) continue;
      const requirements = expand(COVERS.exec(raw)?.[1] ?? '', declared);
      if (requirements.length === 0) continue;
      const serverOnly = new Set(
        expand(SERVER_ONLY.exec(raw)?.[1] ?? '', declared),
      );
      const screenOnly = new Set(
        expand(SCREEN_ONLY.exec(raw)?.[1] ?? '', declared),
      );
      const visible = requirements.filter((id) => !serverOnly.has(id));
      const served = requirements.filter((id) => !screenOnly.has(id));
      const back = served.filter((id) => backendTested.has(id)).length;
      const front = visible.filter((id) => frontendTested.has(id)).length;
      const total = served.length;
      const frontTotal = visible.length;
      /**
       * COMPLETE IS COMPLETE ON BOTH SIDES. This once read `back === total &&
       * front > 0`: one interface test over twenty-six requirements printed
       * «completo», three lines above a legend saying the opposite.
       */
      const state: DeliverableState =
        back === total && front === frontTotal
          ? 'completo'
          : back === total && front > 0
            ? 'interfaz parcial'
            : back === total
              ? 'falta interfaz'
              : back > 0
                ? 'backend en curso'
                : 'sin empezar';
      deliverables.push({
        module,
        id: parsed[1] ?? '',
        title: parsed[2] ?? '',
        priority: parsed[3] ?? 'P?',
        total,
        back,
        frontTotal,
        front,
        state,
      });
    }
    return { module, apiExposed: isExposed(module, segments), deliverables };
  });
}

// --- The flows --------------------------------------------------------------------

export interface WalkResult {
  /** Did every test naming the flow pass on the last run that included it? */
  passed: boolean;
  /** `YYYY-MM-DD`, in America/Guayaquil. */
  date: string;
  tests: number;
  /** HEAD of the interface checkout that ran the walk. */
  commit?: string;
  /** Whether that checkout had uncommitted changes: then HEAD is not what ran. */
  dirty?: boolean;
}

export interface Flow {
  id: string;
  title: string;
  actor: string;
  /** `module/ID` as written in FLUJOS.md. */
  deliverables: string[];
  complete: number;
  known: number;
  walk: string;
  walkExists: boolean;
  result: WalkResult | null;
  /** On screen means: the walk exists and passed. Nothing else counts. */
  reachable: boolean;
}

/**
 * `ranOn(result)` decides whether a recorded walk counts. `pnpm estado` accepts
 * any (it reports the working tree); the ROADMAP accepts only walks whose
 * commit is in `main` and ran on a clean tree — otherwise «en pantalla en main»
 * would mean «passed somewhere, once».
 */
export function computeFlows(
  docs: Source,
  web: Source,
  board: ModuleBoard[],
  ranOn: (result: WalkResult) => boolean = () => true,
): Flow[] {
  const text = docs.read('FLUJOS.md') ?? '';
  let results: Record<string, WalkResult> = {};
  try {
    results = JSON.parse(web.read('e2e/estado-flujos.json') ?? '{}');
  } catch {
    results = {};
  }
  const byKey = new Map<string, Deliverable>(
    board.flatMap((m) =>
      m.deliverables.map((d): [string, Deliverable] => [
        `${m.module}/${d.id}`,
        d,
      ]),
    ),
  );
  return text
    .split(/^(?=##\s+F-\d{2})/m)
    .map((chunk) => {
      const head = FLOW.exec(chunk.split('\n')[0] ?? '');
      if (!head) return null;
      const id = head[1]!;
      const deliverables = [
        ...(FLOW_DELIVERABLES.exec(chunk)?.[1] ?? '').matchAll(
          /([a-z-]+\/[A-Z]\d+)/g,
        ),
      ].map((m) => m[1]!);
      const known = deliverables
        .map((k) => byKey.get(k))
        .filter(Boolean) as Deliverable[];
      const walk = FLOW_WALK.exec(chunk)?.[1] ?? '';
      const walkInWeb = walk.replace(/^clinica-web\//, '');
      const walkExists = walk !== '' && web.read(walkInWeb) !== null;
      const result = results[id] ?? null;
      return {
        id,
        title: head[2]!,
        actor: (FLOW_ACTOR.exec(chunk)?.[1] ?? '').trim(),
        deliverables,
        complete: known.filter((d) => d.state === 'completo').length,
        known: known.length,
        walk,
        walkExists,
        result,
        reachable: walkExists && result?.passed === true && ranOn(result),
      };
    })
    .filter((f): f is Flow => f !== null);
}

// --- Where things are ---------------------------------------------------------------

/** `clinica-api` next to `clinica-web` and `clinica-docs`, from any checkout. */
export function workspaceOf(apiCheckout: string): {
  api: string;
  web: string;
  docs: string;
} {
  const parent = resolve(apiCheckout, '..');
  return {
    api: apiCheckout,
    web: join(parent, 'clinica-web'),
    docs: join(parent, 'clinica-docs'),
  };
}

export const shortPath = (from: string, to: string): string =>
  relative(from, to) || '.';
