import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Seed for DOCUMENTS (DOC-030, DOC-037): version 1 of the template of each
 * class, with the approved defaults of D-095, so a development database can
 * issue a receta, an order, a certificate or a RIDE from the first boot.
 *
 * WHY A SEED AND NOT A DEFAULT IN THE CODE. DOC-037 forbids inventing a
 * template when none is published: an implicit default is a version no row
 * records, and the `sha256` of what it produced could not be rebuilt. A seeded
 * row IS a published version, with its number and its publisher, like the one
 * an administrator publishes from `administracion/identidad`.
 *
 * IDEMPOTENT AND RESPECTFUL: a class that already has ANY version is left
 * alone. Re-running never adds a version 2 over what the clinic published, and
 * never duplicates version 1 (`document_template_kind_version_unique`).
 *
 * Chain: `pnpm db:seed` (users) → `pnpm db:seed:document-templates`. The
 * publisher is `admin@clinica.ec`, the development administrator.
 */

const KINDS = [
  'PRESCRIPTION',
  'SERVICE_ORDER',
  'MEDICAL_CERTIFICATE',
  'INVOICE_RIDE',
] as const;

/** D-095: the approved template's accent, and every header switch on. */
const DEFAULTS = {
  accentColour: '#0f6b5c',
  footerText: null,
  headerFields: [],
  showEstablishmentRuc: true,
  showEstablishmentAddress: true,
  showEstablishmentPhone: true,
} as const;

/** Publishes version 1 of every class that has none; reports which. */
export async function seedDocumentTemplates(
  prisma: PrismaClient,
  publishedById: string,
): Promise<{ published: string[] }> {
  const published: string[] = [];
  for (const kind of KINDS) {
    const existing = await prisma.documentTemplate.findFirst({
      where: { kind },
      select: { id: true },
    });
    if (existing) continue;

    await prisma.documentTemplate.create({
      data: { kind, version: 1, ...DEFAULTS, publishedById },
    });
    published.push(kind);
  }
  return { published };
}

/** Entry point for `pnpm db:seed:document-templates`. */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    // A real clinic publishes its own letterhead; a development default in
    // production would be the version its first recetas were printed with.
    throw new Error('This seed is for development only.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const admin = await prisma.user.findUnique({
      where: { email: 'admin@clinica.ec' },
      select: { id: true },
    });
    if (!admin) {
      throw new Error('Falta admin@clinica.ec: ejecute antes `pnpm db:seed`.');
    }
    const { published } = await seedDocumentTemplates(prisma, admin.id);
    console.log(
      published.length === 0
        ? 'Plantillas de documentos: todas las clases ya tenían versión publicada.'
        : `Plantillas de documentos: versión 1 publicada para ${published.join(', ')}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Only when invoked directly, so the integration suite can import the function.
if (process.argv[1]?.endsWith('seed-document-templates.mts')) {
  await main();
}
