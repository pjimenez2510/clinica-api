import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  addDays,
  clinicalDateOf,
  type ClinicalDate,
} from '../../src/shared/domain/clinic-time';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * What PostgreSQL guarantees about the medical certificate, against a real
 * PostgreSQL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY ONLY THE DATABASE CAN SHOW THIS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * «Consecutive and without gaps» is a property of concurrent transactions and
 * of rollbacks, and «the three columns of the annulment together» is a `CHECK`
 * that also stops an import and a `psql`. A double that hands out `n + 1`
 * proves the addition. What has to be shown is that the trigger numbers a raw
 * `INSERT`, that a rolled-back emission gives its number back, that two sites
 * count apart, and that the `CHECK`s refuse what they say they refuse — each
 * beside the permitted case going through the same path.
 */
const db = useDatabase();

interface Scene {
  siteId: string;
  encounterId: string;
  patientId: string;
  practitionerId: string;
  /** The account that annuls: `revoked_by_id` targets `app_user`. */
  userId: string;
  /** The clinical date of the attention, derived from the fixture's instant. */
  day: ClinicalDate;
}

async function aScene(prisma: PrismaClient): Promise<Scene> {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  const user = await createUser(prisma);
  return {
    siteId: site.id,
    encounterId: encounter.id,
    patientId: patient.id,
    practitionerId: practitioner.id,
    userId: user.id,
    day: clinicalDateOf(encounter.startedAt),
  };
}

let codes = 0;
/** Unique per call, without Math.random: a failing test must be reproducible. */
const nextCode = (): string => `VC-${String(++codes).padStart(8, '0')}`;

/**
 * One certificate inserted the way any writer can: raw SQL, no repository,
 * and no `site_id` and no `number` — the triggers put both.
 */
async function insertCertificate(
  prisma: PrismaClient,
  scene: Scene,
  rest: { from: string; to: string } | null = null,
): Promise<{ id: string; number: number; site_id: string }> {
  const [row] = await prisma.$queryRaw<
    { id: string; number: number; site_id: string }[]
  >`
    INSERT INTO medical_certificate
      (encounter_id, patient_id, issued_by_id, type, rest_from, rest_to, verification_code)
    VALUES (${scene.encounterId}::uuid, ${scene.patientId}::uuid, ${scene.practitionerId}::uuid,
            ${rest === null ? 'ATTENDANCE' : 'MEDICAL_REST'}::certificate_type,
            ${rest?.from ?? null}::date, ${rest?.to ?? null}::date, ${nextCode()})
    RETURNING id, number, site_id::text AS site_id
  `;
  return row!;
}

describe('CER-009 el número del certificado: propio, por sede, sin huecos e inmutable', () => {
  it('CER-009 dos certificados de la misma sede llevan 1 y 2, y la sede la pone la base', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    const first = await insertCertificate(prisma, scene);
    const second = await insertCertificate(prisma, scene);

    expect([first.number, second.number]).toEqual([1, 2]);
    expect(first.site_id).toBe(scene.siteId);
  });

  it('CER-009 cada sede numera desde 1 (D-074, por sede)', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const other = await createSite(prisma);
    const otherEncounter = await createEncounter(prisma, {
      siteId: other.id,
      practitionerId: scene.practitionerId,
      patientId: scene.patientId,
    });

    expect((await insertCertificate(prisma, scene)).number).toBe(1);
    expect(
      (
        await insertCertificate(prisma, {
          ...scene,
          siteId: other.id,
          encounterId: otherEncounter.id,
        })
      ).number,
    ).toBe(1);
  });

  it('CER-009 una emisión que se revierte devuelve su número: no queda hueco', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    await expect(
      prisma.$transaction(async (tx) => {
        await insertCertificate(tx as PrismaClient, scene);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    // Control positivo: la emisión que sí se confirma recibe el 1 que la
    // revertida devolvió.
    expect((await insertCertificate(prisma, scene)).number).toBe(1);
  });

  it('CER-009 diez emisiones concurrentes reciben 1 a 10, sin repetir ni saltar', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    const numbers = await Promise.all(
      Array.from({ length: 10 }, () => insertCertificate(prisma, scene)),
    );

    // SC-065: max(number) = count(*) en la sede.
    expect(numbers.map((row) => row.number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
  });

  it('CER-009 el número no lo elige quien inserta: el disparador lo pisa', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const elsewhere = await createSite(prisma);

    const [row] = await prisma.$queryRaw<{ number: number; site_id: string }[]>`
      INSERT INTO medical_certificate
        (encounter_id, patient_id, issued_by_id, type, verification_code, number, site_id)
      VALUES (${scene.encounterId}::uuid, ${scene.patientId}::uuid, ${scene.practitionerId}::uuid,
              'ATTENDANCE', ${nextCode()}, 500, ${elsewhere.id}::uuid)
      RETURNING number, site_id::text AS site_id
    `;

    expect(row!.number).toBe(1);
    expect(row!.site_id).toBe(scene.siteId);
  });

  it('CER-009 el número y la sede no se cambian después, y lo demás sí', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const certificate = await insertCertificate(prisma, scene);

    // Control positivo: el mismo UPDATE sobre otra columna pasa por el mismo
    // disparador y se admite.
    await expect(
      prisma.$executeRaw`UPDATE medical_certificate SET include_diagnosis = true WHERE id = ${certificate.id}::uuid`,
    ).resolves.toBe(1);

    await expect(
      prisma.$executeRaw`UPDATE medical_certificate SET number = 99 WHERE id = ${certificate.id}::uuid`,
    ).rejects.toThrow(/medical_certificate_number_immutable/);
  });

  it('CER-009 control positivo: la unicidad por sede existe y rechaza un duplicado', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    await insertCertificate(prisma, scene);
    await insertCertificate(prisma, scene);

    // Sin el disparador de UPDATE no se puede tocar `number`: se desactiva
    // dentro de la transacción para demostrar que, si faltara, la base seguiría
    // diciendo que no.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`ALTER TABLE medical_certificate DISABLE TRIGGER medical_certificate_number_immutable`;
        await tx.$executeRaw`UPDATE medical_certificate SET number = 1 WHERE number = 2`;
      }),
    ).rejects.toThrow(/medical_certificate_site_number_unique/);
  });
});

