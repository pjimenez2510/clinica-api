import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { BULK_REFUTATION_NOTE } from '../../src/modules/encounter/domain/allergy-refutation';
import {
  AllergyAlreadyRefutedError,
  AllergyNotRefutedError,
  AllergyRefutedAloneError,
  ChartHasAllergiesError,
  HistoryNotRefutedError,
  PatientAllergyNotFoundError,
  RefutationReasonRequiredError,
} from '../../src/modules/encounter/domain/encounter.errors';
import { PrismaPatientAllergyRepository } from '../../src/modules/encounter/infrastructure/prisma-patient-allergy.repository';
import { PrismaPatientHistoryRepository } from '../../src/modules/encounter/infrastructure/prisma-patient-history.repository';
import { PrismaActiveAllergyReader } from '../../src/shared/infrastructure/clinical/prisma-active-allergy.reader';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createPatient,
  createPractitioner,
  createUser,
} from './setup/fixtures';

/**
 * EN-224, EN-225 and EN-226 (D-126, D-127) against a real PostgreSQL.
 *
 * An allergy and a history entry are now EDITED in place, refuted without a
 * written reason and reactivated when the refutation was a mistake; a «sin
 * alergias conocidas» is retracted. None of it deletes anything: what was
 * there before is in `record_version`, written by the database in the same
 * statement. That is what only a real database can show — a double returns
 * whatever it is told.
 */
const db = useDatabase();

const allergiesOf = (prisma: PrismaClient) =>
  new PrismaPatientAllergyRepository(prisma as unknown as PrismaService);

const historyOf = (prisma: PrismaClient) =>
  new PrismaPatientHistoryRepository(prisma as unknown as PrismaService);

const activeOf = (prisma: PrismaClient) =>
  new PrismaActiveAllergyReader(prisma as unknown as PrismaService);

/** An instant `minutes` from the moment the test runs. */
const minutesFromNow = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000);

async function aCnmbConcept(
  prisma: PrismaClient,
  code: string,
  display: string,
) {
  const system = await prisma.catalogSystem.upsert({
    where: { code: 'CNMB' },
    create: { code: 'CNMB', name: 'Catálogo CNMB' },
    update: {},
  });
  return prisma.catalogConcept.create({
    data: {
      systemId: system.id,
      code,
      display,
      validFrom: new Date(Date.now() - 365 * 86_400_000),
    },
  });
}

async function anAllergy(prisma: PrismaClient, patientId: string) {
  const author = await createUser(prisma);
  const allergy = await allergiesOf(prisma).record({
    patientId,
    substanceText: 'Penisilina',
    reaction: 'Urticaria',
    criticality: 'UNABLE_TO_ASSESS',
    recordedById: author.id,
  });
  return { author, allergy };
}

async function aHistoryEntry(prisma: PrismaClient, patientId: string) {
  const author = await createUser(prisma);
  const entry = await historyOf(prisma).record({
    patientId,
    kind: 'PERSONAL',
    description: 'Hipertensoin',
    recordedById: author.id,
  });
  return { author, entry };
}

