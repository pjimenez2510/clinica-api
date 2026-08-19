import { describe, expect, it } from 'vitest';

import { PrismaAuthUserRepository } from '../../src/modules/auth/infrastructure/prisma-auth-user.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';

/**
 * The two credential guarantees that only a real database can demonstrate.
 *
 * Both were broken, and neither could have been caught by a unit test with a
 * repository double: the first is a race, the second is atomicity. A double
 * returns whatever it was told to and has no transaction to roll back.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ SE EJERCITA `PrismaAuthUserRepository`, Y ANTES NO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Este archivo no importaba ni un símbolo de producción: reimplementaba el
 * adaptador en línea —`prisma.user.update({ increment })`, un `$transaction`
 * escrito a mano— y afirmaba sobre su propia copia. Es decir, probaba que
 * Prisma sabe incrementar y transaccionar, que no estaba en duda, mientras su
 * cabecera decía demostrar «las dos garantías que sólo una base real puede
 * demostrar». Borrar el `increment` del adaptador y volver a leer-y-escribir,
 * o quitarle el `$transaction`, dejaba las cuatro pruebas en verde.
 *
 * Ahora las llamadas son las del adaptador. Lo que cambia no es la aserción:
 * es que ahora hay algo que romper.
 */
describe('credential safety under real conditions', () => {
  const db = useDatabase();

  /** El adaptador de verdad, sobre el cliente del contenedor. */
  function repository(): PrismaAuthUserRepository {
    return new PrismaAuthUserRepository(db() as unknown as PrismaService);
  }

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

  it('AU-003 counts EVERY concurrent failure, not just one', async () => {
    /**
     * THE BUG THIS PINS DOWN: the counter used to be read into the process and
     * written back as an absolute value. Ten simultaneous attempts all read 0
     * and all wrote 1, so `failedAttempts` never reached the threshold and the
     * account never locked — leaving only the per-IP throttle, which is the
     * layer a distributed attack is designed to sidestep.
     *
     * With the increment in the database, ten attempts count ten.
     */
    const users = repository();
    const user = await createUser();

    await Promise.all(
      Array.from({ length: 10 }, () => users.registerFailure(user.id)),
    );

    const after = await db().user.findUniqueOrThrow({
      where: { id: user.id },
      select: { failedAttempts: true },
    });

    // Ten, not one. The old code produced one.
    expect(after.failedAttempts).toBe(10);
  });

  it('AU-003 returns a distinct count to each concurrent caller', async () => {
    // What makes the lock decision possible: whoever gets the value that
    // crosses the threshold is the one that applies the lock, and exactly one
    // caller sees each number.
    const users = repository();
    const user = await createUser('enfermera@clinica.ec');

    const counts = await Promise.all(
      Array.from({ length: 5 }, () => users.registerFailure(user.id)),
    );

    expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('changes the password and cuts every session, or neither', async () => {
    const prisma = db();
    const users = repository();
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

    await users.rotateCredentials(user.id, 'the-new-hash', 'PASSWORD_CHANGE');

    const [updated, live, revoked] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      prisma.refreshToken.count({
        where: { userId: user.id, revokedAt: null },
      }),
      prisma.refreshToken.findMany({
        where: { userId: user.id },
        select: { revocationReason: true },
      }),
    ]);

    expect(updated.passwordHash).toBe('the-new-hash');
    expect(live).toBe(0);
    // Y el MOTIVO viaja hasta la fila: es lo que responde «¿por qué se cerró
    // esta sesión?» en una auditoría, y sin él las dos mitades del cambio de
    // contraseña son indistinguibles de un cierre de sesión cualquiera.
    expect(revoked.map((token) => token.revocationReason)).toEqual([
      'PASSWORD_CHANGE',
      'PASSWORD_CHANGE',
    ]);
  });

  it('leaves the password unchanged when the revocation fails', async () => {
    /**
     * The failure the atomicity exists for. Two statements without a
     * transaction leave the password changed and the attacker's session alive
     * — the precise outcome the operation was written to prevent.
     *
     * ⚠️ CÓMO SE HACE FALLAR LA SEGUNDA MITAD, sin tocar el adaptador:
     * `refresh_token.revocation_reason` es `varchar(32)`, así que un motivo más
     * largo revienta el `UPDATE` DESPUÉS de que la contraseña ya está escrita.
     * Es exactamente la forma del fallo que preocupa —algo que falla entre las
     * dos escrituras—, y llega por la ruta real: si el `$transaction` del
     * adaptador desapareciera, la contraseña quedaría cambiada y la sesión del
     * atacante viva.
     */
    const prisma = db();
    const users = repository();
    const user = await createUser('fallo@clinica.ec');
    const originalHash = user.passwordHash;

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        familyId: '00000000-0000-4000-8000-000000000003',
        tokenHash: 'c'.repeat(64),
        expiresAt: new Date('2027-01-01'),
      },
    });

    await expect(
      users.rotateCredentials(user.id, 'the-new-hash', 'X'.repeat(64)),
    ).rejects.toThrow();

    const [after, live] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      prisma.refreshToken.count({
        where: { userId: user.id, revokedAt: null },
      }),
    ]);

    expect(after.passwordHash).toBe(originalHash);
    // Y la sesión sigue exactamente como estaba: ni revocada a medias ni
    // marcada con un motivo que nunca se escribió.
    expect(live).toBe(1);
  });
});
