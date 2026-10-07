import type { PrismaClient } from '@prisma/client';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';

import { PrismaDocumentSourceReader } from '../../src/modules/documents/infrastructure/prisma-document-source.reader';
import { PatientMergeService } from '../../src/modules/patients/application/patient-merge.service';
import { PrismaPatientRepository } from '../../src/modules/patients/infrastructure/prisma-patient.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * CER-058 (D-171.2): the certificate FREEZES the patient's sex when it is
 * issued, as it froze its diagnoses (CER-027) and work data (CER-038), and as
 * the exam order freezes it (ORD-158). Until now form 117 read the chart's
 * sex live, so correcting the chart afterwards changed a paper the employer
 * or the IESS already held, every time it was generated again.
 *
 * Proved against PostgreSQL: the copy is written by a trigger at the insert,
 * whatever the writer sends, and `medical_certificate_frozen` (CER-011) keeps
 * it. Each refusal has its positive control: the chart DID change, and a
 * certificate issued afterwards says the new sex.
 */
const db = useDatabase();

const client = (prisma: PrismaClient) => prisma as unknown as PrismaService;

let codes = 0;
/** Unique per call, without Math.random: a failing test must be reproducible. */
const nextCode = (): string => `VS-${String(++codes).padStart(8, '0')}`;

/** A woman's open attention. */
async function aScene(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma, { sex: 'FEMALE' });
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  return { site, practitioner, patient, encounter };
}

type Scene = Awaited<ReturnType<typeof aScene>>;

/**
 * An attendance certificate inserted the way a `psql` or an import would,
 * carrying whatever sex the writer chose: the trigger has to ignore it.
 */
async function insertCertificate(
  prisma: PrismaClient,
  scene: Scene,
  sentSex: 'MALE' | 'FEMALE' | null = null,
): Promise<string> {
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO medical_certificate
      (encounter_id, patient_id, issued_by_id, type, verification_code, issued_at, patient_sex)
    VALUES (${scene.encounter.id}::uuid, ${scene.patient.id}::uuid,
            ${scene.practitioner.id}::uuid, 'ATTENDANCE'::certificate_type,
            ${nextCode()}, ${scene.encounter.startedAt},
            COALESCE(${sentSex}::patient_sex, 'UNKNOWN'))
    RETURNING id`;
  return row!.id;
}

const frozenSexOf = async (prisma: PrismaClient, id: string) =>
  (
    await prisma.$queryRaw<{ patient_sex: string }[]>`
      SELECT patient_sex::text FROM medical_certificate WHERE id = ${id}::uuid`
  )[0]?.patient_sex;

/** What form 117 —the PDF, generated again— prints as the sex. */
async function printedSexOf(prisma: PrismaClient, id: string) {
  const subject = await new PrismaDocumentSourceReader(
    client(prisma),
    'http://localhost/verificar',
  ).findSubject({ kind: 'MEDICAL_CERTIFICATE', subjectId: id, sites: 'all' });
  if (subject?.kind !== 'MEDICAL_CERTIFICATE') throw new Error('no 117');
  return subject.data.form.patient.sex;
}

const mergesOf = (prisma: PrismaClient) =>
  new PatientMergeService(
    new PrismaPatientRepository(client(prisma)),
    { record: () => Promise.resolve() },
    { setContext: vi.fn(), info: vi.fn() } as unknown as PinoLogger,
  );

describe('CER-058 el certificado congela el sexo de la ficha al emitirse', () => {
  it('CER-058 la BASE copia el de la ficha aunque el INSERT traiga otro, y no deja reescribirlo', async () => {
    const prisma = db();
    const scene = await aScene(prisma);

    const id = await insertCertificate(prisma, scene, 'MALE');
    expect(await frozenSexOf(prisma, id)).toBe('FEMALE');

    await expect(
      prisma.$executeRaw`UPDATE medical_certificate SET patient_sex = 'MALE' WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/medical_certificate_frozen/);
    // Control positivo: lo que la anulación escribe sí se escribe.
    await prisma.medicalCertificate.update({
      where: { id },
      data: {
        revokedAt: new Date(),
        revokedById: (await createUser(prisma)).id,
        revocationReason: 'Error de digitación',
      },
    });
    expect(await frozenSexOf(prisma, id)).toBe('FEMALE');
  });

  it('CER-058 corregir la ficha después no cambia el 117 al volver a generarlo; el certificado nuevo dice el nuevo', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const before = await insertCertificate(prisma, scene);
    expect(await printedSexOf(prisma, before)).toBe('Mujer');

    await prisma.patient.update({
      where: { id: scene.patient.id },
      data: { sex: 'MALE' },
    });

    expect(await printedSexOf(prisma, before)).toBe('Mujer');
    // Control positivo: la ficha sí cambió, y lo emitido ahora lo dice.
    const after = await insertCertificate(prisma, scene);
    expect(await printedSexOf(prisma, after)).toBe('Hombre');
  });

  it('CER-058 en la atención de una ficha unificada copia el sexo de la vigente', async () => {
    const prisma = db();
    const scene = await aScene(prisma);
    const survivor = await createPatient(prisma, { sex: 'MALE' });
    // Control positivo: sin unificar, el de la ficha de la atención.
    expect(
      await frozenSexOf(prisma, await insertCertificate(prisma, scene)),
    ).toBe('FEMALE');

    await mergesOf(prisma).merge(
      { sourcePatientId: scene.patient.id, targetPatientId: survivor.id },
      { userId: (await createUser(prisma)).id },
    );
    const merged = await insertCertificate(prisma, scene);
    expect(await frozenSexOf(prisma, merged)).toBe('MALE');
    expect(await printedSexOf(prisma, merged)).toBe('Hombre');
  });
});
