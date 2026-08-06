// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'dist/**', 'coverage/**', 'prisma/migrations/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],

      /**
       * CIERRA EL AGUJERO DE FUGA DE PHI NÚMERO UNO.
       *
       * `redact` de pino opera sobre las PROPIEDADES del objeto que se loguea.
       * NO inspecciona el string del mensaje. Por tanto:
       *
       *   logger.info({ cedula }, 'consulta')      -> redactado
       *   logger.info(`consulta de ${cedula}`)     -> FUGA TOTAL
       *
       * Ninguna configuración de logging puede cubrir el segundo caso. La única
       * defensa dentro del proceso es prohibir la construcción sintáctica.
       */
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.property.name=/^(log|info|warn|error|debug|fatal|trace|verbose)$/] > TemplateLiteral[expressions.length>0]',
          message:
            'No interpoles variables en el mensaje de log: pino.redact NO inspecciona el string `msg` y esto filtraría datos de salud. Usa logger.info({ campo: valor }, "mensaje estático").',
        },
      ],
    },
  },
  {
    // El dominio no puede importar nada del framework. La regla dura la aplica
    // dependency-cruiser en CI; esto da el aviso en el editor.
    files: ['src/**/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@nestjs/*'], message: 'El dominio no conoce NestJS.' },
            { group: ['@prisma/*', 'prisma'], message: 'El dominio no conoce el ORM.' },
          ],
        },
      ],
    },
  },
  {
    // Los tests importan el runner y usan aserciones más laxas.
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      'no-restricted-imports': 'off',
    },
  },
);
