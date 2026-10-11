import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Development data for the privacy screens (PD-001..PD-075): a privacy notice
 * already published, so «Aviso de privacidad» shows and prints something.
 *
 * ⚠️ THE TEXT IS A PLACEHOLDER AND SAYS SO. The privacy notice is a legal
 * document the clinic writes with its adviser (D-221 §2); this one exists only
 * so the screen has something to show in development. It is published ONLY if no version exists
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

  const published = await prisma.privacyNoticeVersion.count();
  if (published === 0) {
    await prisma.privacyNoticeVersion.create({
      data: {
        version: 1,
        body:
          'Texto de prueba de desarrollo, versión 1.\n\n' +
          'No es un texto legal: el texto real lo redacta la clínica con su ' +
          'asesor y lo publica administración en «Aviso de privacidad».',
        publishedBy: admin.id,
      },
    });
  }

  console.log(
    published === 0
      ? 'Privacidad: publicado el aviso de prueba (versión 1).'
      : `Privacidad: ya hay ${published} versión(es) del aviso; no se publica otra.`,
  );
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
