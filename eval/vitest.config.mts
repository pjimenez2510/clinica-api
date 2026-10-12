import { defineConfig } from 'vitest/config';

/**
 * The harness's own tests, apart from `pnpm test`: the evaluation runs outside
 * the verify (PLAN-ASISTENTE-IA §7 A6), and so do the tests of the tool that
 * runs it. `pnpm eval:test`.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: './',
    include: ['eval/**/*.spec.ts'],
    // The end-to-end run with the fake reads both catalogues from their xlsx.
    testTimeout: 60_000,
  },
});
