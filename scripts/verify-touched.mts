/**
 * `pnpm verify:tocado` — the gates of `pnpm verify`, limited to what this
 * branch touched. It is what the workspace Stop hook demands before a turn
 * ends; the full `pnpm verify`, with coverage, belongs to `/cerrar-entregable`
 * and runs behind `con-turno`.
 *
 * WHY. The Stop hook used to demand the full verify for a one-line change: a
 * minute of CPU and the whole coverage run every turn, on a machine several
 * sessions share. A gate that heavy gets skipped in spirit. This one runs what
 * can break because of the change: the formatting and lint of the files
 * touched, the whole type-check (types do not stay local), the architecture
 * rules, the migration checks when `prisma/` moved, the traceability, and the
 * unit tests related to the changed files.
 *
 * PLUS ONE RULE THE FULL VERIFY DOES NOT HAVE: no hand-written absolute dates
 * in lines added to tests. Commit c4e68da exists because two integration tests
 * booked «el lunes 14-09-2026» written by hand and turned red the day the
 * calendar reached it. A date in a test comes from an injected clock or is
 * computed from one. A legitimate fixed date (a birth date) carries
 * `// fecha-fija: <why>` on the same line.
 *
 * Ends by writing the verification stamp, so it exists only if every gate passed.
 *
 * Usage: node --experimental-strip-types scripts/verify-touched.mts [--base <ref>]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const baseArg = process.argv.indexOf('--base');
const BASE = baseArg > 0 ? process.argv[baseArg + 1]! : 'main';

const git = (...args: string[]): string =>
  execFileSync('git', args, { encoding: 'utf8' }).trim();

function touchedFiles(): string[] {
  const files = new Set<string>();
  let mergeBase: string;
  try {
    mergeBase = git('merge-base', 'HEAD', BASE);
  } catch {
    mergeBase = '';
  }
  if (mergeBase) {
    for (const f of git('diff', '--name-only', mergeBase).split('\n'))
      if (f) files.add(f);
  }
  for (const line of git('status', '--porcelain', '-uall').split('\n')) {
    if (!line) continue;
    files.add(line.slice(3).split(' -> ').at(-1)!.replace(/^"|"$/g, ''));
  }
  return [...files].filter((f) => existsSync(f)).sort();
}

/** Lines added to test files that write an absolute date by hand. */
function handWrittenDates(tests: string[]): string[] {
  if (tests.length === 0) return [];
  let diff: string;
  try {
    const mergeBase = git('merge-base', 'HEAD', BASE);
    diff = execFileSync('git', ['diff', '-U0', mergeBase, '--', ...tests], {
      encoding: 'utf8',
    });
  } catch {
    diff = '';
  }
  // Untracked test files have no diff: every line is new.
  const untracked = git(
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    ...tests,
  )
    .split('\n')
    .filter(Boolean);
  const added: Array<{ file: string; line: string }> = [];
  let current = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) current = line.slice(6);
    else if (line.startsWith('+') && !line.startsWith('+++'))
      added.push({ file: current, line: line.slice(1) });
  }
  for (const file of untracked) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      added.push({ file, line });
    }
  }
  const DATE =
    /(new Date\(\s*['"`]?\d{4}[-,]|Date\.UTC\(\s*\d{4}|['"`]\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?['"`])/;
  return added
    .filter(({ line }) => DATE.test(line) && !/fecha-fija:/.test(line))
    .map(({ file, line }) => `${file}: ${line.trim()}`);
}

type Step = { name: string; cmd: string[]; when: boolean };

const touched = touchedFiles();
const code = touched.filter((f) => /^(src|test|prisma|scripts)\//.test(f));

if (code.length === 0) {
  console.log(
    'verify:tocado — nada tocado en src, test, prisma ni scripts respecto a ' +
      BASE +
      '.',
  );
  execFileSync('node', ['scripts/stamp-verify.mjs']);
  process.exit(0);
}

const formattable = code.filter((f) => /\.(ts|mts|json)$/.test(f));
const lintable = code.filter((f) => /^(src|test)\/.*\.ts$/.test(f));
const testable = code.filter(
  (f) => /^(src|test)\/.*\.ts$/.test(f) && !f.startsWith('test/integration/'),
);
const tests = code.filter((f) => /\.spec\.ts$|^test\//.test(f));

const steps: Step[] = [
  {
    name: 'formato',
    cmd: ['pnpm', 'exec', 'prettier', '--check', ...formattable],
    when: formattable.length > 0,
  },
  { name: 'tipos', cmd: ['pnpm', 'exec', 'tsc', '--noEmit'], when: true },
  {
    name: 'lint',
    cmd: ['pnpm', 'exec', 'eslint', ...lintable],
    when: lintable.length > 0,
  },
  {
    name: 'arquitectura',
    cmd: ['pnpm', '-s', 'arch:check'],
    when: code.some((f) => f.startsWith('src/')),
  },
  {
    name: 'migraciones',
    cmd: ['pnpm', '-s', 'migrations:check'],
    when: code.some((f) => f.startsWith('prisma/')),
  },
  { name: 'trazabilidad', cmd: ['pnpm', '-s', 'rtm'], when: true },
  {
    name: 'pruebas relacionadas',
    cmd: [
      'pnpm',
      'exec',
      'vitest',
      'related',
      '--run',
      '--passWithNoTests',
      ...testable,
    ],
    when: testable.length > 0,
  },
];

console.log(
  `verify:tocado — ${code.length} archivos tocados respecto a ${BASE}.`,
);

const dates = handWrittenDates(tests);
if (dates.length > 0) {
  console.error(
    '✘ fechas escritas a mano en pruebas nuevas (usa un reloj inyectado, o `// fecha-fija: <por qué>`):\n  ' +
      dates.join('\n  '),
  );
  process.exit(1);
}

for (const step of steps.filter((s) => s.when)) {
  const started = Date.now();
  const result = spawnSync(step.cmd[0]!, step.cmd.slice(1), {
    stdio: 'inherit',
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    console.error(
      `✘ ${step.name} (${seconds} s) — corrígelo; no lo reportes como terminado.`,
    );
    process.exit(result.status ?? 1);
  }
  console.log(`✔ ${step.name} (${seconds} s)`);
}

execFileSync('node', ['scripts/stamp-verify.mjs']);
console.log('verify:tocado en verde. Sello escrito.');
