import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { HistoryAlreadyRefutedError } from '../../src/modules/encounter/domain/encounter.errors';
import { PrismaEncounterRepository } from '../../src/modules/encounter/infrastructure/prisma-encounter.repository';
import { PrismaPatientHistoryRepository } from '../../src/modules/encounter/infrastructure/prisma-patient-history.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * EN-085 against a real PostgreSQL: the history is a state of the PERSON that
 * persists between attentions and across a merge, and is refuted, never
 * deleted. The last half is `trg_patient_history_append_only`, and only the
 * database can show it holds.
 */
const db = useDatabase();

const historyOf = (prisma: PrismaClient) =>
  new PrismaPatientHistoryRepository(prisma as unknown as PrismaService);

async function aFamilyEntry(prisma: PrismaClient, patientId: string) {
  const author = await createUser(prisma);
  const entry = await historyOf(prisma).record({
    patientId,
    kind: 'FAMILY',
    description: 'Diabetes tipo 2',
    relative: 'Madre',
    recordedById: author.id,
  });
  return { author, entry };
}

describe('los antecedentes del paciente contra PostgreSQL', () => {
  it('EN-085 el antecedente de una atencion reaparece en la siguiente, con su autor', async () => {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);
    const encounters = new PrismaEncounterRepository(
      prisma as unknown as PrismaService,
    );
    const opened = {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
      careModality: 'MORBIDITY' as const,
      careSetting: 'INTRAMURAL' as const,
      visitSequence: 'FIRST_TIME' as const,
    };
    const now = Date.now();
    await encounters.open({ ...opened, startedAt: new Date(now - 86_400_000) });
    const { author } = await aFamilyEntry(prisma, patient.id);
    await encounters.open({
      ...opened,
      startedAt: new Date(now),
      visitSequence: 'SUBSEQUENT',
    });

    const [entry] = await historyOf(prisma).listFor(patient.id);

    expect(entry).toMatchObject({
      kind: 'FAMILY',
      description: 'Diabetes tipo 2',
      relative: 'Madre',
      recordedBy: { id: author.id, name: 'Carmen Salazar' },
      refutedAt: null,
    });
  });

  it('EN-085 se lee desde la ficha que absorbio la suya', async () => {
    const prisma = db();
    const survivor = await createPatient(prisma);
    const absorbed = await createPatient(prisma);
    await aFamilyEntry(prisma, absorbed.id);
    // Control positivo: antes de fusionar, la superviviente no lo tiene.
    await expect(historyOf(prisma).listFor(survivor.id)).resolves.toEqual([]);

    await prisma.patient.update({
      where: { id: absorbed.id },
      data: { mergedIntoId: survivor.id, mergedAt: new Date() },
    });

    const entries = await historyOf(prisma).listFor(survivor.id);
    expect(entries.map((entry) => entry.patientId)).toEqual([absorbed.id]);
  });

  it('EN-085 refutar no borra: la fila sigue, con motivo y autor, y una segunda refutacion falla', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const { entry } = await aFamilyEntry(prisma, patient.id);
    const doctor = await createUser(prisma);
    const repository = historyOf(prisma);
    const refutation = {
      patientId: patient.id,
      historyId: entry.id,
      notes: 'Era la tía, no la madre',
      now: new Date(),
      refutedById: doctor.id,
    };

    const refuted = await repository.refute(refutation);

    expect(refuted?.refutedBy?.id).toBe(doctor.id);
    await expect(prisma.patientHistory.count()).resolves.toBe(1);
    await expect(repository.refute(refutation)).rejects.toBeInstanceOf(
      HistoryAlreadyRefutedError,
    );
  });

  it('EN-085 la base rechaza borrar, truncar y reescribir un antecedente', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const { entry } = await aFamilyEntry(prisma, patient.id);

    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM patient_history WHERE id = $1::uuid`,
        entry.id,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe(`TRUNCATE patient_history`),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE patient_history SET description = 'Hipertensión' WHERE id = $1::uuid`,
        entry.id,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.patientHistory.count()).resolves.toBe(1);
  });

  it('EN-085 la base exige parentesco en el familiar y lo rechaza en el personal', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const author = await createUser(prisma);
    const base = { patientId: patient.id, recordedById: author.id };

    // Control positivo: los dos bien formados entran.
    await prisma.patientHistory.create({
      data: { ...base, kind: 'PERSONAL', description: 'Asma' },
    });
    await prisma.patientHistory.create({
      data: {
        ...base,
        kind: 'FAMILY',
        description: 'Diabetes',
        relative: 'Padre',
      },
    });

    await expect(
      prisma.patientHistory.create({
        data: { ...base, kind: 'FAMILY', description: 'Diabetes' },
      }),
    ).rejects.toThrow(/patient_history_family_names_relative/);
    await expect(
      prisma.patientHistory.create({
        data: {
          ...base,
          kind: 'PERSONAL',
          description: 'Asma',
          relative: 'Padre',
        },
      }),
    ).rejects.toThrow(/patient_history_family_names_relative/);
  });

  it('EN-085 la base rechaza la descripcion en blanco, la refutacion a medias y refutar dos veces', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const author = await createUser(prisma);
    const { entry } = await aFamilyEntry(prisma, patient.id);

    await expect(
      prisma.patientHistory.create({
        data: {
          patientId: patient.id,
          recordedById: author.id,
          kind: 'PERSONAL',
          description: '   ',
        },
      }),
    ).rejects.toThrow(/patient_history_description_not_blank/);

    // Sin motivo: refutar es cuándo, por qué y quién, o nada.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE patient_history SET refuted_at = now(), refuted_by = $2::uuid
          WHERE id = $1::uuid`,
        entry.id,
        author.id,
      ),
    ).rejects.toThrow(/patient_history_refutation_is_whole/);

    // Control positivo: la refutación entera entra por SQL…
    await prisma.$executeRawUnsafe(
      `UPDATE patient_history
          SET refuted_at = now(), refuted_by = $2::uuid, refuted_notes = 'Era la tía'
        WHERE id = $1::uuid`,
      entry.id,
      author.id,
    );
    // …y la segunda la para el disparador, no el repositorio.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE patient_history SET refuted_notes = 'Otro motivo' WHERE id = $1::uuid`,
        entry.id,
      ),
    ).rejects.toThrow(/append-only/);
  });
});
