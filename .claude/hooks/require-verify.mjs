#!/usr/bin/env node
/**
 * Stop hook. Refuses to end the turn when code changed and `pnpm verify` has
 * not passed since.
 *
 * WHY A STAMP AND NOT A HEURISTIC. The hook does not try to guess whether a
 * verify command succeeded by reading output. `pnpm verify` ends with
 * `stamp-verify.mjs`, so the stamp file exists only if every gate before it
 * passed. No parsing, no false positives: either the pipeline reached the end
 * or the stamp is stale.
 *
 * `stop_hook_active` is honoured so a blocked turn can never loop.
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const STAMP = join(REPO, '.claude', '.verify-stamp');
const WATCHED = ['src', 'prisma', 'test'];
const CODE = /\.(ts|mts|sql)$/;

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let input = {};
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

// Already blocked once this turn. Blocking again would loop forever.
if (input.stop_hook_active) process.exit(0);

let changed = [];
try {
  // `-uall` is not optional: without it git collapses an untracked directory
  // into a single `src/modules/agenda/` entry, which matches no file extension
  // and lets an entire new module through unverified.
  const out = execFileSync(
    'git',
    ['status', '--porcelain', '-uall', '--', ...WATCHED],
    {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  changed = out
    .split('\n')
    .filter(Boolean)
    // Porcelain v1: two status chars, a space, then the path. Renames carry
    // `old -> new`; only the destination matters here.
    .map((line) => line.slice(3).split(' -> ').at(-1).replace(/^"|"$/g, ''))
    .filter((path) => CODE.test(path));
} catch {
  // Not a git repository, or git unavailable. Not this hook's problem.
  process.exit(0);
}

if (changed.length === 0) process.exit(0);

const mtime = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0; // deleted file: it cannot be newer than the stamp
  }
};

const newestChange = Math.max(
  ...changed.map((path) => mtime(join(REPO, path))),
);
const stampedAt = mtime(STAMP);

if (stampedAt >= newestChange) process.exit(0);

const listed = changed.slice(0, 8).join(', ');
const rest = changed.length > 8 ? ` y ${changed.length - 8} más` : '';

process.stderr.write(
  `No se puede cerrar el turno: hay cambios sin verificar en ${listed}${rest}.\n` +
    'Corre `pnpm verify`. Si tocaste la base de datos, además `pnpm test:integration`.\n' +
    'Si algún gate falla, corrígelo — no lo reportes como terminado.\n',
);
process.exit(2);
