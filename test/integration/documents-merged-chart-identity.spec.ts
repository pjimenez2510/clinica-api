import type { PrismaClient } from '@prisma/client';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';

import { PrismaDocumentSourceReader } from '../../src/modules/documents/infrastructure/prisma-document-source.reader';
import { PrismaServiceOrderRepository } from '../../src/modules/orders/infrastructure/prisma-service-order.repository';
import { PatientMergeService } from '../../src/modules/patients/application/patient-merge.service';
import { PrismaPatientRepository } from '../../src/modules/patients/infrastructure/prisma-patient.repository';
import { PrismaPrescriptionRepository } from '../../src/modules/prescription/infrastructure/prisma-prescription.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { aScene, placeIssued } from './orders-fixtures';
import { useDatabase } from './setup/database';
import {
  createDiagnosis,
  createIssuedPrescription,
  createPatient,
  createUser,
} from './setup/fixtures';

/**
 * DOC-117, PR-119 (D-169.2 c and i): what the papers of an attention say about
 * WHO the patient is when the attention's chart was merged into another one.
 *
 * The merge looks at no attention (D-031), so a duplicate with its attention
 * open is absorbed by the real chart, and everything issued afterwards from
 * that attention printed the duplicate's name and —its document moves to the
 * survivor on merging (PA-043)— no cédula at all. A pharmacy or a laboratory
 * matching that paper against the person in front of them matches nobody.
 *
 * THE MERGE IS THE REAL ONE (`PatientMergeService` over the real `patients`
 * repository): moving the identifiers is part of what is being proved.
 * Positive control on every reading: before merging, and again after undoing
 * it, the attention's own chart.
 */
const db = useDatabase();

const CEDULA = '1710034065';

const client = (prisma: PrismaClient) => prisma as unknown as PrismaService;

const mergesOf = (prisma: PrismaClient) =>
  new PatientMergeService(
    new PrismaPatientRepository(client(prisma)),
    { record: () => Promise.resolve() },
    { setContext: vi.fn(), info: vi.fn() } as unknown as PinoLogger,
  );

const readerOf = (prisma: PrismaClient) =>
  new PrismaDocumentSourceReader(client(prisma), 'http://localhost/verificar');

/**
 * A duplicate chart WITHOUT a document, registered in a hurry, with its
 * attention open and a receta and an exam order issued from it; and the real
 * chart of the same person, with her cédula and another birth date — so a
 * printed age that followed the survivor's chart would show.
 */
async function theScene(prisma: PrismaClient) {
  const scene = await aScene(prisma, { sex: 'FEMALE' });
  const duplicate = await prisma.patient.update({
    where: { id: scene.patient.id },
    data: { familyName: 'Pilco', givenName: 'Rosa' },
  });
  const survivor = await createPatient(prisma, {
    birthDate: new Date('2001-06-02'), // fecha-fija: sólo tiene que ser otra
  });
  await prisma.patient.update({
    where: { id: survivor.id },
    data: {
      familyName: 'Guamán',
      secondFamilyName: 'Pilco',
      givenName: 'María',
      secondGivenName: 'Rosa',
    },
  });
  await prisma.patientIdentifier.create({
    data: { patientId: survivor.id, type: 'CEDULA', value: CEDULA },
  });
  await createDiagnosis(
    prisma,
    scene.encounter.id,
    'J02.9',
    'Faringitis aguda',
  );
  const prescription = await createIssuedPrescription(prisma, {
    encounterId: scene.encounter.id,
    siteId: scene.site.id,
    prescriberId: scene.practitioner.id,
    items: {
      create: [
        {
          genericName: 'Paracetamol',
          presentation: 'Tableta',
          concentration: '500 mg',
          routeCode: 'ORAL',
          quantity: 10,
          doseText: '1 tableta',
          frequencyText: 'Cada 8 horas',
          durationDays: 3,
          offFormulary: true,
        },
      ],
    },
  });
  const order = await placeIssued(
    new PrismaServiceOrderRepository(client(prisma)),
    {
      encounterId: scene.encounter.id,
      category: 'LABORATORY',
      priority: 'ROUTINE',
      lines: [{ examDefinitionId: scene.bh.id }],
      sites: 'all',
    },
  );
  const frozenAge = await prisma.encounter.findUniqueOrThrow({
    where: { id: scene.encounter.id },
    select: { ageYears: true, ageMonths: true },
  });
  const desk = { userId: (await createUser(prisma)).id };
  return {
    prisma,
    duplicate,
    survivor,
    encounterId: scene.encounter.id,
    prescriptionId: prescription.id,
    orderId: order.id,
    frozenAge,
    merge: () =>
      mergesOf(prisma).merge(
        { sourcePatientId: duplicate.id, targetPatientId: survivor.id },
        desk,
      ),
    undo: () => mergesOf(prisma).undo({ sourcePatientId: duplicate.id }, desk),
  };
}

