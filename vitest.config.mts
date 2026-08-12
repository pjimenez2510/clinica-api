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
    // The integration suite lives in `test/integration/` and runs from its own
    // config: it needs containers and takes orders of magnitude longer.
    exclude: ['**/node_modules/**', '**/dist/**', 'test/**'],
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
        // Datos de semilla con forma de código: los roles por defecto se
        // insertan una vez y se editan como datos. Cubrirlos con una prueba
        // unitaria sería afirmar que una constante es igual a sí misma.
        'src/modules/auth/domain/default-roles.ts',
        '**/*.d.ts',
      ],
      /**
       * PISOS DE TRINQUETE, no aspiraciones. Los umbrales anteriores (75/95/85)
       * asumían que la suite unitaria cubre lo que en este proyecto cubren las
       * pruebas de integración —los constraints, los guards, los repositorios—
       * y como nadie ejecutaba `--coverage`, la puerta llevaba apagada desde el
       * principio (revisión de mantenibilidad, 12-08-2026). Ahora `pnpm verify`
       * la ejecuta en cada pasada, con pisos medidos ese día.
       *
       * LA REGLA: un piso solo se SUBE. Al cerrar cada entrega, si la medida
       * real supera el piso por más de 5 puntos, se sube el piso a medida-2.
       * Bajar un piso exige explicar en el commit qué cobertura se perdió y
       * por qué está bien perderla.
       */
      thresholds: {
        lines: 46,
        branches: 46,
        functions: 44,
        statements: 46,

        // shared/domain y el dominio de agenda están al 95-99: ese es el nivel
        // exigido a módulos NUEVOS. El agregado baja por auth y catalogs, cuyos
        // errores se ejercitan por integración; suben con la regla de arriba.
        'src/shared/domain/**': { lines: 95, branches: 90, functions: 95 },
        'src/modules/*/domain/**': { lines: 83, branches: 90, functions: 80 },
        'src/modules/*/application/**': {
          lines: 50,
          branches: 43,
          functions: 45,
        },
        'src/modules/*/infrastructure/**': {
          lines: 20,
          branches: 8,
          functions: 15,
        },
      },
    },
  },
  resolve: {
    // Vitest NO resuelve los path aliases de TS automáticamente (Jest sí lo hacía
    // vía ts-jest + tsconfig-paths). Hay que declararlos aquí a mano.
    alias: {
      '@': resolve(import.meta.dirname, './src'),
      '@test': resolve(import.meta.dirname, './test'),
    },
  },
});
