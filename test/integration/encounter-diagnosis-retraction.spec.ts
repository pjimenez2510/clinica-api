import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { addDays, clinicalDateOf } from '../../src/shared/domain/clinic-time';

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

async function anEncounterWithDiagnoses(
  prisma: PrismaClient,
  codes: string[] = ['J02', 'R50'],
) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  for (const code of codes) await createDiagnosis(prisma, encounter.id, code);
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

/** EN-130. The 002 was signed: the attention has its discharge. */
function discharge(
  prisma: PrismaClient,
  encounter: { id: string; startedAt: Date },
) {
  return prisma.encounter.update({
    where: { id: encounter.id },
    data: {
      status: 'DISCHARGED',
      endedAt: new Date(encounter.startedAt.getTime() + 20 * 60_000),
      dischargeCondition: 'ALIVE',
    },
  });
}

/** EN-212. A stamped rank change: every edit says who and when. */
async function moveRank(
  prisma: PrismaClient,
  diagnosisId: string,
  value: number,
) {
  const editor = await createUser(prisma);
  return prisma.$executeRaw`
    UPDATE encounter_diagnosis
       SET rank = ${value}, edited_by_id = ${editor.id}::uuid, edited_at = ${new Date()}
     WHERE id = ${diagnosisId}::uuid`;
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

  it('EN-181 EN-213 con la nota firmada la BASE ya no exige motivo; un motivo en blanco sigue sin ser motivo', async () => {
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

    // D-126.2: the signed note asks for a confirmation on the screen, and no
    // reason in the database.
    await expect(archive(prisma, first!.id, remover.id, '   ')).rejects.toThrow(
      /encounter_diagnosis_retraction_reason_not_blank/,
    );
    await archive(prisma, first!.id, remover.id);
    expect(await prisma.encounterDiagnosisRetraction.count({ where: { encounterId: encounter.id } })).toBe(2); // prettier-ignore
  });

  it('EN-188 EN-213 con el alta la BASE no exige motivo, y no deja quitar el último', async () => {
    const prisma = db();
    const { encounter, diagnoses, remover } =
      await anEncounterWithDiagnoses(prisma);
    const [first, second] = diagnoses;
    await discharge(prisma, encounter);

    // Positive control: without a reason, and another diagnosis left.
    await archive(prisma, second!.id, remover.id);
    await remove(prisma, second!.id);

    // The last one would leave a discharged attention with no diagnosis and
    // no way to code one (EN-009, D-117.12).
    await expect(
      archive(prisma, first!.id, remover.id, 'Código equivocado'),
    ).rejects.toThrow(/encounter_diagnosis_last_after_discharge/);
    expect(await prisma.encounterDiagnosis.count({ where: { encounterId: encounter.id } })).toBe(1); // prettier-ignore
  });

  it('EN-189 un certificado emitido —vigente o anulado— que imprimió el código hace que la BASE exija el motivo; uno que imprimió otro, no', async () => {
    const prisma = db();
    const { practitioner, encounter, diagnoses, remover } =
      await anEncounterWithDiagnoses(prisma);
    const [first, second] = diagnoses;
    let code = 0;
    const certificate = async (printed: string) => {
      const [row] = await prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO medical_certificate
          (encounter_id, patient_id, issued_by_id, type, verification_code,
           include_diagnosis, diagnoses)
        VALUES (${encounter.id}::uuid, ${encounter.patientId}::uuid,
                ${practitioner.id}::uuid, 'ATTENDANCE',
                ${`EN189-${String((code += 1))}-${encounter.id.slice(0, 8)}`},
                true,
                ${JSON.stringify([{ code: printed, display: 'x', certainty: 'PRESUMPTIVE' }])}::jsonb)
        RETURNING id`;
      return row!.id;
    };

    // Positive control: a certificate that printed ANOTHER code.
    await certificate('A09');
    await archive(prisma, second!.id, remover.id);

    const printedFirst = await certificate(first!.cie10Code);
    // In force…
    await expect(archive(prisma, first!.id, remover.id)).rejects.toThrow(
      /encounter_diagnosis_retraction_reason/,
    );
    // …and revoked: the paper may have circulated before.
    await prisma.$executeRaw`
      UPDATE medical_certificate
         SET revoked_at = now(), revoked_by_id = ${remover.id}::uuid,
             revocation_reason = 'Se emitió por error'
       WHERE id = ${printedFirst}::uuid`;

    await expect(archive(prisma, first!.id, remover.id)).rejects.toThrow(
      /encounter_diagnosis_retraction_reason/,
    );
    await archive(
      prisma,
      first!.id,
      remover.id,
      'El certificado decía J02 y era R50',
    );
    expect(await prisma.encounterDiagnosisRetraction.count({ where: { encounterId: encounter.id } })).toBe(2); // prettier-ignore
  });

  it('EN-214 una receta emitida —vigente o anulada— que imprimió el código hace que la BASE exija el motivo; con otro código, no', async () => {
    const prisma = db();
    const { site, practitioner, encounter, diagnoses, remover } =
      await anEncounterWithDiagnoses(prisma, ['J02']);
    const [printed] = diagnoses;
    // Issued now, it froze J02 (PR-026): the pharmacy holds the paper.
    const receta = await createIssuedPrescription(prisma, {
      encounterId: encounter.id,
      siteId: site.id,
      prescriberId: practitioner.id,
    });
    // Recorded after the issue: no paper printed it (positive control).
    await createDiagnosis(prisma, encounter.id, 'R50');
    const unprinted = await prisma.encounterDiagnosis.findFirstOrThrow({
      where: { encounterId: encounter.id, cie10Code: 'R50' },
    });
    await archive(prisma, unprinted.id, remover.id);
    await remove(prisma, unprinted.id);

    await expect(archive(prisma, printed!.id, remover.id)).rejects.toThrow(
      /encounter_diagnosis_retraction_reason/,
    );
    // Annulled, the paper may still have circulated.
    await prisma.prescription.update({
      where: { id: receta.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: remover.id, cancelReason: 'Pérdida' }, // prettier-ignore
    });
    await expect(archive(prisma, printed!.id, remover.id)).rejects.toThrow(
      /encounter_diagnosis_retraction_reason/,
    );
    await archive(prisma, printed!.id, remover.id, 'Código mal elegido');
  });

  it('EN-213 D-117.15 la BASE no quita el último diagnóstico obstétrico de un reposo de maternidad no anulado; anulado, sí', async () => {
    const prisma = db();
    const { practitioner, encounter, diagnoses, remover } =
      await anEncounterWithDiagnoses(prisma, ['O80', 'O82', 'R50']);
    const [o80, o82] = diagnoses;
    const day = clinicalDateOf(encounter.startedAt);
    const [rest] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO medical_certificate
        (encounter_id, patient_id, issued_by_id, type, rest_from, rest_to,
         include_diagnosis, verification_code, contingency_type,
         maternity_admission_on, birth_on, maternity_discharge_on, issued_at)
      VALUES (${encounter.id}::uuid, ${encounter.patientId}::uuid,
              ${practitioner.id}::uuid, 'MEDICAL_REST', ${day}::date,
              ${addDays(day, 83)}::date, false,
              ${`EN213M-${encounter.id.slice(0, 12)}`}, 'MATERNITY',
              ${addDays(day, -2)}::date, ${addDays(day, -1)}::date,
              ${day}::date, ${encounter.startedAt})
      RETURNING id`;

    // Positive control: another obstetric diagnosis still supports it.
    await archive(prisma, o80!.id, remover.id);
    await remove(prisma, o80!.id);

    await expect(archive(prisma, o82!.id, remover.id)).rejects.toThrow(
      /encounter_diagnosis_supports_maternity_rest/,
    );
    await prisma.$executeRaw`
      UPDATE medical_certificate
         SET revoked_at = ${new Date()}, revoked_by_id = ${remover.id}::uuid,
             revocation_reason = 'Se emitió por error'
       WHERE id = ${rest!.id}::uuid`;
    await archive(prisma, o82!.id, remover.id);
  });

  it('EN-213 D-117.16 la BASE no quita un diagnóstico de una atención reportada al RDACAA', async () => {
    const prisma = db();
    const { encounter, diagnoses, remover } = await anEncounterWithDiagnoses(
      prisma,
      ['J02', 'R50', 'R51'],
    );
    const [, second, third] = diagnoses;
    await discharge(prisma, encounter);
    // Positive control: discharged, not reported.
    await archive(prisma, second!.id, remover.id);
    await remove(prisma, second!.id);

    await prisma.encounter.update({ where: { id: encounter.id }, data: { reportedAt: new Date() } }); // prettier-ignore
    await expect(archive(prisma, third!.id, remover.id)).rejects.toThrow(
      /encounter_diagnosis_reported/,
    );
  });

  it('EN-213 deshacer: el archivo se marca recuperado UNA vez, hacia el diagnóstico que lo devuelve, y nada más de él cambia', async () => {
    const prisma = db();
    const { encounter, diagnoses, remover } =
      await anEncounterWithDiagnoses(prisma);
    const [, second] = diagnoses;
    await archive(prisma, second!.id, remover.id);
    await remove(prisma, second!.id);
    const restore = (restoredAs: string) =>
      prisma.$executeRaw`
        UPDATE encounter_diagnosis_retraction
           SET restored_at = ${new Date()}, restored_by_id = ${remover.id}::uuid,
               restored_as_id = ${restoredAs}::uuid
         WHERE id = ${second!.id}::uuid`;

    // Not towards a diagnosis that is not that one, back on this attention.
    await expect(restore(diagnoses[0]!.id)).rejects.toThrow(
      /encounter_diagnosis_retraction_restored_as_itself/,
    );
    await createDiagnosis(prisma, encounter.id, 'R50');
    const back = await prisma.encounterDiagnosis.findFirstOrThrow({
      where: { encounterId: encounter.id, cie10Code: 'R50' },
    });
    // Positive control.
    await restore(back.id);
    // Once.
    await expect(restore(back.id)).rejects.toThrow(
      /encounter_diagnosis_retraction_frozen/,
    );
    // And the rest of the archive still does not move.
    await expect(
      prisma.$executeRaw`UPDATE encounter_diagnosis_retraction SET reason = 'luego' WHERE id = ${second!.id}::uuid`,
    ).rejects.toThrow(/encounter_diagnosis_retraction_frozen/);
    await expect(
      prisma.$executeRaw`UPDATE encounter_diagnosis_retraction SET restored_at = NULL, restored_by_id = NULL, restored_as_id = NULL WHERE id = ${second!.id}::uuid`,
    ).rejects.toThrow(/encounter_diagnosis_retraction_frozen/);
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
    await moveRank(prisma, first!.id, 9);
    // EN-214: the receta printed it, so removing it states why.
    await archive(prisma, second!.id, remover.id, 'Código mal elegido');
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
    // ORD-098. Lines go in while it is a draft; issued, it cites the diagnoses.
    await prisma.serviceOrder.update({
      where: { id: order.id },
      data: { status: 'ISSUED' },
    });

    await expect(archive(prisma, second!.id, remover.id)).rejects.toThrow(
      /encounter_diagnosis_cited/,
    );
    await expect(moveRank(prisma, first!.id, 9)).rejects.toThrow(
      /encounter_diagnosis_cited/,
    );

    // Positive control: the exam cancelled (ORD-007), the way out is open.
    await prisma.serviceOrderItem.update({
      where: { id: order.items[0]!.id },
      data: {
        status: 'CANCELLED',
        cancelledById: (await createUser(prisma)).id,
      },
    });
    await archive(prisma, second!.id, remover.id);
    await remove(prisma, second!.id);
  });

  it('EN-182 ORD-102 una orden en borrador o descartada no impide quitar un diagnóstico; emitida, sí', async () => {
    const prisma = db();
    const { site, practitioner, encounter, diagnoses, remover } =
      await anEncounterWithDiagnoses(prisma);
    const [first, second] = diagnoses;
    const exam = await aTariffConcept(prisma);
    const anOrder = () =>
      prisma.serviceOrder.create({
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
      });
    const draft = await anOrder();
    const discarded = await anOrder();
    await prisma.serviceOrder.update({
      where: { id: discarded.id },
      data: {
        status: 'DISCARDED',
        discardedAt: new Date(),
        discardedById: remover.id,
      },
    });

    // Never left the consultation: nothing outside cites the diagnoses.
    await moveRank(prisma, first!.id, 9);

    // Positive control: the same draft, issued, blocks the same change.
    await prisma.serviceOrder.update({
      where: { id: draft.id },
      data: { status: 'ISSUED' },
    });
    await expect(archive(prisma, second!.id, remover.id)).rejects.toThrow(
      /encounter_diagnosis_cited/,
    );
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
