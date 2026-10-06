import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { useDatabase } from './setup/database';
import {
  createDiagnosis,
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * EN-215 (D-117.12, D-127): after the discharge the coding of the attention is
 * still corrected — a new diagnosis is registered, and the modality and the
 * first-time/subsequent mark are edited — and the previous version of the
 * attention is kept by the DATABASE in `record_version`.
 *
 * What only PostgreSQL can prove: that a correction of either column without a
 * new stamp is refused, that the rest of the attention's writes (closing,
 * annulling) need no stamp, and that an attention already reported to the
 * RDACAA admits neither a new diagnosis nor a correction (D-117.16). Every
 * refusal has its positive control beside it.
 */
const db = useDatabase();

/** Stamps from the test's clock, one second apart and in order. */
let tick = 0;
const nextStamp = () => new Date(Date.now() + (tick += 1) * 1000);

async function aDischargedEncounter(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  await createDiagnosis(prisma, encounter.id, 'J02');
  // Positive control of «the other writes need no stamp»: the discharge
  // itself is an UPDATE of the attention without one.
  await prisma.encounter.update({
    where: { id: encounter.id },
    data: {
      status: 'DISCHARGED',
      endedAt: new Date(encounter.startedAt.getTime() + 20 * 60_000),
      dischargeCondition: 'ALIVE',
    },
  });
  const editor = await createUser(prisma);
  return { encounter, editor };
}

function correct(
  prisma: PrismaClient,
  encounterId: string,
  editorId: string,
  stamp: Date,
  visitSequence: 'FIRST_TIME' | 'SUBSEQUENT',
) {
  return prisma.$executeRaw`
    UPDATE encounter
       SET "visitSequence" = ${visitSequence}::visit_sequence,
           corrected_by_id = ${editorId}::uuid, corrected_at = ${stamp}
     WHERE id = ${encounterId}::uuid`;
}

function versionsOf(prisma: PrismaClient, encounterId: string) {
  return prisma.$queryRaw<
    { version: number; sequence: string; changed_by: string }[]
  >`
    SELECT version, data ->> 'visitSequence' AS sequence,
           changed_by::text AS changed_by
      FROM record_version
     WHERE resource_type = 'encounter' AND resource_id = ${encounterId}::uuid
     ORDER BY version`;
}

describe('la codificación de la atención tras el alta (EN-215)', () => {
  it('EN-215 la BASE guarda la versión anterior de la primera vez/subsecuente, y sin sello nuevo la rechaza', async () => {
    const prisma = db();
    const { encounter, editor } = await aDischargedEncounter(prisma);
    const stamp = nextStamp();

    await correct(prisma, encounter.id, editor.id, stamp, 'SUBSEQUENT');
    expect(await versionsOf(prisma, encounter.id)).toEqual([
      { version: 1, sequence: 'FIRST_TIME', changed_by: editor.id },
    ]);

    // The same stamp again is a correction nobody signed.
    await expect(
      correct(prisma, encounter.id, editor.id, stamp, 'FIRST_TIME'),
    ).rejects.toThrow(/record_version_change_is_stamped/);
    expect(await versionsOf(prisma, encounter.id)).toHaveLength(1);

    // A write that does not touch the coding needs no stamp.
    await prisma.$executeRaw`
      UPDATE encounter SET status = 'COMPLETED' WHERE id = ${encounter.id}::uuid`;
    expect(await versionsOf(prisma, encounter.id)).toHaveLength(1);
  });

  it('EN-215 D-117.16 la BASE no admite un diagnóstico nuevo ni corregir la atención ya reportada al RDACAA', async () => {
    const prisma = db();
    const { encounter, editor } = await aDischargedEncounter(prisma);

    // Positive control: discharged and not reported, both go in.
    await createDiagnosis(prisma, encounter.id, 'R50');
    await correct(prisma, encounter.id, editor.id, nextStamp(), 'SUBSEQUENT');

    await prisma.$executeRaw`
      UPDATE encounter SET reported_at = ${nextStamp()} WHERE id = ${encounter.id}::uuid`;

    await expect(createDiagnosis(prisma, encounter.id, 'I10')).rejects.toThrow(
      /encounter_diagnosis_reported/,
    );
    await expect(
      correct(prisma, encounter.id, editor.id, nextStamp(), 'FIRST_TIME'),
    ).rejects.toThrow(/encounter_reported/);
  });

  it('EN-215 la BASE exige quién y cuándo juntos en la corrección de la atención (encounter_correction_stamped)', async () => {
    const prisma = db();
    const { encounter, editor } = await aDischargedEncounter(prisma);
    const stamp = (correctedById: string | null, correctedAt: Date | null) =>
      prisma.$executeRaw`
        UPDATE encounter
           SET corrected_by_id = ${correctedById}::uuid, corrected_at = ${correctedAt}
         WHERE id = ${encounter.id}::uuid`;

    await expect(stamp(editor.id, null)).rejects.toThrow(
      /encounter_correction_stamped/,
    );
    await expect(stamp(null, nextStamp())).rejects.toThrow(
      /encounter_correction_stamped/,
    );
    // Positive control: the same statement with both.
    await stamp(editor.id, nextStamp());
    const corrected = await prisma.encounter.findUniqueOrThrow({ where: { id: encounter.id } }); // prettier-ignore
    expect(corrected.correctedById).toBe(editor.id);
  });
});
