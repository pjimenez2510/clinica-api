#!/usr/bin/env node
/**
 * PostToolUse hook for Edit and Write. Formats the file that was just written.
 *
 * WHY ONLY PRETTIER, AND NO ESLINT. `pnpm verify` runs `format:check` as its
 * first gate, so a badly formatted file fails the whole pipeline over
 * whitespace — noise that hides real findings. Prettier on a single file costs
 * milliseconds. ESLint here is type-aware and costs seconds per edit, so it
 * stays in `pnpm verify` where it belongs. This hook removes noise; it does not
 * replace verification.
 *
 * Never blocks: the tool already ran, and a formatter failure is not a reason
 * to interrupt work.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, parse, resolve } from 'node:path';

const FORMATTABLE = /\.(ts|mts|json)$/;

/**
 * The package that owns the file, not the directory Claude was launched from.
 * Without this the hook is silently useless whenever the session root is the
 * parent folder that holds both repositories: prettier would run where there is
 * no package.json and no configuration.
 */
function packageRootOf(filePath) {
  let dir = dirname(resolve(filePath));
  const { root } = parse(dir);
  while (dir !== root) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return null;
}

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let filePath = '';
try {
  filePath = JSON.parse(raw)?.tool_input?.file_path ?? '';
} catch {
  process.exit(0);
}

if (!filePath || !FORMATTABLE.test(filePath) || !existsSync(filePath))
  process.exit(0);

const cwd = packageRootOf(filePath);
if (!cwd) process.exit(0);

try {
  execFileSync(
    'pnpm',
    ['exec', 'prettier', '--write', '--log-level', 'warn', filePath],
    { cwd, stdio: 'ignore', timeout: 20_000 },
  );
} catch {
  // A file prettier cannot parse is a syntax error the next gate will report
  // with a far better message than this hook could.
}

process.exit(0);
