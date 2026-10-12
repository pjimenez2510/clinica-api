import type { PrismaClient } from '@prisma/client';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';

import { importCnmb } from '../../prisma/seed-clinical-catalogues.mts';
import { PrescriptionService } from '../../src/modules/prescription/application/prescription.service';
import { DOSAGE_FORMS } from '../../src/modules/prescription/domain/prescription-vocabulary';
import { PrismaPrescriptionRepository } from '../../src/modules/prescription/infrastructure/prisma-prescription.repository';
import '../../src/modules/prescription/infrastructure/prescription.constraints';
import type { AccessAuditRecorder } from '../../src/shared/audit/access-audit.port';
import { PrismaActiveAllergyReader } from '../../src/shared/infrastructure/clinical/prisma-active-allergy.reader';
import { PrismaAllergyAbsenceReader } from '../../src/shared/infrastructure/clinical/standing-allergy-absence';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import { revisionNow } from './setup/read-revision';
import { createPatient, createSite, createUser } from './setup/fixtures';

/**
 * PR-114 to PR-116. The official CNMB loaded over the development cuadro,
 * prescribed against through the real service and adapter: what survives an
 * edition change (the allergy), what the cuadro now declares (presentations,
 * controlled) and that nothing registered is deleted.
 */
const db = useDatabase();

/** The attention, two days ago: every catalogue date below derives from it. */
const ENCOUNTER_STARTED_AT = new Date(Date.now() - 2 * 86_400_000);

/** The day before the attention: the official cuadro rules on its date. */
const CUTOVER = new Date(
  Date.UTC(
    ENCOUNTER_STARTED_AT.getUTCFullYear(),
    ENCOUNTER_STARTED_AT.getUTCMonth(),
    ENCOUNTER_STARTED_AT.getUTCDate() - 1,
  ),
);

const INDICATIONS = {
  warningSigns: 'Fiebre mayor de 39 °C o dificultad para respirar',
  nonPharmacologicalAdvice: 'Abundantes líquidos y reposo relativo',
};

const serviceOf = (prisma: PrismaClient) => {
  const audit: AccessAuditRecorder = { record: () => Promise.resolve() };
  const logger = { setContext: vi.fn(), info: vi.fn() } as unknown as PinoLogger; // prettier-ignore
  return new PrescriptionService(
    new PrismaPrescriptionRepository(prisma as unknown as PrismaService),
    new PrismaActiveAllergyReader(prisma as unknown as PrismaService),
    audit,
    logger,
    { archiveAnnulled: () => Promise.resolve(null) },
    // PR-117. The statement the attention's band reads.
    new PrismaAllergyAbsenceReader(prisma as unknown as PrismaService),
  );
};

/** The development cuadro as a base that used it holds it. */
async function developmentCuadro(prisma: PrismaClient) {
  const system = await prisma.catalogSystem.create({
    data: { code: 'CNMB', name: 'CNMB' },
  });
  const concept = (code: string, display: string) =>
    prisma.catalogConcept.create({
      data: {
        systemId: system.id,
        code,
        display,
        validFrom: new Date(Date.UTC(CUTOVER.getUTCFullYear(), 0, 1)),
      },
    });
  return {
    enalapril: await concept('ENALAPRIL', 'Enalapril'),
    losartan: await concept('LOSARTAN', 'Losartán'),
  };
}

