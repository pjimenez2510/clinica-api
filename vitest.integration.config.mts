import { resolve } from 'node:path';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Integration suite: runs against a real PostgreSQL 18 in a container.
 *
 * Kept in its own config rather than merged with the unit suite because the two
 * have opposite requirements. Unit tests are milliseconds and run in parallel;
 * these boot a container, apply migrations and share one database, so they run
 * sequentially. Mixing them would make every `pnpm test` wait on Docker.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    environment: 'node',
    root: './',
    include: ['test/integration/**/*.spec.ts'],
    globalSetup: ['test/integration/setup/global-setup.ts'],
    // One shared database: parallel files would truncate each other's rows
    // mid-test and produce failures that do not reproduce.
    fileParallelism: false,
    // Pulling the image on a cold machine takes longer than the default.
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, './src'),
      '@test': resolve(import.meta.dirname, './test'),
    },
  },
});
