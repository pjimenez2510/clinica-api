import { existsSync } from 'node:fs';

import { defineConfig, env } from 'prisma/config';

// Prisma 7 dejó de cargar `.env` automáticamente. `process.loadEnvFile` es
// nativo de Node 20.12+, así que no hace falta dotenv.
// En CI y producción las variables ya vienen del entorno y no hay archivo.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

/**
 * Configuración del CLI de Prisma (migraciones, introspección, studio).
 *
 * Desde Prisma 7 la URL de conexión ya no vive en `schema.prisma`: aquí la usa
 * el motor de migraciones, y el cliente en tiempo de ejecución recibe por
 * separado un adaptador de driver construido en la aplicación.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