/** An attention ready to be prescribed on: site with city, ACESS, diagnosis. */
async function anAttention(prisma: PrismaClient) {
  const dpa = await prisma.catalogSystem.create({
    data: { code: 'DPA', name: 'DPA', hierarchical: true },
  });
  const since = new Date(Date.UTC(CUTOVER.getUTCFullYear() - 10, 0, 1));
  const canton = await prisma.catalogConcept.create({
    data: {
      systemId: dpa.id,
      code: '1701',
      display: 'Quito',
      validFrom: since,
    },
  });
  const parish = await prisma.catalogConcept.create({
    data: {
      systemId: dpa.id,
      code: '170150',
      display: 'Iñaquito',
      parentId: canton.id,
      validFrom: since,
    },
  });
  const site = await prisma.site.update({
    where: { id: (await createSite(prisma)).id },
    data: { parishConceptId: parish.id },
  });
  const user = await prisma.user.create({
    data: {
      email: `medico-${Date.now()}@clinica.ec`,
      passwordHash: 'not-a-real-hash',
      firstName: 'Ana',
      lastName: 'Villacís',
      acessRegistration: 'ACESS-11223',
      acessExpiresOn: new Date(Date.UTC(CUTOVER.getUTCFullYear() + 4, 0, 1)),
    },
  });
  const practitioner = await prisma.practitioner.create({
    data: { userId: user.id, emergencyContactPhone: '0991234567' },
  });
  const patient = await createPatient(prisma);
  const encounter = await prisma.encounter.create({
    data: {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
      startedAt: ENCOUNTER_STARTED_AT,
      careModality: 'MORBIDITY',
      visitSequence: 'FIRST_TIME',
    },
  });
  const cie10 = await prisma.catalogSystem.create({
    data: { code: 'CIE10', name: 'CIE-10' },
  });
  const pharyngitis = await prisma.catalogConcept.create({
    data: {
      systemId: cie10.id,
      code: 'J02.9',
      display: 'Faringitis aguda, no especificada',
      validFrom: since,
    },
  });
  await prisma.encounterDiagnosis.create({
    data: {
      encounterId: encounter.id,
      conceptId: pharyngitis.id,
      cie10Code: 'J02.9',
      cie10Display: pharyngitis.display,
      certainty: 'DEFINITIVE',
      occurrence: 'FIRST_TIME',
      rank: 1,
    },
  });
  return {
    patient,
    encounter,
    who: { userId: practitioner.userId, sites: [site.id] },
  };
}

const aLine = (
  conceptId: string,
  dosageForm: keyof typeof DOSAGE_FORMS,
  concentration: string,
) => ({
  conceptId,
  genericName: null,
  dosageForm,
  concentration,
  routeCode: 'ORAL',
  quantity: 20,
  doseAmount: 1,
  doseUnit: 'TABLET' as const,
  frequency: 'EVERY_8_HOURS' as const,
  frequencyText: null,
  durationDays: 7,
  instructions: null,
  offFormularyJustification: null,
});

const official = (prisma: PrismaClient, code: string) =>
  prisma.catalogConcept.findFirstOrThrow({
    where: { code, system: { code: 'CNMB' }, validTo: null },
  });

