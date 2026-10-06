import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PrismaClinicalCodingRepository } from '../../src/modules/encounter/infrastructure/prisma-clinical-coding.repository';
import { addDays, clinicalDateOf } from '../../src/shared/domain/clinic-time';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

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
 * EN-212 (D-127): a diagnosis is EDITED in place — its code, its certainty,
 * its occurrence and which one is the principal — and the previous version is
 * kept by the DATABASE in `record_version`, with who and when.
 *
 * What only PostgreSQL can prove: that an edit without a new stamp is refused,
 * that the previous row lands in `record_version` in the same statement, that
 * the code still has to match its concept and be in force on the day of care,
 * and the refusals that survive the edit (a paper in a third party's hands, a
 * maternity rest, a report already sent). Every refusal has its positive
 * control beside it.
 */
const db = useDatabase();

/** Stamps from the test's clock, one second apart and in order. */
let tick = 0;
const nextStamp = () => new Date(Date.now() + (tick += 1) * 1000);

async function aCIE10Concept(prisma: PrismaClient, code: string) {
  const system = await prisma.catalogSystem.upsert({
    where: { code: 'CIE10' },
    create: { code: 'CIE10', name: 'CIE-10' },
    update: {},
  });
  return (
    (await prisma.catalogConcept.findFirst({
      where: { systemId: system.id, code },
    })) ??
    prisma.catalogConcept.create({
      data: {
        systemId: system.id,
        code,
        display: `Diagnóstico ${code}`,
        validFrom: new Date('2019-01-01'), // fecha-fija: vigente desde siempre
      },
    })
  );
}

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
  const editor = await createUser(prisma);
  return { site, practitioner, patient, encounter, diagnoses, editor };
}

/** Changes the code of a diagnosis, stamped, the way the adapter does. */
async function recode(
  prisma: PrismaClient,
  diagnosisId: string,
  code: string,
  editorId: string,
  reason: string | null = null,
) {
  const concept = await aCIE10Concept(prisma, code);
  return prisma.$executeRaw`
    UPDATE encounter_diagnosis
       SET concept_id = ${concept.id}::uuid, cie10_code = ${code},
           cie10_display = ${concept.display},
           edited_by_id = ${editorId}::uuid, edited_at = ${nextStamp()},
           edit_reason = ${reason}
     WHERE id = ${diagnosisId}::uuid`;
}

