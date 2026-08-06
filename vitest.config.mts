import { resolve } from 'node:path';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * IMPRESCINDIBLE: `unplugin-swc`.
 *
 * El transformador por defecto de Vitest es esbuild, y esbuild NO emite
 * `design:paramtypes`. Sin esa metadata la inyección de dependencias de NestJS
 * falla en tiempo de ejecución con "Nest can't resolve dependencies of X (?)",
 * un error que no apunta a la causa real.
 *
 * SWC es el único compilador de nueva generación que soporta `legacyDecorator`
 * junto con `emitDecoratorMetadata`. No es opcional ni una optimización.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    environment: 'node',
    root: './',
    include: ['src/**/*.spec.ts'],
    // Los e2e viven aparte: necesitan contenedores y tardan órdenes de magnitud más.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      // `coverage.all` se eliminó en Vitest 4: `include` es obligatorio.
      include: ['src/**/*.ts'],
      exclude: [
        'src/main.ts',
        'src/worker.main.ts',
        '**/*.module.ts', // wiring declarativo de DI: si falla, todo e2e falla
        '**/*.dto.ts',
        '**/*.schema.ts', // declarativos, se validan en los tests de presentación
        '**/tokens.ts', // solo símbolos de inyección
        '**/index.ts', // barrels
        '**/*.event.ts',
        '**/*.command.ts',
        '**/*.query.ts',
        '**/*.exception.ts', // subclases de Error sin lógica
        'src/shared/config/**', // validado por Zod al arrancar (fail-fast)
        '**/*.d.ts',
      ],
      thresholds: {
        // Red global.
        lines: 75,
        branches: 70,
        functions: 75,
        statements: 75,

        // Umbrales por capa. El dominio es código puro: sin I/O, sin framework,
        // cada test cuesta milisegundos. Por debajo de 95% no significa
        // "faltan tests", significa código muerto o mal ubicado.
        'src/shared/domain/**': { lines: 95, branches: 90, functions: 95 },
        'src/modules/*/domain/**': { lines: 95, branches: 90, functions: 95 },
        'src/modules/*/application/**': { lines: 85, branches: 80, functions: 85 },
        'src/modules/*/infrastructure/**': { lines: 50, branches: 45, functions: 50 },

        // Riesgo fiscal y clínico: sin concesiones. Un off-by-one en el dígito
        // verificador de la clave de acceso son comprobantes rechazados en producción.
        'src/modules/facturacion-sri/domain/**': {
          lines: 100,
          branches: 100,
          functions: 100,
        },
      },
    },
  },
  resolve: {
    // Vitest NO resuelve los path aliases de TS automáticamente (Jest sí lo hacía
    // vía ts-jest + tsconfig-paths). Hay que declararlos aquí a mano.
    alias: {
      '@': resolve(__dirname, './src'),
      '@test': resolve(__dirname, './test'),
    },
  },
});
