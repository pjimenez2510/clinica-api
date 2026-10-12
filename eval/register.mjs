/**
 * What `src/` expects from its compiler, given to plain Node so the harness
 * can run the assistant's own code (A4) without a build and without a new
 * dependency: relative imports written without an extension resolve to the
 * `.ts` file, and a `.json` import becomes a module. `--experimental-transform-types`
 * does the rest (parameter properties).
 *
 *   node --experimental-transform-types --import ./eval/register.mjs eval/main.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const RELATIVE = /^\.\.?\//;
const HAS_EXTENSION = /\.(?:[cm]?[jt]s|json)$/;

registerHooks({
  resolve(specifier, context, next) {
    if (
      RELATIVE.test(specifier) &&
      !HAS_EXTENSION.test(specifier) &&
      context.parentURL
    ) {
      for (const suffix of ['.ts', '/index.ts']) {
        const url = new URL(specifier + suffix, context.parentURL);
        if (existsSync(fileURLToPath(url))) return next(url.href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.json')) {
      const json = readFileSync(fileURLToPath(url), 'utf8');
      return {
        format: 'module',
        shortCircuit: true,
        source: `export default ${json};`,
      };
    }
    return next(url, context);
  },
});
