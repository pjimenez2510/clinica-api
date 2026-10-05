import { describe, expect, it } from 'vitest';

import { extractDatabaseProblem } from '../../src/shared/http/database-problem';
import '../../src/modules/encounter/infrastructure/encounter.constraints';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';
import type { PrismaClient } from '@prisma/client';

/**
 * D-127 — corregir es editar, y la versión anterior la guarda la BASE.
 *
 * Lo que solo PostgreSQL puede demostrar: que el disparador genérico
 * `record_version_archive` archiva la fila anterior en la misma sentencia, y
 * que un UPDATE sin sello nuevo —el de un psql, una importación o un
 * asistente que se lo salte— se rechaza. Cada rechazo tiene su control
 * positivo: la misma fila, con sello, entra.
 */
const db = useDatabase();

/** The stamps come from the test's clock: one minute apart, in order. */
const clock = () => new Date();
const minutesAfter = (start: Date, minutes: number) =>
  new Date(start.getTime() + minutes * 60_000);

async function aTaking(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  await prisma.$executeRawUnsafe(
    `INSERT INTO encounter_vitals (encounter_id, weight_kg, recorded_by)
     VALUES ($1, 68, $2::uuid)`,
    encounter.id,
    practitioner.userId,
  );
  return { encounter, practitioner };
}

function versionsOf(prisma: PrismaClient, encounterId: string) {
  return prisma.$queryRawUnsafe<
    {
      version: number;
      weight: string;
      changed_by: string;
      changed_at: Date;
    }[]
  >(
    `SELECT version, data ->> 'weight_kg' AS weight, changed_by::text AS changed_by, changed_at
       FROM record_version
      WHERE resource_type = 'encounter_vitals' AND resource_id = $1::uuid
      ORDER BY version`,
    encounterId,
  );
}

async function problemFrom(operation: Promise<unknown>) {
  try {
    await operation;
    throw new Error('the operation should have failed');
  } catch (error) {
    return extractDatabaseProblem(error);
  }
}

describe('record_version: la versión anterior la guarda la base', () => {
  it('EN-210 cada corrección con sello archiva la toma anterior, con quién y cuándo', async () => {
    const prisma = db();
    const { encounter, practitioner } = await aTaking(prisma);
    const corrector = await createUser(prisma);
    const now = clock();
    const first = minutesAfter(now, 1);
    const second = minutesAfter(now, 2);

    await prisma.$executeRawUnsafe(
      `UPDATE encounter_vitals
          SET weight_kg = 69, corrected_by = $2::uuid, corrected_at = $3
        WHERE encounter_id = $1`,
      encounter.id,
      corrector.id,
      first,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE encounter_vitals
          SET weight_kg = 70, corrected_by = $2::uuid, corrected_at = $3
        WHERE encounter_id = $1`,
      encounter.id,
      practitioner.userId,
      second,
    );

    const versions = await versionsOf(prisma, encounter.id);
    expect(versions.map((v) => [v.version, Number(v.weight)])).toEqual([
      [1, 68],
      [2, 69],
    ]);
    expect(versions[0]!.changed_by).toBe(corrector.id);
    expect(versions[0]!.changed_at).toEqual(first);
    expect(versions[1]!.changed_by).toBe(practitioner.userId);
    expect(versions[1]!.changed_at).toEqual(second);
  });

  it('EN-210 rechaza un UPDATE sin sello nuevo, y no archiva nada', async () => {
    const prisma = db();
    const { encounter } = await aTaking(prisma);
    const corrector = await createUser(prisma);
    const stamp = clock();

    // Sin sello: nadie dice quién corrigió.
    const unstamped = await problemFrom(
      prisma.$executeRawUnsafe(
        `UPDATE encounter_vitals SET weight_kg = 69 WHERE encounter_id = $1`,
        encounter.id,
      ),
    );
    expect(unstamped?.code).toBe('EDIT_NOT_STAMPED');

    // Control positivo: con sello, la misma corrección entra.
    await prisma.$executeRawUnsafe(
      `UPDATE encounter_vitals
          SET weight_kg = 69, corrected_by = $2::uuid, corrected_at = $3
        WHERE encounter_id = $1`,
      encounter.id,
      corrector.id,
      stamp,
    );

    // Repetir el sello anterior es no poner sello: se rechaza.
    const reused = await problemFrom(
      prisma.$executeRawUnsafe(
        `UPDATE encounter_vitals SET weight_kg = 70 WHERE encounter_id = $1`,
        encounter.id,
      ),
    );
    expect(reused?.code).toBe('EDIT_NOT_STAMPED');

    expect((await versionsOf(prisma, encounter.id)).length).toBe(1);
  });

  it('EN-210 una versión guardada no se reescribe ni se borra', async () => {
    const prisma = db();
    const { encounter } = await aTaking(prisma);
    const corrector = await createUser(prisma);
    await prisma.$executeRawUnsafe(
      `UPDATE encounter_vitals
          SET weight_kg = 69, corrected_by = $2::uuid, corrected_at = $3
        WHERE encounter_id = $1`,
      encounter.id,
      corrector.id,
      clock(),
    );
    // Control positivo: la versión existe y se lee.
    expect((await versionsOf(prisma, encounter.id)).length).toBe(1);

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE record_version SET data = '{}'::jsonb WHERE resource_id = $1::uuid`,
        encounter.id,
      ),
    ).rejects.toThrow(/insert-only/);
    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM record_version WHERE resource_id = $1::uuid`,
        encounter.id,
      ),
    ).rejects.toThrow(/insert-only/);
  });
});
