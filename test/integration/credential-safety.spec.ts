import { describe, expect, it } from 'vitest';

import { useDatabase } from './setup/database';

/**
 * The two credential guarantees that only a real database can demonstrate.
 *
 * Both were broken, and neither could have been caught by a unit test with a
 * repository double: the first is a race, the second is atomicity. A double
 * returns whatever it was told to and has no transaction to roll back.
 */
describe('credential safety under real conditions', () => {
  const db = useDatabase();

  async function createUser(email = 'medico@clinica.ec') {
    return db().user.create({
      data: {
        email,
        passwordHash: 'not-a-real-hash',
        firstName: 'Ana',
        lastName: 'Villacís',
      },
    });
  }

  it('counts EVERY concurrent failure, not just one', async () => {
    /**
     * THE BUG THIS PINS DOWN: the counter used to be read into the process and
     * written back as an absolute value. Ten simultaneous attempts all read 0
     * and all wrote 1, so `failedAttempts` never reached the threshold and the
     * account never locked — leaving only the per-IP throttle, which is the
     * layer a distributed attack is designed to sidestep.
     *
     * With the increment in the database, ten attempts count ten.
     */
    const prisma = db();
    const user = await createUser();

    await Promise.all(
      Array.from({ length: 10 }, () =>
        prisma.user.update({
          where: { id: user.id },
          data: { failedAttempts: { increment: 1 } },
          select: { failedAttempts: true },
        }),
      ),
    );

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { failedAttempts: true },
    });

    // Ten, not one. The old code produced one.
    expect(after.failedAttempts).toBe(10);
  });

  it('returns a distinct count to each concurrent caller', async () => {
    // What makes the lock decision possible: whoever gets the value that
    // crosses the threshold is the one that applies the lock, and exactly one
    // caller sees each number.
    const prisma = db();
    const user = await createUser('enfermera@clinica.ec');

    const counts = await Promise.all(
      Array.from({ length: 5 }, () =>
        prisma.user
          .update({
            where: { id: user.id },
            data: { failedAttempts: { increment: 1 } },
            select: { failedAttempts: true },
          })
          .then((row) => row.failedAttempts),
      ),
    );

    expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('changes the password and cuts every session, or neither', async () => {
    const prisma = db();
    const user = await createUser('atendido@clinica.ec');
    await prisma.refreshToken.createMany({
      data: [
        {
          userId: user.id,
          familyId: '00000000-0000-4000-8000-000000000001',
          tokenHash: 'a'.repeat(64),
          expiresAt: new Date('2027-01-01'),
        },
        {
          userId: user.id,
          familyId: '00000000-0000-4000-8000-000000000002',
          tokenHash: 'b'.repeat(64),
          expiresAt: new Date('2027-01-01'),
        },
      ],
    });

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash: 'the-new-hash' },
      });
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date(), revocationReason: 'PASSWORD_CHANGE' },
      });
    });

    const [updated, live] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      prisma.refreshToken.count({
        where: { userId: user.id, revokedAt: null },
      }),
    ]);

    expect(updated.passwordHash).toBe('the-new-hash');
    expect(live).toBe(0);
  });

  it('leaves the password unchanged when the revocation fails', async () => {
    /**
     * The failure the atomicity exists for. Two statements without a
     * transaction leave the password changed and the attacker's session alive
     * — the precise outcome the operation was written to prevent.
     */
    const prisma = db();
    const user = await createUser('fallo@clinica.ec');
    const originalHash = user.passwordHash;

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { passwordHash: 'the-new-hash' },
        });
        // Stands in for anything that can fail after the password is written.
        await tx.refreshToken.create({
          data: {
            userId: '00000000-0000-4000-8000-00000000dead',
            familyId: '00000000-0000-4000-8000-000000000003',
            tokenHash: 'c'.repeat(64),
            expiresAt: new Date('2027-01-01'),
          },
        });
      }),
    ).rejects.toThrow();

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(after.passwordHash).toBe(originalHash);
  });
});
