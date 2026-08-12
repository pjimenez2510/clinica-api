#!/usr/bin/env node
/**
 * Last step of `pnpm verify`. Writes the stamp that `require-verify.mjs` reads.
 *
 * Because it is the last link of a `&&` chain, the stamp cannot exist unless
 * format:check, typecheck, lint:check, arch:check, migrations:check and the
 * unit suite all passed. That is the whole design: the proof of verification is
 * a side effect of verifying, not a claim anyone makes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const STAMP = join(
  resolve(import.meta.dirname, '..', '..'),
  '.claude',
  '.verify-stamp',
);

mkdirSync(dirname(STAMP), { recursive: true });
writeFileSync(STAMP, `${new Date().toISOString()}\n`);
