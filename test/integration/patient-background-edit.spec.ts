import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  AllergyAlreadyRefutedError,
  AllergyNotRefutedError,
  ChartHasAllergiesError,
  HistoryNotRefutedError,
  PatientAllergyNotFoundError,
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
 * EN-219, EN-220 and EN-221 (D-126, D-127) against a real PostgreSQL.
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

describe('EN-219 descartar sin motivo y reactivar lo descartado por error', () => {
  it('EN-219 descarta una alergia sin motivo, y guarda el de la lista cuando se da', async () => {
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

  it('EN-219 la base admite el antecedente descartado sin motivo, y sigue exigiendo quién y cuándo juntos', async () => {
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

  it('EN-219 reactivar la alergia descartada por error la devuelve a activa, y la refutación queda en la versión', async () => {
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

  it('EN-219 reactivar una alergia o un antecedente que siguen activos se rechaza', async () => {
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

  it('EN-219 EN-087 la alergia reactivada deja de servir el «sin alergias conocidas» afirmado mientras estaba descartada', async () => {
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

describe('EN-220 editar en su fila, con la versión anterior guardada', () => {
  it('EN-220 edita la sustancia, la reacción y la criticidad de una alergia y guarda la versión anterior con quién y cuándo', async () => {
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

  it('EN-220 EN-084 la comprobación al recetar lee la versión vigente de la alergia', async () => {
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

  it('EN-220 edita la descripción, el tipo y el parentesco de un antecedente con su versión', async () => {
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

  it('EN-220 no edita una alergia descartada: primero se reactiva', async () => {
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

  it('EN-220 la base rechaza la edición sin sello, cambiar el paciente o el autor original, y borrar', async () => {
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

  it('EN-220 dos ediciones simultáneas de la misma alergia se aplican las dos, y ninguna versión se pierde', async () => {
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

describe('EN-221 «sin alergias conocidas» en un paso, y retirarlo', () => {
  it('EN-221 descarta las alergias indicadas y afirma «sin alergias conocidas» en una sola transacción', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const practitioner = await createPractitioner(prisma);
    const { allergy } = await anAllergy(prisma, patient.id);
    const { allergy: other } = await anAllergy(prisma, patient.id);

    const assertion = await allergiesOf(prisma).refuteAndAssertNoKnownAllergies(
      {
        patientId: patient.id,
        allergyIds: [allergy.id, other.id],
        actorId: practitioner.userId,
        now: minutesFromNow(0),
      },
    );

    expect(assertion.assertedById).toBe(practitioner.userId);
    expect(await activeOf(prisma).activeFor(patient.id)).toHaveLength(0);
    const refuted = await prisma.patientAllergy.findMany();
    expect(refuted.map((a) => a.refutedNotes)).toEqual([null, null]);
    expect(refuted.map((a) => a.refutedById)).toEqual([
      practitioner.userId,
      practitioner.userId,
    ]);
    expect((await allergiesOf(prisma).standingAbsenceFor(patient.id))?.id).toBe(
      assertion.id,
    );
  });

  it('EN-221 si queda una activa sin indicar, la base no afirma y no descarta ninguna', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const practitioner = await createPractitioner(prisma);
    const { allergy } = await anAllergy(prisma, patient.id);
    await anAllergy(prisma, patient.id);

    await expect(
      allergiesOf(prisma).refuteAndAssertNoKnownAllergies({
        patientId: patient.id,
        allergyIds: [allergy.id],
        actorId: practitioner.userId,
        now: minutesFromNow(0),
      }),
    ).rejects.toThrow(ChartHasAllergiesError);

    // Ni la indicada quedó descartada: todo o nada.
    expect(await activeOf(prisma).activeFor(patient.id)).toHaveLength(2);
    expect(await prisma.patientAllergyAbsence.count()).toBe(0);
  });

  it('EN-221 no descarta una alergia de otra ficha al afirmar', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const stranger = await createPatient(prisma);
    const practitioner = await createPractitioner(prisma);
    const { allergy } = await anAllergy(prisma, stranger.id);

    await expect(
      allergiesOf(prisma).refuteAndAssertNoKnownAllergies({
        patientId: patient.id,
        allergyIds: [allergy.id],
        actorId: practitioner.userId,
        now: minutesFromNow(0),
      }),
    ).rejects.toBeInstanceOf(PatientAllergyNotFoundError);
    expect(await activeOf(prisma).activeFor(stranger.id)).toHaveLength(1);
  });

  it('EN-221 retirar la afirmación la deja de servir sin borrarla, y guarda su versión', async () => {
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

  it('EN-221 la base admite retirar la afirmación con quién y cuándo, y rechaza reescribirla o borrarla', async () => {
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