describe('EN-224 descartar sin motivo y reactivar lo descartado por error', () => {
  it('EN-224 descarta una alergia sin motivo, y guarda el de la lista cuando se da', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const doctor = await createUser(prisma);
    const { allergy } = await anAllergy(prisma, patient.id);
    const other = await allergiesOf(prisma).record({
      patientId: patient.id,
      substanceText: 'Látex',
      criticality: 'LOW',
      recordedById: doctor.id,
    });

    const silent = await allergiesOf(prisma).refute({
      patientId: patient.id,
      allergyId: allergy.id,
      notes: null,
      now: minutesFromNow(0),
      refutedById: doctor.id,
    });
    // Control positivo: con motivo, el motivo queda.
    const reasoned = await allergiesOf(prisma).refute({
      patientId: patient.id,
      allergyId: other.id,
      notes: 'Prueba negativa',
      now: minutesFromNow(0),
      refutedById: doctor.id,
    });

    expect(silent).toMatchObject({ refutedNotes: null, refutedBy: { id: doctor.id } }); // prettier-ignore
    expect(silent?.refutedAt).not.toBeNull();
    expect(reasoned?.refutedNotes).toBe('Prueba negativa');
    expect(await activeOf(prisma).activeFor(patient.id)).toHaveLength(0);
  });

  it('EN-224 la base admite el antecedente descartado sin motivo, y sigue exigiendo quién y cuándo juntos', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const doctor = await createUser(prisma);
    const { entry } = await aHistoryEntry(prisma, patient.id);

    // Sin quién: la refutación a medias sigue rechazada.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE patient_history
            SET refuted_at = $2, changed_by = $3::uuid, changed_at = $2
          WHERE id = $1::uuid`,
        entry.id,
        minutesFromNow(0),
        doctor.id,
      ),
    ).rejects.toThrow(/patient_history_refutation_is_whole/);
    // Un motivo en blanco no es un motivo.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE patient_history
            SET refuted_at = $2, refuted_by = $3::uuid, refuted_notes = '  ',
                changed_by = $3::uuid, changed_at = $2
          WHERE id = $1::uuid`,
        entry.id,
        minutesFromNow(0),
        doctor.id,
      ),
    ).rejects.toThrow(/patient_history_refutation_is_whole/);

    // Control positivo: quién y cuándo, sin motivo, entra.
    await prisma.$executeRawUnsafe(
      `UPDATE patient_history
          SET refuted_at = $2, refuted_by = $3::uuid,
              changed_by = $3::uuid, changed_at = $2
        WHERE id = $1::uuid`,
      entry.id,
      minutesFromNow(0),
      doctor.id,
    );
    const stored = await prisma.patientHistory.findUniqueOrThrow({
      where: { id: entry.id },
    });
    expect(stored.refutedNotes).toBeNull();
    expect(stored.refutedById).toBe(doctor.id);
  });

  it('EN-224 reactivar la alergia descartada por error la devuelve a activa, y la refutación queda en la versión', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const doctor = await createUser(prisma);
    const nurse = await createUser(prisma);
    const { allergy } = await anAllergy(prisma, patient.id);
    const repository = allergiesOf(prisma);

    await repository.refute({
      patientId: patient.id,
      allergyId: allergy.id,
      notes: 'Registrada por error',
      now: minutesFromNow(0),
      refutedById: doctor.id,
    });
    const reactivated = await repository.reactivate({
      patientId: patient.id,
      allergyId: allergy.id,
      reactivatedById: nurse.id,
      now: minutesFromNow(1),
    });

    expect(reactivated).toMatchObject({
      refutedAt: null,
      refutedNotes: null,
      refutedBy: null,
    });
    expect((await activeOf(prisma).activeFor(patient.id)).map((a) => a.id)).toEqual([allergy.id]); // prettier-ignore
    expect(await prisma.patientAllergy.count()).toBe(1);

    // Las dos versiones anteriores: la vigente antes de descartarla, y la
    // descartada, con su motivo y quién, antes de reactivarla.
    const versions = await repository.versionsOf(patient.id, allergy.id);
    expect(versions?.map((v) => v.version)).toEqual([2, 1]);
    expect(versions?.[0]).toMatchObject({
      replacedBy: { id: nurse.id },
      allergy: {
        refutedNotes: 'Registrada por error',
        refutedBy: { id: doctor.id },
      },
    });
    expect(versions?.[0]?.allergy.refutedAt).not.toBeNull();
    expect(versions?.[1]).toMatchObject({
      replacedBy: { id: doctor.id },
      allergy: { refutedAt: null, substanceText: 'Penisilina' },
    });
  });

  it('EN-224 reactivar una alergia o un antecedente que siguen activos se rechaza', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const doctor = await createUser(prisma);
    const { allergy } = await anAllergy(prisma, patient.id);
    const { entry } = await aHistoryEntry(prisma, patient.id);

    await expect(
      allergiesOf(prisma).reactivate({
        patientId: patient.id,
        allergyId: allergy.id,
        reactivatedById: doctor.id,
        now: minutesFromNow(0),
      }),
    ).rejects.toBeInstanceOf(AllergyNotRefutedError);
    await expect(
      historyOf(prisma).reactivate({
        patientId: patient.id,
        historyId: entry.id,
        reactivatedById: doctor.id,
        now: minutesFromNow(0),
      }),
    ).rejects.toBeInstanceOf(HistoryNotRefutedError);

    // Control positivo: descartado, el mismo antecedente se reactiva.
    await historyOf(prisma).refute({
      patientId: patient.id,
      historyId: entry.id,
      notes: null,
      now: minutesFromNow(0),
      refutedById: doctor.id,
    });
    const back = await historyOf(prisma).reactivate({
      patientId: patient.id,
      historyId: entry.id,
      reactivatedById: doctor.id,
      now: minutesFromNow(1),
    });
    expect(back?.refutedAt).toBeNull();
    expect((await historyOf(prisma).activeFor(patient.id)).map((h) => h.id)).toEqual([entry.id]); // prettier-ignore
  });

  it('EN-224 EN-087 la alergia reactivada deja de servir el «sin alergias conocidas» afirmado mientras estaba descartada', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const practitioner = await createPractitioner(prisma);
    const { allergy } = await anAllergy(prisma, patient.id);
    const repository = allergiesOf(prisma);

    await repository.refute({
      patientId: patient.id,
      allergyId: allergy.id,
      notes: null,
      now: minutesFromNow(0),
      refutedById: practitioner.userId,
    });
    await prisma.patientAllergyAbsence.create({
      data: {
        patientId: patient.id,
        assertedById: practitioner.userId,
        assertedAt: minutesFromNow(1),
      },
    });
    // Control positivo: con la ficha vacía, la afirmación se sirve.
    expect(await repository.standingAbsenceFor(patient.id)).not.toBeNull();

    await repository.reactivate({
      patientId: patient.id,
      allergyId: allergy.id,
      reactivatedById: practitioner.userId,
      now: minutesFromNow(2),
    });

    expect(await repository.standingAbsenceFor(patient.id)).toBeNull();
  });
});