describe('the official CNMB (PR-114 to PR-116)', () => {
  it('PR-116: replaces the development cuadro by retiring it, never deleting it', async () => {
    const prisma = db();
    const development = await developmentCuadro(prisma);

    const result = await importCnmb(prisma, {
      now: new Date(),
      effectiveFrom: CUTOVER,
      allowPastCutover: true,
    });

    expect(result).toMatchObject({ status: 'imported', inserted: 528 });
    const retired = await prisma.catalogConcept.findUniqueOrThrow({
      where: { id: development.enalapril.id },
    });
    expect(retired.validTo).toEqual(CUTOVER);
    expect(await official(prisma, 'C09AA02')).toMatchObject({
      display: 'Enalapril',
      attributes: expect.objectContaining({ replaces: ['ENALAPRIL'] }),
    });
    expect(
      await importCnmb(prisma, {
        now: new Date(),
        effectiveFrom: CUTOVER,
        allowPastCutover: true,
      }),
    ).toMatchObject({ status: 'unchanged' });
  });

  it('PR-114: says which recorded allergies the new cuadro has no successor for, and not the others', async () => {
    const prisma = db();
    const development = await developmentCuadro(prisma);
    const cetirizine = await prisma.catalogConcept.create({
      data: {
        systemId: development.enalapril.systemId,
        code: 'CETIRIZINA',
        display: 'Cetirizina',
        validFrom: development.enalapril.validFrom,
      },
    });
    const patient = await createPatient(prisma);
    for (const concept of [cetirizine, development.enalapril])
      await prisma.patientAllergy.create({
        data: {
          recordedById: (await createUser(prisma)).id,
          patientId: patient.id,
          substanceConceptId: concept.id,
          substanceText: concept.display,
          criticality: 'HIGH',
        },
      });

    const result = await importCnmb(prisma, {
      now: new Date(),
      effectiveFrom: CUTOVER,
      allowPastCutover: true,
    });

    expect(result.orphans).toEqual([
      { code: 'CETIRIZINA', display: 'Cetirizina', allergies: 1 },
    ]);
  });

  it('PR-115: every form a presentation admits is a form of the prescription vocabulary', async () => {
    const prisma = db();
    await importCnmb(prisma, { now: new Date() });

    const concepts = await prisma.catalogConcept.findMany({
      where: { system: { code: 'CNMB' } },
      select: { attributes: true },
    });
    const forms = concepts.flatMap((concept) =>
      (
        concept.attributes as { presentations: { forms: string[] }[] }
      ).presentations.flatMap((presentation) => presentation.forms),
    );
    expect(forms.length).toBeGreaterThan(800);
    for (const form of new Set(forms))
      expect(DOSAGE_FORMS).toHaveProperty(form);
  });

  it('PR-115: an amoxicillin capsule of 500 mg is in the cuadro; one of 750 mg is marked outside', async () => {
    const prisma = db();
    await importCnmb(prisma, {
      now: new Date(),
      effectiveFrom: CUTOVER,
      allowPastCutover: true,
    });
    const { encounter, who } = await anAttention(prisma);
    const amoxicillin = await official(prisma, 'J01CA04');
    const service = serviceOf(prisma);

    const composed = await service.compose(
      {
        encounterId: encounter.id,
        ...INDICATIONS,
        items: [
          aLine(amoxicillin.id, 'CAPSULE', '500 mg'),
          aLine(amoxicillin.id, 'CAPSULE', '750 mg'),
        ],
      },
      who,
    );

    expect(composed.prescription.items.map((item) => item.offFormulary)).toEqual([false, true]); // prettier-ignore
    expect(
      (await service.presentationsOf(amoxicillin.id))[0],
    ).toMatchObject({ label: 'Sólido oral', forms: expect.arrayContaining(['CAPSULE']) }); // prettier-ignore
  });

  it('PR-115: metformin of 850 mg is inside the range the cuadro declares; 1500 mg and the range itself are outside', async () => {
    const prisma = db();
    await importCnmb(prisma, {
      now: new Date(),
      effectiveFrom: CUTOVER,
      allowPastCutover: true,
    });
    const { encounter, who } = await anAttention(prisma);
    const metformin = await official(prisma, 'A10BA02');

    const composed = await serviceOf(prisma).compose(
      {
        encounterId: encounter.id,
        ...INDICATIONS,
        items: [
          aLine(metformin.id, 'TABLET', '850 mg'),
          aLine(metformin.id, 'TABLET', '1500 mg'),
          aLine(metformin.id, 'TABLET', '500 mg - 1000 mg'),
        ],
      },
      who,
    );

    expect(composed.prescription.items.map((item) => item.offFormulary)).toEqual([false, true, true]); // prettier-ignore
  });

  it('PR-115: the line freezes the DCI of the presentation it is: haloperidol decanoate is not haloperidol', async () => {
    const prisma = db();
    await importCnmb(prisma, {
      now: new Date(),
      effectiveFrom: CUTOVER,
      allowPastCutover: true,
    });
    const { encounter, who } = await anAttention(prisma);
    const haloperidol = await official(prisma, 'N05AD01');
    const presentations = await serviceOf(prisma).presentationsOf(
      haloperidol.id,
    );
    const depot = presentations.find((p) => p.dci === 'Haloperidol decanoato')!;
    const plain = presentations.find((p) => p.dci === 'Haloperidol' && p.form === 'INJECTABLE_SOLUTION')!; // prettier-ignore

    const composed = await serviceOf(prisma).compose(
      {
        encounterId: encounter.id,
        ...INDICATIONS,
        items: [
          aLine(haloperidol.id, 'INJECTABLE_SOLUTION', depot.concentration),
          aLine(haloperidol.id, 'INJECTABLE_SOLUTION', plain.concentration),
        ],
      },
      who,
    );

    expect(composed.prescription.items.map((item) => item.genericName)).toEqual(
      ['Haloperidol decanoato', 'Haloperidol'],
    );
  });

  it('PR-114: an allergy recorded against the development enalapril refuses the official one, and not another medicine', async () => {
    const prisma = db();
    const development = await developmentCuadro(prisma);
    const { patient, encounter, who } = await anAttention(prisma);
    await prisma.patientAllergy.create({
      data: {
        recordedById: (await createUser(prisma)).id,
        patientId: patient.id,
        substanceConceptId: development.enalapril.id,
        substanceText: 'Enalapril',
        criticality: 'HIGH',
      },
    });
    await importCnmb(prisma, {
      now: new Date(),
      effectiveFrom: CUTOVER,
      allowPastCutover: true,
    });
    const service = serviceOf(prisma);

    const composed = await service.compose(
      {
        encounterId: encounter.id,
        ...INDICATIONS,
        items: [
          aLine((await official(prisma, 'C09AA02')).id, 'TABLET', '20 mg'),
        ],
      },
      who,
    );
    expect(composed.allergyAlerts).toEqual([
      { line: 1, allergyId: expect.any(String), match: 'EXACT' },
    ]);
    await expect(
      service.issue(
        composed.prescription.id,
        await revisionNow(prisma, 'prescription', composed.prescription.id),
        who,
      ),
    ).rejects.toMatchObject({ code: 'ALLERGY_CONTRAINDICATION' });

    // Positive control: losartán, which the development cuadro also had,
    // composes and issues by the same path.
    const other = await service.compose(
      {
        encounterId: encounter.id,
        ...INDICATIONS,
        items: [
          aLine((await official(prisma, 'C09CA01')).id, 'TABLET', '50 mg'),
        ],
      },
      who,
    );
    expect(other.allergyAlerts).toEqual([]);
    await expect(
      service.issue(
        other.prescription.id,
        await revisionNow(prisma, 'prescription', other.prescription.id),
        who,
      ),
    ).resolves.toMatchObject({ status: 'ACTIVE' });
    expect(development.losartan.id).not.toBe((await official(prisma, 'C09CA01')).id); // prettier-ignore
  });

  it('PR-114: the same substance under another code of the cuadro refuses the issue: metronidazole and acetylsalicylic acid', async () => {
    const prisma = db();
    const system = await prisma.catalogSystem.create({
      data: { code: 'CNMB', name: 'CNMB' },
    });
    const aspirinDev = await prisma.catalogConcept.create({
      data: {
        systemId: system.id,
        code: 'ACIDO-ACETILSALICILICO',
        display: 'Ácido acetilsalicílico',
        validFrom: new Date(Date.UTC(CUTOVER.getUTCFullYear(), 0, 1)),
      },
    });
    await importCnmb(prisma, {
      now: new Date(),
      effectiveFrom: CUTOVER,
      allowPastCutover: true,
    });
    const { patient, encounter, who } = await anAttention(prisma);
    const allergyTo = async (conceptId: string, text: string) =>
      prisma.patientAllergy.create({
        data: {
          recordedById: (await createUser(prisma)).id,
          patientId: patient.id,
          substanceConceptId: conceptId,
          substanceText: text,
          criticality: 'HIGH',
        },
      });
    // Recorded against the parenteral metronidazole, and against the
    // acetylsalicylic acid of the development cuadro (successor B01AC06).
    await allergyTo((await official(prisma, 'J01XD01')).id, 'Metronidazol');
    await allergyTo(aspirinDev.id, 'Ácido acetilsalicílico');
    const service = serviceOf(prisma);

    for (const [code, concentration] of [
      ['P01AB01', '500 mg'],
      ['N02BA01', '500 mg'],
    ] as const) {
      const composed = await service.compose(
        {
          encounterId: encounter.id,
          ...INDICATIONS,
          items: [aLine((await official(prisma, code)).id, 'TABLET', concentration)], // prettier-ignore
        },
        who,
      );
      expect(composed.allergyAlerts, code).toHaveLength(1);
      await expect(
        service.issue(
          composed.prescription.id,
          await revisionNow(prisma, 'prescription', composed.prescription.id),
          who,
        ),
      ).rejects.toMatchObject({ code: 'ALLERGY_CONTRAINDICATION' });
    }

    // Positive control: paracetamol, by the same path, issues.
    const other = await service.compose(
      {
        encounterId: encounter.id,
        ...INDICATIONS,
        items: [aLine((await official(prisma, 'N02BE01')).id, 'TABLET', '500 mg')], // prettier-ignore
      },
      who,
    );
    await expect(
      service.issue(
        other.prescription.id,
        await revisionNow(prisma, 'prescription', other.prescription.id),
        who,
      ),
    ).resolves.toMatchObject({ status: 'ACTIVE' });
  });

  it('PR-114: a development allergy named otherwise (diclofenaco sódico) fires with every official code of its successor substance', async () => {
    const prisma = db();
    const system = await prisma.catalogSystem.create({
      data: { code: 'CNMB', name: 'CNMB' },
    });
    const diclofenacDev = await prisma.catalogConcept.create({
      data: {
        systemId: system.id,
        code: 'DICLOFENACO',
        display: 'Diclofenaco sódico',
        validFrom: new Date(Date.UTC(CUTOVER.getUTCFullYear(), 0, 1)),
      },
    });
    await importCnmb(prisma, {
      now: new Date(),
      effectiveFrom: CUTOVER,
      allowPastCutover: true,
    });
    const { patient, encounter, who } = await anAttention(prisma);
    await prisma.patientAllergy.create({
      data: {
        recordedById: (await createUser(prisma)).id,
        patientId: patient.id,
        substanceConceptId: diclofenacDev.id,
        substanceText: 'Diclofenaco',
        criticality: 'HIGH',
      },
    });

    // The eye drops: not the successor named in `replaces` (M01AB05), but
    // the same substance.
    const composed = await serviceOf(prisma).compose(
      {
        encounterId: encounter.id,
        ...INDICATIONS,
        items: [aLine((await official(prisma, 'S01BC03')).id, 'EYE_DROPS', '0,1 %')], // prettier-ignore
      },
      who,
    );
    expect(composed.allergyAlerts).toHaveLength(1);
  });

  it('PR-116: the official morphine is not composed: it goes on the ACESS pad', async () => {
    const prisma = db();
    await importCnmb(prisma, {
      now: new Date(),
      effectiveFrom: CUTOVER,
      allowPastCutover: true,
    });
    const { encounter, who } = await anAttention(prisma);
    const service = serviceOf(prisma);

    await expect(
      service.compose(
        {
          encounterId: encounter.id,
          ...INDICATIONS,
          items: [
            aLine((await official(prisma, 'N02AA01')).id, 'TABLET', '10 mg'),
          ],
        },
        who,
      ),
    ).rejects.toMatchObject({ code: 'CONTROLLED_SUBSTANCE_NOT_PRESCRIBABLE' });

    // Positive control: paracetamol, by the same path, composes.
    await expect(
      service.compose(
        {
          encounterId: encounter.id,
          ...INDICATIONS,
          items: [
            aLine((await official(prisma, 'N02BE01')).id, 'TABLET', '500 mg'),
          ],
        },
        who,
      ),
    ).resolves.toMatchObject({ prescription: { status: 'DRAFT' } });
  });
});
