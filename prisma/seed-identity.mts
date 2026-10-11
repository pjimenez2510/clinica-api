import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import {
  SAMPLE_REGISTRY_FILE,
  importSriRucRegistry,
} from './import-sri-ruc.mts';

/**
 * IL-009 (D-206). Seeds the INVENTED sample of the SRI RUC registry, for
 * development and the e2e walks. Never the real catastro — that is imported by
 * hand with `pnpm db:import:sri-ruc <archivo.csv>`.
 *
 * REFUSES PRODUCTION, like `seed.mts`: the sample's cedulas carry valid check
 * digits and could belong to real people, so proposing their invented names on
 * a real database would corrupt a chart. The guard is on NODE_ENV and not on
 * the file, because the danger is where it runs, not which file it is.
 */
export async function seedIdentitySample(prisma: PrismaClient): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'The invented SRI registry sample must never run against production',
    );
  }
  const result = await importSriRucRegistry(prisma, {
    file: SAMPLE_REGISTRY_FILE,
    now: new Date(),
  });
  console.log(
    result.status === 'unchanged'
      ? 'Catastro de muestra (inventado): ya estaba importado.'
      : `Catastro de muestra (inventado): ${result.kept} personas naturales.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    await seedIdentitySample(prisma);
  } finally {
    await prisma.$disconnect();
  }
}
