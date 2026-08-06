import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

// The SAME parameters the application hashes with. A third copy meant that
// raising `memoryCost` — the very scenario `needsRehash` exists to support —
// left the seed producing hashes with the old ones, so the development
// password was silently rehashed on every single login.
import { ARGON2_OPTIONS } from '../src/modules/auth/infrastructure/password-hasher.service.ts';

/**
 * Development seed.
 *
 * Idempotent on purpose: it can be run as many times as needed and always
 * leaves the same known state, including resetting lockout counters and MFA so
 * a half-finished manual test never blocks the next one.
 *
 * These credentials are for local development only. The script refuses to run
 * against a production NODE_ENV.
 */

const DEV_PASSWORD = 'el caballo come alfalfa';

const USERS = [
  {
    email: 'medico@clinica.ec',
    firstName: 'Ana',
    lastName: 'Torres',
    cedula: '1710034065',
    acessRegistration: 'ACESS-1001',
  },
  {
    email: 'recepcion@clinica.ec',
    firstName: 'Luis',
    lastName: 'Paredes',
    cedula: '1713175071',
    acessRegistration: null,
  },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The development seed must never run against production');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  // Hashed once and reused: Argon2id at these parameters costs ~100 ms per call.
  const passwordHash = await argon2.hash(DEV_PASSWORD, ARGON2_OPTIONS);

  for (const user of USERS) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: {
        passwordHash,
        active: true,
        // Reset anything a previous manual test may have left behind.
        failedAttempts: 0,
        lockedUntil: null,
        mfaEnabledAt: null,
        mfaSecretEncrypted: null,
        mfaLastStep: null,
      },
      create: { ...user, passwordHash },
    });
  }

  // Sessions from previous runs are meaningless once passwords are reset.
  await prisma.refreshToken.deleteMany({});

  console.log(`Seeded ${USERS.length} users. Password for all of them: ${DEV_PASSWORD}`);
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
