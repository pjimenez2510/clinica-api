import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Development data for the privacy screens (PD-001..PD-043), so the desk can
 * take a consent by hand without an administrator publishing a text first.
 *
 * ⚠️ THE TEXT IS A PLACEHOLDER AND SAYS SO. A consent text is a legal document
 * the clinic writes with its adviser; this one exists only so the desk has
 * something to show in development. It is published ONLY if no version exists
 * yet: the table is append-only, and a seed that published on every run would
 * fill it with copies.
 *
 * NO REQUEST IS SEEDED, on purpose: its due date comes from `legalDueDate`,
 * and a second copy of that legal rule here could drift from the API's.
 * Registering one from the chart is the thing to try by hand anyway.
 * Refuses to run against production.
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'The privacy development seed must never run in production',
    );
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  const admin = await prisma.user.findUniqueOrThrow({
    where: { email: 'admin@clinica.ec' },
    select: { id: true },
  });

  const published = await prisma.consentTextVersion.count();
  if (published === 0) {
    await prisma.consentTextVersion.create({
      data: {
        version: 1,
        body:
          'Texto de prueba de desarrollo, versión 1.\n\n' +
          'No es un texto legal: el texto real lo redacta la clínica con su ' +
          'asesor y lo publica administración en «Texto de consentimiento».',
        publishedBy: admin.id,
      },
    });
  }

  console.log(
    published === 0
      ? 'Privacidad: publicado el texto de prueba (versión 1).'
      : `Privacidad: ya hay ${published} versión(es) del texto; no se publica otra.`,
  );
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