describe('CER-006 el período de reposo lo garantiza también la base', () => {
  it('CER-006 admite un reposo de un día y rechaza uno con el fin antes del inicio', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    // Control positivo: inicio y fin el mismo día, ambos incluidos.
    await expect(
      insertCertificate(prisma, scene, { from: scene.day, to: scene.day }),
    ).resolves.toMatchObject({ number: 1 });

    await expect(
      insertCertificate(prisma, scene, {
        from: scene.day,
        to: addDays(scene.day, -1),
      }),
    ).rejects.toThrow(/medical_certificate_rest_range/);
  });

  it('CER-006 rechaza un certificado de asistencia con período', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    await expect(
      prisma.$executeRaw`
        INSERT INTO medical_certificate
          (encounter_id, patient_id, issued_by_id, type, rest_from, rest_to, verification_code)
        VALUES (${scene.encounterId}::uuid, ${scene.patientId}::uuid, ${scene.practitionerId}::uuid,
                'ATTENDANCE', ${scene.day}::date, ${scene.day}::date, ${nextCode()})
      `,
    ).rejects.toThrow(/medical_certificate_rest_range/);
  });
});

describe('CER-011 la anulación dice quién, cuándo y por qué, o no existe', () => {
  it('CER-011 admite la anulación con los tres datos y rechaza la que no lleva autor', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const certificate = await insertCertificate(prisma, scene);

    // Control positivo: los tres juntos.
    await expect(
      prisma.$executeRaw`
        UPDATE medical_certificate
           SET revoked_at = now(), revoked_by_id = ${scene.userId}::uuid,
               revocation_reason = 'Se emitió a la persona equivocada'
         WHERE id = ${certificate.id}::uuid
      `,
    ).resolves.toBe(1);

    const other = await insertCertificate(prisma, scene);
    await expect(
      prisma.$executeRaw`
        UPDATE medical_certificate
           SET revoked_at = now(), revocation_reason = 'Sin autor'
         WHERE id = ${other.id}::uuid
      `,
    ).rejects.toThrow(/medical_certificate_revocation_states_who_when_and_why/);
  });

  it('CER-011 rechaza un motivo en blanco y un motivo sin instante', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const certificate = await insertCertificate(prisma, scene);

    await expect(
      prisma.$executeRaw`
        UPDATE medical_certificate
           SET revoked_at = now(), revoked_by_id = ${scene.userId}::uuid,
               revocation_reason = '   '
         WHERE id = ${certificate.id}::uuid
      `,
    ).rejects.toThrow(/medical_certificate_revocation_states_who_when_and_why/);

    await expect(
      prisma.$executeRaw`
        UPDATE medical_certificate
           SET revocation_reason = 'Motivo sin anulación'
         WHERE id = ${certificate.id}::uuid
      `,
    ).rejects.toThrow(/medical_certificate_revocation_states_who_when_and_why/);
  });

  it('CER-011 la fila anulada sigue ahí, y no se puede borrar mientras la referencien', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const certificate = await insertCertificate(prisma, scene);
    await prisma.$executeRaw`
      UPDATE medical_certificate
         SET revoked_at = now(), revoked_by_id = ${scene.userId}::uuid,
             revocation_reason = 'Se emitió a la persona equivocada'
       WHERE id = ${certificate.id}::uuid
    `;

    const [row] = await prisma.$queryRaw<
      { revoked_by_id: string; revocation_reason: string; number: number }[]
    >`
      SELECT revoked_by_id::text AS revoked_by_id, revocation_reason, number
        FROM medical_certificate WHERE id = ${certificate.id}::uuid
    `;
    expect(row).toEqual({
      revoked_by_id: scene.userId,
      revocation_reason: 'Se emitió a la persona equivocada',
      number: 1,
    });

    // `revoked_by_id` es clave foránea con ON DELETE RESTRICT: la cuenta que
    // anuló no desaparece dejando una anulación sin autor.
    await expect(
      prisma.$executeRaw`DELETE FROM app_user WHERE id = ${scene.userId}::uuid`,
    ).rejects.toThrow(/medical_certificate_revoked_by_fk/);
  });
});

describe('CER-029 el certificado no tiene texto libre', () => {
  it('CER-029 la columna body ya no existe', async () => {
    const prisma = db();
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name::text AS column_name
        FROM information_schema.columns
       WHERE table_name = 'medical_certificate'
    `;
    const names = columns.map((column) => column.column_name);

    // Control positivo: la consulta sí ve la tabla.
    expect(names).toContain('verification_code');
    expect(names).not.toContain('body');
  });
});