/** Moves a rank, stamped. */
function rank(
  prisma: PrismaClient,
  diagnosisId: string,
  value: number,
  editorId: string,
) {
  return prisma.$executeRaw`
    UPDATE encounter_diagnosis
       SET rank = ${value}, edited_by_id = ${editorId}::uuid,
           edited_at = ${nextStamp()}, edit_reason = NULL
     WHERE id = ${diagnosisId}::uuid`;
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

describe('editar un diagnóstico en el sitio (EN-212)', () => {
  it('EN-212 la BASE deja cambiar código, condición y ocurrencia, y guarda la versión anterior con quién y cuándo', async () => {
    const prisma = db();
    const { diagnoses, editor } = await anEncounterWithDiagnoses(prisma);
    const [first] = diagnoses;

    // Without a stamp nobody edits: the stamp is who and when.
    await expect(
      prisma.$executeRaw`UPDATE encounter_diagnosis SET certainty = 'PRESUMPTIVE' WHERE id = ${first!.id}::uuid`,
    ).rejects.toThrow(/record_version_change_is_stamped/);

    // Positive control: the code itself changes, stamped.
    await recode(prisma, first!.id, 'J03', editor.id);
    await prisma.$executeRaw`
      UPDATE encounter_diagnosis
         SET certainty = 'PRESUMPTIVE', occurrence = 'SUBSEQUENT',
             edited_by_id = ${editor.id}::uuid, edited_at = ${nextStamp()}
       WHERE id = ${first!.id}::uuid`;

    const now = await prisma.encounterDiagnosis.findUniqueOrThrow({
      where: { id: first!.id },
    });
    expect(now).toMatchObject({
      cie10Code: 'J03',
      cie10Display: 'Diagnóstico J03',
      certainty: 'PRESUMPTIVE',
      occurrence: 'SUBSEQUENT',
      editedById: editor.id,
    });

    const versions = await prisma.recordVersion.findMany({
      where: { resourceType: 'encounter_diagnosis', resourceId: first!.id },
      orderBy: { version: 'asc' },
    });
    expect(
      versions.map((version) => [
        version.version,
        (version.data as { cie10_code: string }).cie10_code,
        (version.data as { certainty: string }).certainty,
        version.changedById,
      ]),
    ).toEqual([
      [1, 'J02', 'DEFINITIVE', editor.id],
      [2, 'J03', 'DEFINITIVE', editor.id],
    ]);
  });

  it('EN-212 EN-041 EN-042 el código editado sigue siendo el de su concepto y regía el día de la atención', async () => {
    const prisma = db();
    const { diagnoses, editor } = await anEncounterWithDiagnoses(prisma);
    const [first] = diagnoses;
    const other = await aCIE10Concept(prisma, 'K21');
    const retired = await prisma.catalogConcept.create({
      data: {
        systemId: other.systemId,
        code: 'K29',
        display: 'Gastritis',
        validFrom: new Date('2019-01-01'), // fecha-fija: vigencia del catálogo
        validTo: new Date('2020-01-01'), // fecha-fija: retirado antes de la atención
      },
    });

    await expect(
      prisma.$executeRaw`
        UPDATE encounter_diagnosis
           SET concept_id = ${other.id}::uuid, cie10_code = 'J02',
               edited_by_id = ${editor.id}::uuid, edited_at = ${nextStamp()}
         WHERE id = ${first!.id}::uuid`,
    ).rejects.toThrow(/does not match concept/);
    await expect(
      prisma.$executeRaw`
        UPDATE encounter_diagnosis
           SET concept_id = ${retired.id}::uuid, cie10_code = 'K29',
               edited_by_id = ${editor.id}::uuid, edited_at = ${nextStamp()}
         WHERE id = ${first!.id}::uuid`,
    ).rejects.toThrow(/was not in force/);

    // Positive control: the concept and its own code. The display is the
    // concept's, whatever the writer sent.
    await prisma.$executeRaw`
      UPDATE encounter_diagnosis
         SET concept_id = ${other.id}::uuid, cie10_code = 'K21',
             cie10_display = 'Otra cosa',
             edited_by_id = ${editor.id}::uuid, edited_at = ${nextStamp()}
       WHERE id = ${first!.id}::uuid`;
    expect(
      await prisma.encounterDiagnosis.findUniqueOrThrow({
        where: { id: first!.id },
      }),
    ).toMatchObject({ cie10Code: 'K21', cie10Display: 'Diagnóstico K21' });
  });

  it('EN-212 con el alta la BASE deja cambiar el principal en un clic, y guarda el rango anterior', async () => {
    const prisma = db();
    const { encounter, diagnoses, editor } =
      await anEncounterWithDiagnoses(prisma);
    const [principal, second] = diagnoses;
    await discharge(prisma, encounter);

    // One transaction, as EN-183 moves them: at no COMMIT is the discharged
    // attention without a principal (encounter_diagnosis_primary_after_discharge).
    await prisma.$transaction(async (tx) => {
      await rank(tx as unknown as PrismaClient, principal!.id, 3, editor.id);
      await rank(tx as unknown as PrismaClient, second!.id, 1, editor.id);
    });

    expect(
      (
        await prisma.encounterDiagnosis.findMany({
          where: { encounterId: encounter.id },
          orderBy: { rank: 'asc' },
        })
      ).map((d) => [d.cie10Code, d.rank]),
    ).toEqual([
      ['R50', 1],
      ['J02', 3],
    ]);
    const [kept] = await prisma.recordVersion.findMany({
      where: { resourceType: 'encounter_diagnosis', resourceId: principal!.id },
    });
    expect((kept!.data as { rank: number }).rank).toBe(1);
    // EN-043 still: never two principals.
    await expect(rank(prisma, principal!.id, 1, editor.id)).rejects.toThrow(
      /encounter_diagnosis_one_primary/,
    );
  });

  it('EN-212 si un certificado o una receta emitidos imprimieron el código, cambiarlo exige motivo en la BASE; la condición no', async () => {
    const prisma = db();
    const { site, practitioner, encounter, diagnoses, editor } =
      await anEncounterWithDiagnoses(prisma);
    const [first, second] = diagnoses;
    await prisma.$executeRaw`
      INSERT INTO medical_certificate
        (encounter_id, patient_id, issued_by_id, type, verification_code,
         include_diagnosis, diagnoses)
      VALUES (${encounter.id}::uuid, ${encounter.patientId}::uuid,
              ${practitioner.id}::uuid, 'ATTENDANCE',
              ${`EN212-${encounter.id.slice(0, 12)}`}, true,
              ${JSON.stringify([{ code: 'J02', display: 'x', certainty: 'DEFINITIVE' }])}::jsonb)`;

    await expect(recode(prisma, first!.id, 'J03', editor.id)).rejects.toThrow(
      /encounter_diagnosis_edit_reason/,
    );
    await expect(
      recode(prisma, first!.id, 'J03', editor.id, '   '),
    ).rejects.toThrow(/encounter_diagnosis_edit_reason_not_blank/);
    // Positive controls: what the paper did not print, and with the reason.
    await prisma.$executeRaw`
      UPDATE encounter_diagnosis
         SET certainty = 'PRESUMPTIVE',
             edited_by_id = ${editor.id}::uuid, edited_at = ${nextStamp()}
       WHERE id = ${first!.id}::uuid`;
    await recode(prisma, first!.id, 'J03', editor.id, 'Código mal elegido');

    // A receta issued now froze R50 (PR-026): the pharmacy holds it.
    await createIssuedPrescription(prisma, {
      encounterId: encounter.id,
      siteId: site.id,
      prescriberId: practitioner.id,
    });
    await expect(recode(prisma, second!.id, 'R51', editor.id)).rejects.toThrow(
      /encounter_diagnosis_edit_reason/,
    );
    await recode(prisma, second!.id, 'R51', editor.id, 'Código mal elegido');
  });

  it('EN-212 D-117.16 una atención ya reportada al RDACAA no se corrige en la BASE', async () => {
    const prisma = db();
    const { encounter, diagnoses, editor } =
      await anEncounterWithDiagnoses(prisma);
    const [first] = diagnoses;
    await discharge(prisma, encounter);

    // Positive control: discharged and not reported, it is corrected.
    await recode(prisma, first!.id, 'J03', editor.id);

    await prisma.$executeRaw`UPDATE encounter SET reported_at = ${nextStamp()} WHERE id = ${encounter.id}::uuid`;
    await expect(recode(prisma, first!.id, 'J02', editor.id)).rejects.toThrow(
      /encounter_diagnosis_reported/,
    );
  });

  it('EN-212 D-117.15 el diagnóstico obstétrico de un reposo de maternidad vigente no cambia de capítulo; dentro del capítulo, sí', async () => {
    const prisma = db();
    const { practitioner, encounter, diagnoses, editor } =
      await anEncounterWithDiagnoses(prisma, ['O80']);
    const [obstetric] = diagnoses;
    const day = clinicalDateOf(encounter.startedAt);
    const [rest] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO medical_certificate
        (encounter_id, patient_id, issued_by_id, type, rest_from, rest_to,
         include_diagnosis, verification_code, contingency_type,
         maternity_admission_on, birth_on, maternity_discharge_on, issued_at)
      VALUES (${encounter.id}::uuid, ${encounter.patientId}::uuid,
              ${practitioner.id}::uuid, 'MEDICAL_REST', ${day}::date,
              ${addDays(day, 83)}::date, true,
              ${`EN212M-${encounter.id.slice(0, 12)}`}, 'MATERNITY',
              ${addDays(day, -2)}::date, ${addDays(day, -1)}::date,
              ${day}::date, ${encounter.startedAt})
      RETURNING id`;

    await expect(
      recode(prisma, obstetric!.id, 'J02', editor.id, 'Código mal elegido'),
    ).rejects.toThrow(/encounter_diagnosis_supports_maternity_rest/);
    // Positive control: another obstetric code keeps the rest supported.
    await recode(prisma, obstetric!.id, 'O82', editor.id, 'Código mal elegido');

    // Annulled, the rest no longer needs it.
    await prisma.$executeRaw`
      UPDATE medical_certificate
         SET revoked_at = ${nextStamp()}, revoked_by_id = ${editor.id}::uuid,
             revocation_reason = 'Se emitió por error'
       WHERE id = ${rest!.id}::uuid`;
    await recode(prisma, obstetric!.id, 'J02', editor.id, 'Código mal elegido');
  });

  it('EN-212 la BASE no deja mover un diagnóstico a otra atención, ni siquiera con sello (encounter_diagnosis_stays_on_its_encounter)', async () => {
    const prisma = db();
    const { encounter, diagnoses, editor } =
      await anEncounterWithDiagnoses(prisma);
    const [, second] = diagnoses;
    const other = await createEncounter(prisma, {
      siteId: encounter.siteId,
      practitionerId: encounter.practitionerId,
      patientId: encounter.patientId,
    });

    // Positive control: the same stamped statement, on its own attention.
    await prisma.$executeRaw`
      UPDATE encounter_diagnosis
         SET certainty = 'PRESUMPTIVE',
             edited_by_id = ${editor.id}::uuid, edited_at = ${nextStamp()}
       WHERE id = ${second!.id}::uuid`;

    await expect(
      prisma.$executeRaw`
        UPDATE encounter_diagnosis
           SET encounter_id = ${other.id}::uuid,
               edited_by_id = ${editor.id}::uuid, edited_at = ${nextStamp()}
         WHERE id = ${second!.id}::uuid`,
    ).rejects.toThrow(/encounter_diagnosis_stays_on_its_encounter/);
    const kept = await prisma.encounterDiagnosis.findUniqueOrThrow({ where: { id: second!.id } }); // prettier-ignore
    expect(kept.encounterId).toBe(encounter.id);
  });

  it('EN-212 la BASE exige quién y cuándo juntos en la edición de un diagnóstico (encounter_diagnosis_edit_stamped)', async () => {
    const prisma = db();
    const { encounter, editor } = await anEncounterWithDiagnoses(prisma, [
      'J02',
    ]);
    const concept = await aCIE10Concept(prisma, 'R50');
    const insert = (editedById: string | null, editedAt: Date | null) =>
      prisma.$executeRaw`
        INSERT INTO encounter_diagnosis
          (encounter_id, concept_id, cie10_code, certainty, occurrence, rank,
           edited_by_id, edited_at)
        VALUES (${encounter.id}::uuid, ${concept.id}::uuid, 'R50',
                'DEFINITIVE', 'FIRST_TIME', 2,
                ${editedById}::uuid, ${editedAt})`;

    await expect(insert(editor.id, null)).rejects.toThrow(
      /encounter_diagnosis_edit_stamped/,
    );
    await expect(insert(null, nextStamp())).rejects.toThrow(
      /encounter_diagnosis_edit_stamped/,
    );
    // Positive control: both, or neither.
    await insert(editor.id, nextStamp());
    expect(
      await prisma.encounterDiagnosis.count({ where: { encounterId: encounter.id } }),
    ).toBe(2); // prettier-ignore
  });

  it('EN-212 D-117.13 bajo el bloqueo, el adaptador rechaza corregir tras el alta a quien firma en la sede con la licencia vencida: PRACTITIONER_NOT_LICENSED', async () => {
    const prisma = db();
    const { encounter, diagnoses, editor } =
      await anEncounterWithDiagnoses(prisma);
    const [, second] = diagnoses;
    const coding = new PrismaClinicalCodingRepository(
      prisma as unknown as PrismaService,
    );
    // What the service decided while the attention was still live: signs
    // here, the ACESS registration expired (D-117.13).
    const edit = {
      encounterId: encounter.id,
      diagnosisId: second!.id,
      certainty: 'PRESUMPTIVE' as const,
      reason: null,
      sites: [encounter.siteId],
      editedById: editor.id,
      mayCorrectAfterDischarge: false,
      afterDischargeRefusal: 'NOT_LICENSED' as const,
    };

    // Positive control: before the discharge the same edit goes in.
    await coding.editDiagnosis(edit);

    // The discharge lands before the lock.
    await discharge(prisma, encounter);
    await expect(
      coding.editDiagnosis({ ...edit, certainty: 'DEFINITIVE' }),
    ).rejects.toMatchObject({ code: 'PRACTITIONER_NOT_LICENSED' });
    await expect(
      coding.editDiagnosis({ ...edit, afterDischargeRefusal: 'NOT_SIGNER' }),
    ).rejects.toMatchObject({
      code: 'DIAGNOSIS_CORRECTION_REQUIRES_SIGNATURE',
    });
    const stored = await prisma.encounterDiagnosis.findUniqueOrThrow({ where: { id: second!.id } }); // prettier-ignore
    expect(stored.certainty).toBe('PRESUMPTIVE');
  });
});