describe('EN-225 editar en su fila, con la versión anterior guardada', () => {
  it('EN-225 edita la sustancia, la reacción y la criticidad de una alergia y guarda la versión anterior con quién y cuándo', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const doctor = await createUser(prisma);
    const { author, allergy } = await anAllergy(prisma, patient.id);
    const at = minutesFromNow(0);

    const edited = await allergiesOf(prisma).edit({
      patientId: patient.id,
      allergyId: allergy.id,
      changes: {
        substanceText: 'Penicilina',
        reaction: null,
        criticality: 'HIGH',
      },
      editedById: doctor.id,
      now: at,
    });

    expect(edited).toMatchObject({
      id: allergy.id,
      substanceText: 'Penicilina',
      reaction: null,
      criticality: 'HIGH',
      // Quién la registró no cambia: sólo quién la editó.
      recordedBy: { id: author.id },
    });
    expect(edited?.changedAt?.getTime()).toBe(at.getTime());
    expect(await prisma.patientAllergy.count()).toBe(1);

    const versions = await allergiesOf(prisma).versionsOf(patient.id, allergy.id); // prettier-ignore
    expect(versions).toHaveLength(1);
    expect(versions?.[0]).toMatchObject({
      version: 1,
      replacedBy: { id: doctor.id, name: 'Carmen Salazar' },
      allergy: {
        substanceText: 'Penisilina',
        reaction: 'Urticaria',
        criticality: 'UNABLE_TO_ASSESS',
        recordedBy: { id: author.id },
      },
    });
    expect(versions?.[0]?.replacedAt.getTime()).toBe(at.getTime());
  });

  it('EN-225 EN-084 la comprobación al recetar lee la versión vigente de la alergia', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const doctor = await createUser(prisma);
    const amoxicillin = await aCnmbConcept(prisma, 'J01CA04', 'Amoxicilina');
    const cefalexin = await aCnmbConcept(prisma, 'J01DB01', 'Cefalexina');
    const allergy = await allergiesOf(prisma).record({
      patientId: patient.id,
      substanceConceptId: amoxicillin.id,
      substanceText: 'Amoxicilina',
      criticality: 'HIGH',
      recordedById: doctor.id,
    });

    await allergiesOf(prisma).edit({
      patientId: patient.id,
      allergyId: allergy.id,
      changes: {
        substanceConceptId: cefalexin.id,
        substanceText: 'Cefalexina',
      },
      editedById: doctor.id,
      now: minutesFromNow(0),
    });

    const [active] = await activeOf(prisma).activeFor(patient.id);
    expect(active).toMatchObject({
      substanceConceptId: cefalexin.id,
      substanceText: 'Cefalexina',
    });
  });

  it('EN-225 edita la descripción, el tipo y el parentesco de un antecedente con su versión', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const doctor = await createUser(prisma);
    const { author, entry } = await aHistoryEntry(prisma, patient.id);

    const edited = await historyOf(prisma).edit({
      patientId: patient.id,
      historyId: entry.id,
      changes: { kind: 'FAMILY', description: 'Hipertensión', relative: 'Madre' }, // prettier-ignore
      editedById: doctor.id,
      now: minutesFromNow(0),
    });

    expect(edited).toMatchObject({
      kind: 'FAMILY',
      description: 'Hipertensión',
      relative: 'Madre',
      recordedBy: { id: author.id },
    });
    const versions = await historyOf(prisma).versionsOf(patient.id, entry.id);
    expect(versions).toHaveLength(1);
    expect(versions?.[0]).toMatchObject({
      replacedBy: { id: doctor.id },
      entry: { kind: 'PERSONAL', description: 'Hipertensoin', relative: null },
    });
  });

  it('EN-225 no edita una alergia descartada: primero se reactiva', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const doctor = await createUser(prisma);
    const { allergy } = await anAllergy(prisma, patient.id);
    await allergiesOf(prisma).refute({
      patientId: patient.id,
      allergyId: allergy.id,
      notes: null,
      now: minutesFromNow(0),
      refutedById: doctor.id,
    });

    await expect(
      allergiesOf(prisma).edit({
        patientId: patient.id,
        allergyId: allergy.id,
        changes: { criticality: 'LOW' },
        editedById: doctor.id,
        now: minutesFromNow(1),
      }),
    ).rejects.toBeInstanceOf(AllergyAlreadyRefutedError);
  });

  it('EN-225 la base rechaza la edición sin sello, cambiar el paciente o el autor original, y borrar', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const stranger = await createPatient(prisma);
    const doctor = await createUser(prisma);
    const { allergy } = await anAllergy(prisma, patient.id);
    const { entry } = await aHistoryEntry(prisma, patient.id);

    for (const table of ['patient_allergy', 'patient_history']) {
      const id = table === 'patient_allergy' ? allergy.id : entry.id;
      const column = table === 'patient_allergy' ? 'reaction' : 'description';

      // Control positivo: con sello nuevo, la edición entra.
      await prisma.$executeRawUnsafe(
        `UPDATE ${table} SET ${column} = 'Corregido',
                changed_by = $2::uuid, changed_at = $3
          WHERE id = $1::uuid`,
        id,
        doctor.id,
        minutesFromNow(0),
      );
      // Sin sello nuevo, no.
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE ${table} SET ${column} = 'Otra vez' WHERE id = $1::uuid`,
          id,
        ),
      ).rejects.toThrow(/record_version_change_is_stamped/);
      // A otra ficha, nunca.
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE ${table} SET patient_id = $2::uuid,
                  changed_by = $3::uuid, changed_at = $4
            WHERE id = $1::uuid`,
          id,
          stranger.id,
          doctor.id,
          minutesFromNow(1),
        ),
      ).rejects.toThrow(/cannot be modified/);
      // Quién lo registró, nunca.
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE ${table} SET recorded_by = $2::uuid,
                  changed_by = $2::uuid, changed_at = $3
            WHERE id = $1::uuid`,
          id,
          doctor.id,
          minutesFromNow(1),
        ),
      ).rejects.toThrow(/cannot be modified/);
      await expect(
        prisma.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE id = $1::uuid`,
          id,
        ),
      ).rejects.toThrow(/never deleted/);
      await expect(
        prisma.$executeRawUnsafe(`TRUNCATE ${table} CASCADE`),
      ).rejects.toThrow(/never deleted/);
    }

    expect(await prisma.patientAllergy.count()).toBe(1);
    expect(await prisma.patientHistory.count()).toBe(1);
    expect(await prisma.recordVersion.count()).toBe(2);
  });

  it('EN-225 dos ediciones simultáneas de la misma alergia se aplican las dos, y ninguna versión se pierde', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const first = await createUser(prisma);
    const second = await createUser(prisma);
    const { allergy } = await anAllergy(prisma, patient.id);
    // El mismo instante para las dos: el sello del segundo pasa al primero.
    const at = minutesFromNow(0);

    const results = await Promise.allSettled([
      allergiesOf(prisma).edit({
        patientId: patient.id,
        allergyId: allergy.id,
        changes: { criticality: 'HIGH' },
        editedById: first.id,
        now: at,
      }),
      allergiesOf(prisma).edit({
        patientId: patient.id,
        allergyId: allergy.id,
        changes: { reaction: 'Anafilaxia' },
        editedById: second.id,
        now: at,
      }),
    ]);

    // Las dos ganan, una detrás de otra: ninguna pisa a la otra.
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const stored = await prisma.patientAllergy.findUniqueOrThrow({
      where: { id: allergy.id },
    });
    expect(stored).toMatchObject({ criticality: 'HIGH', reaction: 'Anafilaxia' }); // prettier-ignore
    const versions = await allergiesOf(prisma).versionsOf(patient.id, allergy.id); // prettier-ignore
    expect(versions?.map((v) => v.version)).toEqual([2, 1]);
    expect(new Set(versions?.map((v) => v.replacedBy.id))).toEqual(
      new Set([first.id, second.id]),
    );
  });
});

