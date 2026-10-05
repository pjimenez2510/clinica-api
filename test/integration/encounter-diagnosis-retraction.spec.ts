import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { aTariffConcept } from './orders-fixtures';
import { useDatabase } from './setup/database';
import {
  createDiagnosis,
  createEncounter,
  createIssuedPrescription,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * EN-180 to EN-183 against a real PostgreSQL, through raw SQL as well as the
 * client: what is proved here is the DATABASE, so that an import, a `psql` or
 * a use case written in two years cannot remove a diagnosis without a trace.
 * Every refusal has its positive control beside it.
 */
const db = useDatabase();

async function anEncounterWithDiagnoses(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  await createDiagnosis(prisma, encounter.id, 'J02');
  await createDiagnosis(prisma, encounter.id, 'R50');
  const diagnoses = await prisma.encounterDiagnosis.findMany({
    where: { encounterId: encounter.id },
    orderBy: { rank: 'asc' },
  });
  const remover = await createUser(prisma);
  return { site, practitioner, encounter, diagnoses, remover };
}

/** Archives the diagnosis exactly as it is, with who removed it and why. */
function archive(
  prisma: PrismaClient,
  diagnosisId: string,
  removerId: string,
  reason: string | null = null,
) {
  return prisma.$executeRaw`
    INSERT INTO encounter_diagnosis_retraction
      (id, encounter_id, concept_id, cie10_code, cie10_display, certainty,
       occurrence, rank, notifiable, note, recorded_at, retracted_by_id, reason)
    SELECT id, encounter_id, concept_id, cie10_code, cie10_display, certainty,
           occurrence, rank, notifiable, note, recorded_at, ${removerId}::uuid, ${reason}
      FROM encounter_diagnosis WHERE id = ${diagnosisId}::uuid`;
}

function remove(prisma: PrismaClient, diagnosisId: string) {
  return prisma.$executeRaw`DELETE FROM encounter_diagnosis WHERE id = ${diagnosisId}::uuid`;
}

describe('quitar un diagnóstico deja rastro (EN-180 a EN-183)', () => {
  it('EN-180 la BASE no borra un diagnóstico sin archivarlo; archivado, sí, y el archivo lo conserva entero', async () => {
    const prisma = db();
    const { diagnoses, remover } = await anEncounterWithDiagnoses(prisma);
    const [, second] = diagnoses;

    await expect(remove(prisma, second!.id)).rejects.toThrow(
      /encounter_diagnosis_archived/,
    );
    expect(await prisma.encounterDiagnosis.count({ where: { id: second!.id } })).toBe(1); // prettier-ignore

    await archive(prisma, second!.id, remover.id);
    await remove(prisma, second!.id);

    expect(await prisma.encounterDiagnosis.count({ where: { id: second!.id } })).toBe(0); // prettier-ignore
    const archived =
      await prisma.encounterDiagnosisRetraction.findUniqueOrThrow({
        where: { id: second!.id },
      });
    expect(archived).toMatchObject({
      cie10Code: second!.cie10Code,
      rank: second!.rank,
      retractedById: remover.id,
      reason: null,
    });
  });

  it('EN-180 la BASE rechaza archivar una versión arreglada del diagnóstico', async () => {
    const prisma = db();
    const { diagnoses, remover } = await anEncounterWithDiagnoses(prisma);
    const [first] = diagnoses;

    await expect(
      prisma.$executeRaw`
        INSERT INTO encounter_diagnosis_retraction
          (id, encounter_id, concept_id, cie10_code, cie10_display, certainty,
           occurrence, rank, notifiable, note, recorded_at, retracted_by_id)
        SELECT id, encounter_id, concept_id, cie10_code, 'Otra cosa', certainty,
               occurrence, rank, notifiable, note, recorded_at, ${remover.id}::uuid
          FROM encounter_diagnosis WHERE id = ${first!.id}::uuid`,
    ).rejects.toThrow(/encounter_diagnosis_retraction_matches/);
  });

  it('EN-180 el archivo no se edita, no se borra y no se vacía', async () => {
    const prisma = db();
    const { diagnoses, remover } = await anEncounterWithDiagnoses(prisma);
    const [, second] = diagnoses;
    await archive(prisma, second!.id, remover.id);

    await expect(
      prisma.$executeRaw`UPDATE encounter_diagnosis_retraction SET reason = 'luego' WHERE id = ${second!.id}::uuid`,
    ).rejects.toThrow(/encounter_diagnosis_retraction_frozen/);
    await expect(
      prisma.$executeRaw`DELETE FROM encounter_diagnosis_retraction WHERE id = ${second!.id}::uuid`,
    ).rejects.toThrow(/encounter_diagnosis_retraction_frozen/);
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE encounter_diagnosis_retraction'),
    ).rejects.toThrow(/encounter_diagnosis_retraction_frozen/);
    expect(await prisma.encounterDiagnosisRetraction.count({ where: { id: second!.id } })).toBe(1); // prettier-ignore
  });

  it('EN-181 con la nota firmada la BASE exige el motivo; sin nota firmada, no', async () => {
    const prisma = db();
    const { practitioner, encounter, diagnoses, remover } =
      await anEncounterWithDiagnoses(prisma);
    const [first, second] = diagnoses;

    // Positive control: no signed note, no reason needed.
    await archive(prisma, second!.id, remover.id);

    await prisma.clinicalNote.create({
      data: {
        chainId: encounter.id,
        formCode: '002',
        encounterId: encounter.id,
        authorId: practitioner.id,
        content: { motivo: 'odinofagia' },
        status: 'SIGNED',
        signedById: practitioner.id,
        signedAt: encounter.startedAt,
        contentHash: 'a'.repeat(64),
      },
    });

    await expect(archive(prisma, first!.id, remover.id)).rejects.toThrow(
      /encounter_diagnosis_retraction_reason/,
    );
    await expect(archive(prisma, first!.id, remover.id, '   ')).rejects.toThrow(
      /encounter_diagnosis_retraction_reason_not_blank/,
    );
    await archive(prisma, first!.id, remover.id, 'Era R50, no J02');
    expect(await prisma.encounterDiagnosisRetraction.count({ where: { encounterId: encounter.id } })).toBe(2); // prettier-ignore
  });

  it('EN-182 PR-026 la receta emitida CONGELA sus diagnósticos: quitar o reordenar después no cambia lo que dice', async () => {
    const prisma = db();
    const { site, practitioner, encounter, diagnoses, remover } =
      await anEncounterWithDiagnoses(prisma);
    const [first, second] = diagnoses;

    const issued = await createIssuedPrescription(prisma, {
      encounterId: encounter.id,
      siteId: site.id,
      prescriberId: practitioner.id,
    });
    const frozen = [
      { code: first!.cie10Code, display: first!.cie10Display },
      { code: second!.cie10Code, display: second!.cie10Display },
    ];
    expect(issued.diagnoses).toEqual(frozen);

    // Nothing blocks the correction now, and the receta still says the same.
    await prisma.$executeRaw`UPDATE encounter_diagnosis SET rank = 9 WHERE id = ${first!.id}::uuid`;
    await archive(prisma, second!.id, remover.id);
    await remove(prisma, second!.id);

    const after = await prisma.prescription.findUniqueOrThrow({ where: { id: issued.id } }); // prettier-ignore
    expect(after.diagnoses).toEqual(frozen);
    // And a draft never froze anything.
    const draft = await prisma.prescription.create({
      data: { encounterId: encounter.id, siteId: site.id, prescriberId: practitioner.id }, // prettier-ignore
    });
    expect(draft.diagnoses).toBeNull();
  });

  it('EN-182 una orden con exámenes vivos impide quitar y reordenar; con todos anulados, no', async () => {
    const prisma = db();
    const { site, practitioner, encounter, diagnoses, remover } =
      await anEncounterWithDiagnoses(prisma);
    const [first, second] = diagnoses;
    const exam = await aTariffConcept(prisma);
    const order = await prisma.serviceOrder.create({
      data: {
        encounterId: encounter.id,
        siteId: site.id,
        orderedById: practitioner.id,
        category: 'LABORATORY',
        items: {
          create: {
            conceptId: exam.id,
            testCode: exam.code,
            testDisplay: exam.display,
          },
        },
      },
      include: { items: true },
    });

    await expect(archive(prisma, second!.id, remover.id)).rejects.toThrow(
      /encounter_diagnosis_cited/,
    );
    await expect(
      prisma.$executeRaw`UPDATE encounter_diagnosis SET rank = 9 WHERE id = ${first!.id}::uuid`,
    ).rejects.toThrow(/encounter_diagnosis_cited/);

    // Positive control: the exam cancelled (ORD-007), the way out is open.
    await prisma.serviceOrderItem.update({
      where: { id: order.items[0]!.id },
      data: { status: 'CANCELLED' },
    });
    await archive(prisma, second!.id, remover.id);
    await remove(prisma, second!.id);
  });

  it('EN-180 lo que un diagnóstico ES no se reescribe: ni su código ni su concepto; el resto, sí', async () => {
    const prisma = db();
    const { diagnoses } = await anEncounterWithDiagnoses(prisma);
    const [first] = diagnoses;

    await expect(
      prisma.$executeRaw`UPDATE encounter_diagnosis SET cie10_display = 'Otra cosa' WHERE id = ${first!.id}::uuid`,
    ).rejects.toThrow(/encounter_diagnosis_identity_frozen/);
    // Positive control: what it is not — its certainty, its note — moves.
    await prisma.encounterDiagnosis.update({
      where: { id: first!.id },
      data: { certainty: 'PRESUMPTIVE', note: 'pendiente de cultivo' },
    });
  });

  it('EN-180 la BASE no vacía la tabla de diagnósticos', async () => {
    const prisma = db();
    await anEncounterWithDiagnoses(prisma);

    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE encounter_diagnosis'),
    ).rejects.toThrow(/frozen/);
    expect(await prisma.encounterDiagnosis.count()).toBe(2);
  });
});
