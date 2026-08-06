/**
 * Reglas de dependencia entre capas, verificadas en CI.
 *
 * Una regla arquitectónica que no está automatizada es una sugerencia: se
 * erosiona en el primer sprint con prisa. Esto la convierte en un build roto.
 *
 * Se usa dependency-cruiser en lugar de una regla de ESLint porque sobrevive a
 * los cambios de linter (ESLint 9 → flat config → oxlint) y porque ve
 * dependencias que ESLint no ve: `require()` dinámicos y ciclos entre módulos.
 */
module.exports = {
  forbidden: [
    {
      name: 'dominio-sin-infraestructura',
      severity: 'error',
      comment:
        'La capa de dominio no puede depender de infraestructura ni de presentación. ' +
        'Es la regla de dependencia de Clean Architecture: las flechas apuntan hacia adentro.',
      from: { path: '^src/(modules/[^/]+|shared)/domain' },
      to: { path: '^src/(modules/[^/]+|shared)/(infrastructure|http)' },
    },
    {
      name: 'dominio-sin-aplicacion',
      severity: 'error',
      comment: 'El dominio no conoce los casos de uso que lo orquestan.',
      from: { path: '^src/(modules/[^/]+|shared)/domain' },
      to: { path: '^src/(modules/[^/]+|shared)/application' },
    },
    {
      name: 'dominio-sin-frameworks',
      severity: 'error',
      comment:
        'El dominio debe ser TypeScript puro: sin NestJS, sin Prisma, sin SOAP, sin colas. ' +
        'Solo así se puede testear en milisegundos y reutilizar desde un worker o un CLI.',
      from: {
        path: '^src/(modules/[^/]+|shared)/domain',
        // Los tests del dominio sí importan el runner. La regla aplica al
        // código de producción, no a sus pruebas.
        pathNot: '\\.spec\\.ts$',
      },
      to: {
        dependencyTypes: ['npm', 'npm-dev'],
        // Lista de permitidos deliberadamente mínima. Ampliarla exige justificarlo.
        pathNot: '^(uuid|date-fns|@date-fns/tz|decimal\\.js)$',
      },
    },
    {
      name: 'aplicacion-sin-infraestructura',
      severity: 'error',
      comment:
        'La capa de aplicación depende de PUERTOS (interfaces), nunca de adaptadores concretos. ' +
        'El único sitio donde se tocan es el *.module.ts, que hace el wiring de DI.',
      from: { path: '^src/modules/[^/]+/application' },
      to: { path: '^src/modules/[^/]+/infrastructure' },
    },
    {
      name: 'aplicacion-sin-orm-ni-clientes',
      severity: 'error',
      comment:
        'Si un caso de uso importa Prisma o un cliente SOAP, la abstracción se rompió.',
      from: { path: '^src/modules/[^/]+/application' },
      to: {
        dependencyTypes: ['npm'],
        path: '^(@prisma/client|prisma|pg-boss|soap|ioredis|@aws-sdk)',
      },
    },
    {
      name: 'sin-imports-entre-modulos',
      severity: 'error',
      comment:
        'Los módulos de negocio se comunican por eventos o por puertos compartidos, ' +
        'nunca importándose directamente. Si hace falta, el concepto va a shared/.',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/',
        pathNot: '^src/modules/$1/',
      },
    },
    {
      name: 'sin-ciclos',
      severity: 'error',
      comment: 'Una dependencia circular es un módulo mal cortado.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'sin-huerfanos',
      severity: 'warn',
      comment: 'Archivo que nadie importa: probablemente código muerto.',
      from: {
        orphan: true,
        pathNot: ['\\.d\\.ts$', '(^|/)index\\.ts$', '^src/main', '\\.spec\\.ts$'],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: './tsconfig.json' },
    /**
     * IMPRESCINDIBLE. Sin esto, dependency-cruiser analiza el JS compilado y NO
     * ve los `import type`. Un `import type { X } from '../infrastructure/...'`
     * en el dominio pasaría inadvertido — y es la vía más común por la que la
     * infraestructura se cuela hacia adentro.
     */
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
    reporterOptions: {
      dot: { collapsePattern: 'node_modules/(@[^/]+/[^/]+|[^/]+)' },
    },
  },
};
