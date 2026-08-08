import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

// The SAME parameters the application hashes with. A third copy meant that
// raising `memoryCost` — the very scenario `needsRehash` exists to support —
// left the seed producing hashes with the old ones, so the development
// password was silently rehashed on every single login.
import { PASSWORD_HASHING } from '../src/modules/auth/domain/password-hashing.ts';

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

/** Strips the seed-only `role` field before writing to the user table. */
function userColumns({ role: _role, ...columns }: (typeof USERS)[number]) {
  return columns;
}

const USERS = [
  {
    email: 'medico@clinica.ec',
    firstName: 'Ana',
    lastName: 'Torres',
    cedula: '1710034065',
    acessRegistration: 'ACESS-1001',
    role: 'MEDICO',
  },
  {
    email: 'recepcion@clinica.ec',
    firstName: 'Luis',
    lastName: 'Paredes',
    cedula: '1713175071',
    acessRegistration: null,
    role: 'RECEPCION',
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
  const passwordHash = await argon2.hash(DEV_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: PASSWORD_HASHING.memoryCost,
    timeCost: PASSWORD_HASHING.timeCost,
    parallelism: PASSWORD_HASHING.parallelism,
  });

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
      create: { ...userColumns(user), passwordHash },
    });
  }

  /**
   * Grants the seeded roles.
   *
   * Without this every account signs in with NOTHING — which is the correct
   * closed-by-default behaviour, and makes the app look broken in development.
   * Global scope (`siteId: null`) because there are no sites seeded yet.
   */
  for (const user of USERS) {
    const [account, role] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email: user.email } }),
      prisma.role.findUnique({ where: { code: user.role } }),
    ]);
    if (!role) continue;

    const existing = await prisma.userRoleGrant.findFirst({
      where: { userId: account.id, roleId: role.id, revokedAt: null },
    });
    if (!existing) {
      await prisma.userRoleGrant.create({
        data: { userId: account.id, roleId: role.id, siteId: null },
      });
    }
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