type Scene = Awaited<ReturnType<typeof theScene>>;

/** The patient identity each of the three papers is handed. */
async function printedIdentities(scene: Scene) {
  const reader = readerOf(scene.prisma);
  const receta = await reader.findSubject({
    kind: 'PRESCRIPTION',
    subjectId: scene.prescriptionId,
    sites: 'all',
  });
  const order = await reader.findSubject({
    kind: 'SERVICE_ORDER',
    subjectId: scene.orderId,
    sites: 'all',
  });
  const summary = await reader.findSubject({
    kind: 'ENCOUNTER_SUMMARY',
    subjectId: scene.encounterId,
    sites: 'all',
  });
  if (
    receta?.kind !== 'PRESCRIPTION' ||
    order?.kind !== 'SERVICE_ORDER' ||
    summary?.kind !== 'ENCOUNTER_SUMMARY'
  ) {
    throw new Error('a paper is missing');
  }
  return {
    receta: receta.data.patient,
    order: order.data.patient,
    summary: summary.data.patient,
    summarySex: summary.data.patientSex,
  };
}

const identityOf = (
  chart: { familyName: string; givenName: string; mrn: string },
  fullName: string,
  identifier: string | null,
  age: { ageYears: number | null; ageMonths: number | null },
) => ({
  fullName,
  identifier,
  mrn: chart.mrn,
  ageYears: age.ageYears,
  ageMonths: age.ageMonths,
});

describe('DOC-117 lo que se imprime en la atención de una ficha unificada', () => {
  it('DOC-117 la receta, la orden y el resumen imprimen nombre, cédula e historia de la vigente, con la edad de la atención', async () => {
    const scene = await theScene(db());
    const own = identityOf(
      scene.duplicate,
      'Pilco Rosa',
      null,
      scene.frozenAge,
    );

    // Control positivo: sin unificar, la ficha de la atención.
    expect(await printedIdentities(scene)).toEqual({
      receta: own,
      order: own,
      summary: own,
      summarySex: 'FEMALE',
    });

    await scene.merge();
    // La premisa, comprobada: la fusión real deja la duplicada absorbida, sin
    // documento, y su atención abierta.
    const absorbed = await scene.prisma.patient.findUniqueOrThrow({
      where: { id: scene.duplicate.id },
      select: { mergedIntoId: true },
    });
    expect(absorbed.mergedIntoId).toBe(scene.survivor.id);

    const vigente = identityOf(
      scene.survivor,
      'Guamán Pilco María Rosa',
      CEDULA,
      // La edad es la de la atención, no la de la fecha de nacimiento de la
      // vigente (art. 5.b.ii).
      scene.frozenAge,
    );
    expect(await printedIdentities(scene)).toEqual({
      receta: vigente,
      order: vigente,
      summary: vigente,
      summarySex: 'FEMALE',
    });
  });

  it('DOC-117 deshecha la unificación, los papeles vuelven a la ficha de la atención', async () => {
    const scene = await theScene(db());
    await scene.merge();
    // Control positivo: unificada, la vigente.
    expect((await printedIdentities(scene)).receta.mrn).toBe(
      scene.survivor.mrn,
    );

    await scene.undo();
    const own = identityOf(
      scene.duplicate,
      'Pilco Rosa',
      null,
      scene.frozenAge,
    );
    const after = await printedIdentities(scene);
    expect([after.receta, after.order, after.summary]).toEqual([own, own, own]);
  });

  it('DOC-117 el resumen dice el sexo de la vigente', async () => {
    const scene = await theScene(db());
    await scene.prisma.patient.update({
      where: { id: scene.survivor.id },
      data: { sex: 'MALE' },
    });
    // Control positivo: sin unificar, el de la ficha de la atención.
    expect((await printedIdentities(scene)).summarySex).toBe('FEMALE');

    await scene.merge();
    expect((await printedIdentities(scene)).summarySex).toBe('MALE');
  });
});

describe('PR-119 el documento de la receta en la atención de una ficha unificada', () => {
  const documentName = async (scene: Scene) => {
    const source = await new PrismaPrescriptionRepository(
      client(scene.prisma),
    ).documentOf({ prescriptionId: scene.prescriptionId, sites: 'all' });
    return (
      source && {
        familyName: source.patient.familyName,
        givenName: source.patient.givenName,
        ageYears: source.patient.ageYears,
      }
    );
  };

  it('PR-119 nombra a la persona de la vigente, con la edad de la atención', async () => {
    const scene = await theScene(db());
    // Control positivo: sin unificar, la ficha de la atención.
    expect(await documentName(scene)).toEqual({
      familyName: 'Pilco',
      givenName: 'Rosa',
      ageYears: scene.frozenAge.ageYears,
    });

    await scene.merge();
    expect(await documentName(scene)).toEqual({
      familyName: 'Guamán',
      givenName: 'María',
      ageYears: scene.frozenAge.ageYears,
    });
  });
});
