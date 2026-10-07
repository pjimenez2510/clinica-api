import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaDocumentSourceReader } from '../../src/modules/documents/infrastructure/prisma-document-source.reader';
import { clinicalDateOf } from '../../src/shared/domain/clinic-time';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createDiagnosis,
  createIssuedPrescription,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * DOC-116 (D-157.2): what the PRINTED receta reads about allergies, against
 * PostgreSQL. The standing «sin alergias conocidas» is a rule over two tables
 * and the merge link (`standingAbsenceFor`, D-A-018), so only the database can
 * show the reader applies it: asserted on an absorbed chart, superseded by an
 * allergy recorded after it even once refuted, and not read at all when an
 * allergy is active.
 */
const db = useDatabase();

const reader = (prisma: PrismaClient) =>
  new PrismaDocumentSourceReader(
    prisma as unknown as PrismaService,
    'http://localhost/verificar',
  );

/** An issued receta on a fresh chart, and the chart. */
async function aReceta(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await prisma.encounter.create({
    data: {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
      startedAt: new Date(),
      careModality: 'MORBIDITY',
      visitSequence: 'FIRST_TIME',
    },
  });
  await createDiagnosis(prisma, encounter.id, 'J02.9', 'Faringitis aguda');
  const prescription = await createIssuedPrescription(prisma, {
    encounterId: encounter.id,
    siteId: site.id,
    prescriberId: practitioner.id,
    items: {
      create: [
        {
          genericName: 'Amoxicilina',
          presentation: 'Cápsula',
          concentration: '500 mg',
          routeCode: 'ORAL',
          quantity: 21,
          doseText: '1 cápsula',
          frequencyText: 'Cada 8 horas',
          durationDays: 7,
          // PR-110. Without a concept the line is outside the cuadro.
          offFormulary: true,
        },
      ],
    },
  });
  return { patient, prescription };
}

/** What the printed receta is handed about allergies. */
async function printed(prisma: PrismaClient, prescriptionId: string) {
  const subject = await reader(prisma).findSubject({
    kind: 'PRESCRIPTION',
    subjectId: prescriptionId,
    sites: 'all',
  });
  if (subject?.kind !== 'PRESCRIPTION') throw new Error('no receta');
  return {
    allergies: subject.data.allergies,
    noKnownAllergies: subject.data.noKnownAllergies,
  };
}

describe('DOC-116 la receta impresa y el «sin alergias conocidas»', () => {
  it('DOC-116 sin nada, ninguna afirmación; afirmada en la ficha ABSORBIDA, con quién y cuándo; superada por una alergia posterior aunque se refute, ninguna', async () => {
    const prisma = db();
    const { patient, prescription } = await aReceta(prisma);
    const absorbed = await createPatient(prisma);
    await prisma.patient.update({
      where: { id: absorbed.id },
      data: { mergedIntoId: patient.id, mergedAt: new Date() },
    });

    await expect(printed(prisma, prescription.id)).resolves.toEqual({
      allergies: [],
      noKnownAllergies: null,
    });

    // Positive control: the assertion on the absorbed chart reaches the paper.
    const clinician = await createUser(prisma);
    const assertion = await prisma.patientAllergyAbsence.create({
      data: { patientId: absorbed.id, assertedById: clinician.id },
    });
    const asserted = await printed(prisma, prescription.id);
    expect(asserted.noKnownAllergies?.assertedByName).toBe('Carmen Salazar');
    expect(clinicalDateOf(asserted.noKnownAllergies!.assertedAt)).toBe(
      clinicalDateOf(assertion.assertedAt),
    );

    // EN-224: recorded after it and ruled out since — nobody asked since.
    const later = new Date(assertion.assertedAt.getTime() + 1000);
    await prisma.patientAllergy.create({
      data: {
        patientId: patient.id,
        recordedById: clinician.id,
        substanceText: 'Látex',
        recordedAt: later,
        refutedAt: new Date(later.getTime() + 1000),
        refutedById: clinician.id,
      },
    });
    await expect(printed(prisma, prescription.id)).resolves.toEqual({
      allergies: [],
      noKnownAllergies: null,
    });
  });

  it('DOC-116 una afirmación retirada no se imprime, y una anterior no vuelve detrás de ella', async () => {
    const prisma = db();
    const { patient, prescription } = await aReceta(prisma);
    const clinician = await createUser(prisma);
    const first = await prisma.patientAllergyAbsence.create({
      data: { patientId: patient.id, assertedById: clinician.id },
    });
    // Positive control: standing, it is printed.
    expect(
      (await printed(prisma, prescription.id)).noKnownAllergies,
    ).not.toBeNull();

    const second = await prisma.patientAllergyAbsence.create({
      data: {
        patientId: patient.id,
        assertedById: clinician.id,
        assertedAt: new Date(first.assertedAt.getTime() + 1000),
      },
    });
    await prisma.patientAllergyAbsence.update({
      where: { id: second.id },
      data: {
        retractedById: clinician.id,
        retractedAt: new Date(second.assertedAt.getTime() + 1000),
      },
    });
    expect(
      (await printed(prisma, prescription.id)).noKnownAllergies,
    ).toBeNull();
  });

  it('DOC-116 una receta de la ficha que después se ABSORBIÓ no imprime la afirmación de esa ficha: la superviviente puede tener una alergia', async () => {
    const prisma = db();
    const { patient: duplicate, prescription } = await aReceta(prisma);
    const clinician = await createUser(prisma);
    await prisma.patientAllergyAbsence.create({
      data: { patientId: duplicate.id, assertedById: clinician.id },
    });
    // Positive control: before the merge it stands and is printed.
    expect(
      (await printed(prisma, prescription.id)).noKnownAllergies,
    ).not.toBeNull();

    const survivor = await createPatient(prisma);
    await prisma.patientAllergy.create({
      data: {
        patientId: survivor.id,
        recordedById: clinician.id,
        substanceText: 'Penicilina',
        criticality: 'HIGH',
      },
    });
    await prisma.patient.update({
      where: { id: duplicate.id },
      data: { mergedIntoId: survivor.id, mergedAt: new Date() },
    });
    expect(
      (await printed(prisma, prescription.id)).noKnownAllergies,
    ).toBeNull();
  });

  it('PR-118 la receta de una ficha ya ABSORBIDA imprime la alergia de la superviviente', async () => {
    const prisma = db();
    const { patient: duplicate, prescription } = await aReceta(prisma);
    const survivor = await createPatient(prisma);
    await prisma.patientAllergy.create({
      data: {
        patientId: survivor.id,
        recordedById: (await createUser(prisma)).id,
        substanceText: 'Penicilina',
        criticality: 'HIGH',
      },
    });
    // Control positivo: sin la fusión es la alergia de OTRA persona y la
    // receta de la duplicada no la dice.
    expect((await printed(prisma, prescription.id)).allergies).toEqual([]);

    await prisma.patient.update({
      where: { id: duplicate.id },
      // `patient_merged_at_matches_link` exige las dos columnas o ninguna.
      data: { mergedIntoId: survivor.id, mergedAt: new Date() },
    });
    expect((await printed(prisma, prescription.id)).allergies).toEqual([
      'Penicilina',
    ]);
  });
});