describe('EN-226 «sin alergias conocidas» en un paso, y retirarlo', () => {
  it('EN-226 descarta las alergias indicadas y afirma «sin alergias conocidas» en una sola transacción', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const practitioner = await createPractitioner(prisma);
    const { allergy } = await anAllergy(prisma, patient.id);
    const { allergy: other } = await anAllergy(prisma, patient.id);

    const { assertion, refutedAllergyIds } = await allergiesOf(
      prisma,
    ).refuteAndAssertNoKnownAllergies({
      patientId: patient.id,
      allergyIds: [allergy.id, other.id],
      notes: BULK_REFUTATION_NOTE,
      actorId: practitioner.userId,
      now: minutesFromNow(0),
    });

    expect(assertion.assertedById).toBe(practitioner.userId);
    expect(new Set(refutedAllergyIds)).toEqual(new Set([allergy.id, other.id]));
    expect(await activeOf(prisma).activeFor(patient.id)).toHaveLength(0);
    const refuted = await prisma.patientAllergy.findMany();
    // D-140.3. Quien lo lea sabe de dónde salió el descarte.
    expect(refuted.map((a) => a.refutedNotes)).toEqual([
      'Descartada al afirmar sin alergias conocidas',
      'Descartada al afirmar sin alergias conocidas',
    ]);
    expect(refuted.map((a) => a.refutedById)).toEqual([
      practitioner.userId,
      practitioner.userId,
    ]);
    expect((await allergiesOf(prisma).standingAbsenceFor(patient.id))?.id).toBe(
      assertion.id,
    );
  });

  it('EN-226 si queda una activa sin indicar, la base no afirma y no descarta ninguna', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const practitioner = await createPractitioner(prisma);
    const { allergy } = await anAllergy(prisma, patient.id);
    await anAllergy(prisma, patient.id);

    await expect(
      allergiesOf(prisma).refuteAndAssertNoKnownAllergies({
        patientId: patient.id,
        allergyIds: [allergy.id],
        notes: BULK_REFUTATION_NOTE,
        actorId: practitioner.userId,
        now: minutesFromNow(0),
      }),
    ).rejects.toThrow(ChartHasAllergiesError);

    // Ni la indicada quedó descartada: todo o nada.
    expect(await activeOf(prisma).activeFor(patient.id)).toHaveLength(2);
    expect(await prisma.patientAllergyAbsence.count()).toBe(0);
  });

  it('EN-226 no descarta una alergia de otra ficha al afirmar', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const stranger = await createPatient(prisma);
    const practitioner = await createPractitioner(prisma);
    const { allergy } = await anAllergy(prisma, stranger.id);

    await expect(
      allergiesOf(prisma).refuteAndAssertNoKnownAllergies({
        patientId: patient.id,
        allergyIds: [allergy.id],
        notes: BULK_REFUTATION_NOTE,
        actorId: practitioner.userId,
        now: minutesFromNow(0),
      }),
    ).rejects.toBeInstanceOf(PatientAllergyNotFoundError);
    expect(await activeOf(prisma).activeFor(stranger.id)).toHaveLength(1);
  });

  it('EN-226 retirar la afirmación la deja de servir sin borrarla, y guarda su versión', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const practitioner = await createPractitioner(prisma);
    const doctor = await createUser(prisma);
    const repository = allergiesOf(prisma);
    const assertion = await repository.assertNoKnownAllergies({
      patientId: patient.id,
      assertedById: practitioner.userId,
    });

    const retracted = await repository.retractNoKnownAllergies({
      assertionId: assertion.id,
      patientId: patient.id,
      retractedById: doctor.id,
      now: minutesFromNow(0),
    });

    expect(retracted).toBe(true);
    expect(await repository.standingAbsenceFor(patient.id)).toBeNull();
    expect(await prisma.patientAllergyAbsence.count()).toBe(1);
    const stored = await prisma.patientAllergyAbsence.findUniqueOrThrow({
      where: { id: assertion.id },
    });
    expect(stored).toMatchObject({
      assertedById: practitioner.userId,
      retractedById: doctor.id,
    });
    const versions = await prisma.recordVersion.findMany({
      where: { resourceType: 'patient_allergy_absence', resourceId: assertion.id }, // prettier-ignore
    });
    expect(versions).toHaveLength(1);
    // La segunda vez no hay nada que retirar.
    await expect(
      repository.retractNoKnownAllergies({
        assertionId: assertion.id,
        patientId: patient.id,
        retractedById: doctor.id,
        now: minutesFromNow(1),
      }),
    ).resolves.toBe(false);
  });

  it('EN-226 la base admite retirar la afirmación con quién y cuándo, y rechaza reescribirla o borrarla', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const practitioner = await createPractitioner(prisma);
    const doctor = await createUser(prisma);
    const assertion = await prisma.patientAllergyAbsence.create({
      data: { patientId: patient.id, assertedById: practitioner.userId },
    });

    // Reescribir quién lo afirmó, nunca.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE patient_allergy_absence
            SET asserted_by = $2::uuid, retracted_by = $2::uuid, retracted_at = $3
          WHERE id = $1::uuid`,
        assertion.id,
        doctor.id,
        minutesFromNow(0),
      ),
    ).rejects.toThrow(/cannot be modified/);
    // Retirar a medias, tampoco.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE patient_allergy_absence SET retracted_by = $2::uuid WHERE id = $1::uuid`,
        assertion.id,
        doctor.id,
      ),
    ).rejects.toThrow();
    // Control positivo: quién y cuándo entra.
    await prisma.$executeRawUnsafe(
      `UPDATE patient_allergy_absence
          SET retracted_by = $2::uuid, retracted_at = $3
        WHERE id = $1::uuid`,
      assertion.id,
      doctor.id,
      minutesFromNow(0),
    );
    // Y una vez retirada, no se retira otra vez ni se borra.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE patient_allergy_absence
            SET retracted_by = $2::uuid, retracted_at = $3
          WHERE id = $1::uuid`,
        assertion.id,
        doctor.id,
        minutesFromNow(1),
      ),
    ).rejects.toThrow(/cannot be modified/);
    await expect(
      prisma.patientAllergyAbsence.delete({ where: { id: assertion.id } }),
    ).rejects.toThrow();
    expect(await prisma.patientAllergyAbsence.count()).toBe(1);
  });
});

/**
 * D-140 (revisión de la rama): lo que la revisión clínica pidió a la base y al
 * adaptador. Cada prueba lleva su control positivo por el mismo camino.
 */
describe('D-140 lo que una alergia de criticidad alta exige, y la sustancia que no se pierde', () => {
  it('EN-224 una alergia de criticidad alta no se descarta sin motivo; con motivo sí, y la que no es alta sin motivo también (D-140.1)', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const doctor = await createUser(prisma);
    const high = await allergiesOf(prisma).record({
      patientId: patient.id,
      substanceText: 'Penicilina',
      reaction: 'Anafilaxia',
      criticality: 'HIGH',
      recordedById: doctor.id,
    });
    const { allergy: unassessed } = await anAllergy(prisma, patient.id);

    await expect(
      allergiesOf(prisma).refute({
        patientId: patient.id,
        allergyId: high.id,
        notes: null,
        now: minutesFromNow(0),
        refutedById: doctor.id,
      }),
    ).rejects.toBeInstanceOf(RefutationReasonRequiredError);
    expect(await activeOf(prisma).activeFor(patient.id)).toHaveLength(2);

    // Control positivo: la misma alergia, con motivo, se descarta.
    const reasoned = await allergiesOf(prisma).refute({
      patientId: patient.id,
      allergyId: high.id,
      notes: 'Prueba negativa',
      now: minutesFromNow(0),
      refutedById: doctor.id,
    });
    expect(reasoned?.refutedNotes).toBe('Prueba negativa');
    // Y la que no es alta sigue sin exigirlo (EN-224).
    const silent = await allergiesOf(prisma).refute({
      patientId: patient.id,
      allergyId: unassessed.id,
      notes: null,
      now: minutesFromNow(0),
      refutedById: doctor.id,
    });
    expect(silent?.refutedAt).not.toBeNull();
  });

  it('EN-225 EN-084 editar el texto sin enviar el principio activo lo conserva; sólo un null explícito lo vacía', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const doctor = await createUser(prisma);
    const amoxicillin = await aCnmbConcept(prisma, 'J01CA04', 'Amoxicilina');
    const allergy = await allergiesOf(prisma).record({
      patientId: patient.id,
      substanceConceptId: amoxicillin.id,
      substanceText: 'Amoxicilna',
      criticality: 'LOW',
      recordedById: doctor.id,
    });

    const retyped = await allergiesOf(prisma).edit({
      patientId: patient.id,
      allergyId: allergy.id,
      changes: { substanceText: 'Amoxicilina' },
      editedById: doctor.id,
      now: minutesFromNow(0),
    });
    expect(retyped).toMatchObject({
      substanceText: 'Amoxicilina',
      substanceConceptId: amoxicillin.id,
    });
    const [active] = await activeOf(prisma).activeFor(patient.id);
    expect(active?.substanceConceptId).toBe(amoxicillin.id);

    // Control: un null explícito sí lo vacía.
    const cleared = await allergiesOf(prisma).edit({
      patientId: patient.id,
      allergyId: allergy.id,
      changes: { substanceConceptId: null },
      editedById: doctor.id,
      now: minutesFromNow(1),
    });
    expect(cleared).toMatchObject({
      substanceText: 'Amoxicilina',
      substanceConceptId: null,
    });
  });

  it('EN-225 la alergia corregida dice quién la corrigió y cuándo', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const doctor = await createUser(prisma);
    const { allergy } = await anAllergy(prisma, patient.id);
    expect(allergy.changedBy).toBeNull();
    const at = minutesFromNow(0);

    await allergiesOf(prisma).edit({
      patientId: patient.id,
      allergyId: allergy.id,
      changes: { reaction: 'Rash' },
      editedById: doctor.id,
      now: at,
    });

    const [listed] = await allergiesOf(prisma).listFor(patient.id);
    expect(listed?.changedBy).toEqual({
      id: doctor.id,
      name: 'Carmen Salazar',
    });
    expect(listed?.changedAt?.getTime()).toBe(at.getTime());
  });

  it('EN-226 una alergia de criticidad alta en la lista se rechaza bajo candado y no se descarta ninguna (D-140.3)', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const practitioner = await createPractitioner(prisma);
    const { allergy } = await anAllergy(prisma, patient.id);
    const high = await allergiesOf(prisma).record({
      patientId: patient.id,
      substanceText: 'Penicilina',
      criticality: 'HIGH',
      recordedById: practitioner.userId,
    });

    await expect(
      allergiesOf(prisma).refuteAndAssertNoKnownAllergies({
        patientId: patient.id,
        allergyIds: [allergy.id, high.id],
        notes: BULK_REFUTATION_NOTE,
        actorId: practitioner.userId,
        now: minutesFromNow(0),
      }),
    ).rejects.toBeInstanceOf(AllergyRefutedAloneError);
    expect(await activeOf(prisma).activeFor(patient.id)).toHaveLength(2);
    expect(await prisma.patientAllergyAbsence.count()).toBe(0);

    // Control positivo: descartada antes la alta, una a una, el paso entra.
    await allergiesOf(prisma).refute({
      patientId: patient.id,
      allergyId: high.id,
      notes: 'Prueba negativa',
      now: minutesFromNow(0),
      refutedById: practitioner.userId,
    });
    const { refutedAllergyIds } = await allergiesOf(
      prisma,
    ).refuteAndAssertNoKnownAllergies({
      patientId: patient.id,
      allergyIds: [allergy.id, high.id],
      notes: BULK_REFUTATION_NOTE,
      actorId: practitioner.userId,
      now: minutesFromNow(1),
    });
    // La ya descartada se salta: ni se reescribe ni se cuenta.
    expect(refutedAllergyIds).toEqual([allergy.id]);
    const stored = await prisma.patientAllergy.findUniqueOrThrow({
      where: { id: high.id },
    });
    expect(stored.refutedNotes).toBe('Prueba negativa');
  });

  it('EN-226 dos «descartar estas y afirmar» a la vez con las alergias en orden inverso no se interbloquean: los dos terminan y cada alergia se descarta una vez', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const first = await createPractitioner(prisma);
    const second = await createPractitioner(prisma);
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push((await anAllergy(prisma, patient.id)).allergy.id);
    }
    const at = minutesFromNow(0);

    const results = await Promise.allSettled([
      allergiesOf(prisma).refuteAndAssertNoKnownAllergies({
        patientId: patient.id,
        allergyIds: ids,
        notes: BULK_REFUTATION_NOTE,
        actorId: first.userId,
        now: at,
      }),
      allergiesOf(prisma).refuteAndAssertNoKnownAllergies({
        patientId: patient.id,
        allergyIds: [...ids].reverse(),
        notes: BULK_REFUTATION_NOTE,
        actorId: second.userId,
        now: at,
      }),
    ]);

    // Ninguno muere por interbloqueo: los dos afirman.
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const refuted = results.flatMap((r) =>
      r.status === 'fulfilled' ? r.value.refutedAllergyIds : [],
    );
    // Cada alergia la descartó exactamente uno de los dos: el que llegó antes
    // se las lleva todas, y el segundo no descarta nada.
    expect([...refuted].sort()).toEqual([...ids].sort());
    const counts = results.map((r) =>
      r.status === 'fulfilled' ? r.value.refutedAllergyIds.length : -1,
    );
    expect([...counts].sort()).toEqual([0, 6]);
    expect(await prisma.recordVersion.count()).toBe(6);
  });
});

describe('las garantías de la base de la alergia, cada una por su nombre', () => {
  async function stampedUpdate(
    prisma: PrismaClient,
    set: string,
    id: string,
    by: string,
    minutes: number,
  ) {
    return prisma.$executeRawUnsafe(
      `UPDATE patient_allergy SET ${set}, changed_by = $2::uuid, changed_at = $3
        WHERE id = $1::uuid`,
      id,
      by,
      minutesFromNow(minutes),
    );
  }

  it('EN-224 EN-225 patient_allergy_guard rechaza editar una descartada, descartar y editar en el mismo UPDATE y reescribir el descarte', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const doctor = await createUser(prisma);
    const { allergy } = await anAllergy(prisma, patient.id);
    const { allergy: other } = await anAllergy(prisma, patient.id);

    // Descartar y editar en la misma sentencia: no.
    await expect(
      stampedUpdate(
        prisma,
        `refuted_at = now(), refuted_by = '${doctor.id}', reaction = 'Otra'`,
        allergy.id,
        doctor.id,
        0,
      ),
    ).rejects.toThrow(/patient_allergy cannot be modified this way/);
    // Control positivo: descartar sola, sí.
    await stampedUpdate(
      prisma,
      `refuted_at = now(), refuted_by = '${doctor.id}', refuted_notes = 'Prueba negativa'`,
      allergy.id,
      doctor.id,
      0,
    );
    // Editar lo que dice una descartada: no.
    await expect(
      stampedUpdate(prisma, `reaction = 'Otra'`, allergy.id, doctor.id, 1),
    ).rejects.toThrow(/patient_allergy cannot be modified this way/);
    // Reescribir el descarte (otro motivo, otra fecha): no.
    await expect(
      stampedUpdate(
        prisma,
        `refuted_notes = 'Registrada por error'`,
        allergy.id,
        doctor.id,
        1,
      ),
    ).rejects.toThrow(/patient_allergy cannot be modified this way/);
    await expect(
      stampedUpdate(
        prisma,
        `refuted_at = refuted_at + interval '1 minute'`,
        allergy.id,
        doctor.id,
        1,
      ),
    ).rejects.toThrow(/patient_allergy cannot be modified this way/);
    // Control positivo: editar una vigente, sí.
    await stampedUpdate(prisma, `reaction = 'Otra'`, other.id, doctor.id, 0);

    const stored = await prisma.patientAllergy.findUniqueOrThrow({
      where: { id: allergy.id },
    });
    expect(stored).toMatchObject({
      reaction: 'Urticaria',
      refutedNotes: 'Prueba negativa',
    });
  });

  it('EN-224 patient_allergy_refutation_is_coherent rechaza un motivo sin descarte y un motivo en blanco', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const doctor = await createUser(prisma);
    const { allergy } = await anAllergy(prisma, patient.id);

    // Un motivo en una alergia que no está descartada: lo para el CHECK, en el
    // INSERT, por donde el disparador no se interpone.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO patient_allergy
           (patient_id, substance_text, criticality, recorded_by, refuted_notes)
         VALUES ($1::uuid, 'Látex', 'LOW', $2::uuid, 'Prueba negativa')`,
        patient.id,
        doctor.id,
      ),
    ).rejects.toThrow(/patient_allergy_refutation_is_coherent/);
    // Un descarte con el motivo en blanco: el disparador lo admite como
    // descarte y lo para el CHECK.
    await expect(
      stampedUpdate(
        prisma,
        `refuted_at = now(), refuted_by = '${doctor.id}', refuted_notes = '   '`,
        allergy.id,
        doctor.id,
        0,
      ),
    ).rejects.toThrow(/patient_allergy_refutation_is_coherent/);

    // Control positivo: por los mismos dos caminos, con un motivo de verdad.
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_allergy
         (patient_id, substance_text, criticality, recorded_by,
          refuted_at, refuted_by, refuted_notes)
       VALUES ($1::uuid, 'Látex', 'LOW', $2::uuid, now(), $2::uuid, 'Prueba negativa')`,
      patient.id,
      doctor.id,
    );
    await stampedUpdate(
      prisma,
      `refuted_at = now(), refuted_by = '${doctor.id}', refuted_notes = 'Prueba negativa'`,
      allergy.id,
      doctor.id,
      0,
    );
    expect(
      await prisma.patientAllergy.count({
        where: { refutedAt: { not: null } },
      }),
    ).toBe(2);
  });

  it('EN-226 patient_allergy_absence_retraction_is_whole rechaza quién retiró sin cuándo, y cuándo sin quién', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const practitioner = await createPractitioner(prisma);
    const doctor = await createUser(prisma);

    // Por el INSERT: el disparador de la tabla sólo mira UPDATE y DELETE, y
    // el de versiones sólo UPDATE, así que lo que para esto es el CHECK.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO patient_allergy_absence
           (patient_id, asserted_by, retracted_by, retracted_at)
         VALUES ($1::uuid, $3::uuid, $2::uuid, NULL)`,
        patient.id,
        doctor.id,
        practitioner.userId,
      ),
    ).rejects.toThrow(/patient_allergy_absence_retraction_is_whole/);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO patient_allergy_absence
           (patient_id, asserted_by, retracted_by, retracted_at)
         VALUES ($1::uuid, $2::uuid, NULL, now())`,
        patient.id,
        practitioner.userId,
      ),
    ).rejects.toThrow(/patient_allergy_absence_retraction_is_whole/);

    // Control positivo: los dos juntos entran.
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_allergy_absence
         (patient_id, asserted_by, retracted_by, retracted_at)
       VALUES ($1::uuid, $3::uuid, $2::uuid, now())`,
      patient.id,
      doctor.id,
      practitioner.userId,
    );
    expect(await prisma.patientAllergyAbsence.count()).toBe(1);
  });
});
