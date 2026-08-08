import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Crea una migración VACÍA para escribirla a mano.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ `prisma migrate dev` ESTÁ PROHIBIDO EN ESTE REPOSITORIO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `migrate dev` compara `schema.prisma` con la base y genera el SQL que haga
 * falta para que la base se PAREZCA AL ESQUEMA. Eso es correcto cuando el
 * esquema puede describir la base entera. Aquí no puede:
 *
 *   - `patient.search_name` y `catalog_concept.search_display` son columnas
 *     GENERADAS por PostgreSQL.
 *   - `patient_search_name_trgm` y `catalog_concept_search_trgm` son índices
 *     GIN con `gin_trgm_ops`.
 *   - `access_audit_occurred_brin` es BRIN.
 *   - `clinical_note_chain_version_unique` es un índice único parcial.
 *   - Las restricciones EXCLUDE de la agenda y los disparadores de
 *     inmutabilidad.
 *
 * Nada de eso cabe en `schema.prisma`, así que Prisma los lee como cosas que
 * SOBRAN en la base y propone borrarlos. No es un fallo suyo: es la
 * consecuencia documentada de usar SQL más allá de su lenguaje de esquema.
 *
 * Ha ocurrido tres veces. Las dos primeras se detectaron leyendo el SQL antes
 * de aplicarlo; la tercera se aplicó, y se llevó por delante `search_name`,
 * cuatro índices y `clinical_note_chain_version_unique` —que es una garantía
 * médico-legal, no una optimización—. `migrations:check` la detecta, pero se
 * ejecuta en `verify` y en CI: después del daño.
 *
 * Por eso `pnpm db:migrate` ya no existe. El flujo es:
 *
 *   1. `pnpm db:migrate:new <nombre>`   ← este guion
 *   2. escribir el SQL a mano
 *   3. `pnpm migrations:check`
 *   4. `pnpm db:deploy`
 *
 * `migrate deploy` sólo APLICA lo que hay escrito. Nunca inventa SQL.
 */
const name = process.argv[2];

if (!name || !/^[a-z0-9_]+$/.test(name)) {
  console.error(
    'Uso: pnpm db:migrate:new <nombre_en_minusculas_con_guiones_bajos>\n' +
      '\n' +
      'Ejemplo: pnpm db:migrate:new patient_mrn_sequence',
  );
  process.exit(1);
}

/**
 * Marca de tiempo en UTC con el formato que Prisma ordena alfabéticamente.
 * Debe coincidir con el suyo o la migración se aplicaría fuera de orden.
 */
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

const folder = resolve(
  import.meta.dirname,
  `../prisma/migrations/${stamp}_${name}`,
);
const file = resolve(folder, 'migration.sql');

mkdirSync(folder, { recursive: true });
writeFileSync(
  file,
  `-- ${name}\n` +
    '--\n' +
    '-- Escrito a mano. `prisma migrate dev` está prohibido en este\n' +
    '-- repositorio: propone borrar las columnas generadas, los índices GIN y\n' +
    '-- BRIN, los índices únicos parciales y los disparadores, porque\n' +
    '-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.\n' +
    '--\n' +
    '-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.\n' +
    '-- Después: pnpm migrations:check && pnpm db:deploy\n' +
    '\n',
  'utf8',
);

console.log(
  `Migración creada: prisma/migrations/${stamp}_${name}/migration.sql`,
);
console.log(
  'Escriba el SQL y ejecute: pnpm migrations:check && pnpm db:deploy',
);
