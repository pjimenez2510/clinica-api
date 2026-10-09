import type { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { aTariffConcept } from './orders-fixtures';
import { useDatabase } from './setup/database';
import {
  createEncounter,
  createExamService,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * EN-152 to EN-154 and BI-256 against a real PostgreSQL. What is proved is
 * the DATABASE: an import, a script or a `psql` cannot register a procedure
 * that needs its form 024 without it, nor edit or erase a consent. Every
 * refusal has its positive control beside it.
 */
const db = useDatabase();

const MINUTE = 60_000;

async function anAttention(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  const user = await createUser(prisma);
  return { encounter, user };
}

/** A tariff concept, and — when `marked` — a service that demands the 024. */
async function aConcept(
  prisma: PrismaClient,
  user: { id: string },
  marked: boolean,
) {
  const concept = await aTariffConcept(prisma);
  const service = await createExamService(prisma, {
    code: `P-${concept.code}`,
    name: `Prestación ${concept.code}`,
    kind: 'PROCEDURE',
  });
  await prisma.billableService.update({
    where: { id: service.id },
    data: {
      procedureConceptId: concept.id,
      ...(marked
        ? {
            requiresWrittenConsent: true,
            writtenConsentSetAt: new Date(),
            writtenConsentSetById: user.id,
          }
        : {}),
    },
  });
  return concept;
}

function procedureData(
  encounter: { id: string; startedAt: Date },
  concept: { id: string; code: string; display: string },
): Prisma.EncounterProcedureUncheckedCreateInput {
  return {
    encounterId: encounter.id,
    conceptId: concept.id,
    procedureCode: concept.code,
    procedureDisplay: concept.display,
    quantity: 1,
    performedAt: new Date(encounter.startedAt.getTime() + 30 * MINUTE),
  };
}

function signedConsent(
  procedure: {
    id: string;
    encounterId: string;
    conceptId: string;
    performedAt: Date;
  },
  userId: string,
  signedAt = new Date(procedure.performedAt.getTime() - 10 * MINUTE),
): Prisma.ProcedureConsentUncheckedCreateInput {
  return {
    encounterId: procedure.encounterId,
    conceptId: procedure.conceptId,
    procedureId: procedure.id,
    kind: 'SIGNED',
    signer: 'PATIENT',
    informedById: userId,
    signedAt,
    recordedAt: new Date(),
    recordedById: userId,
  };
}

describe('el consentimiento 024 lo garantiza la base (EN-152 a EN-154, BI-256)', () => {
  it('EN-151 sin la marca, el procedimiento se registra sin consentimiento (control positivo)', async () => {
    const prisma = db();
    const { encounter, user } = await anAttention(prisma);
    const concept = await aConcept(prisma, user, false);

    await prisma.$transaction(async (tx) => {
      await tx.encounterProcedure.create({
        data: procedureData(encounter, concept),
      });
    });
    expect(await prisma.encounterProcedure.count({ where: { encounterId: encounter.id } })).toBe(1); // prettier-ignore
  });

  it('EN-152 con la marca, la BASE rechaza el procedimiento sin 024 al cerrar la transacción; con el firmado o la excepción, entra', async () => {
    const prisma = db();
    const { encounter, user } = await anAttention(prisma);
    const concept = await aConcept(prisma, user, true);

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.encounterProcedure.create({
          data: procedureData(encounter, concept),
        });
      }),
    ).rejects.toThrow(/encounter_procedure_consent_required/);
    expect(await prisma.encounterProcedure.count({ where: { encounterId: encounter.id } })).toBe(0); // prettier-ignore

    await prisma.$transaction(async (tx) => {
      const procedure = await tx.encounterProcedure.create({ data: procedureData(encounter, concept) }); // prettier-ignore
      await tx.procedureConsent.create({
        data: signedConsent(procedure, user.id),
      });
    });
    await prisma.$transaction(async (tx) => {
      const procedure = await tx.encounterProcedure.create({ data: procedureData(encounter, concept) }); // prettier-ignore
      await tx.procedureConsent.create({
        data: {
          encounterId: encounter.id,
          conceptId: concept.id,
          procedureId: procedure.id,
          kind: 'EXCEPTION',
          exceptionKind: 'EMERGENCY',
          exceptionReason:
            'Paciente inconsciente, sin familiares a quien informar',
          recordedAt: new Date(),
          recordedById: user.id,
        },
      });
    });
    expect(await prisma.encounterProcedure.count({ where: { encounterId: encounter.id } })).toBe(2); // prettier-ignore
  });

  it('EN-152 la BASE rechaza la excepción sin fundamento y la firma posterior a la realización', async () => {
    const prisma = db();
    const { encounter, user } = await anAttention(prisma);
    const concept = await aConcept(prisma, user, true);

    await expect(
      prisma.$transaction(async (tx) => {
        const procedure = await tx.encounterProcedure.create({ data: procedureData(encounter, concept) }); // prettier-ignore
        await tx.procedureConsent.create({
          data: {
            encounterId: encounter.id,
            conceptId: concept.id,
            procedureId: procedure.id,
            kind: 'EXCEPTION',
            exceptionKind: 'EMERGENCY',
            exceptionReason: '   ',
            recordedAt: new Date(),
            recordedById: user.id,
          },
        });
      }),
    ).rejects.toThrow(/procedure_consent_exception_states_why/);

    await expect(
      prisma.$transaction(async (tx) => {
        const procedure = await tx.encounterProcedure.create({ data: procedureData(encounter, concept) }); // prettier-ignore
        await tx.procedureConsent.create({
          data: signedConsent(
            procedure,
            user.id,
            new Date(procedure.performedAt.getTime() + MINUTE),
          ),
        });
      }),
    ).rejects.toThrow(/procedure_consent_signed_before_performed/);
  });

  it('EN-152 la BASE exige el nombre y el parentesco del representante que firma', async () => {
    const prisma = db();
    const { encounter, user } = await anAttention(prisma);
    const concept = await aConcept(prisma, user, true);

    await expect(
      prisma.$transaction(async (tx) => {
        const procedure = await tx.encounterProcedure.create({ data: procedureData(encounter, concept) }); // prettier-ignore
        await tx.procedureConsent.create({
          data: {
            ...signedConsent(procedure, user.id),
            signer: 'REPRESENTATIVE',
          },
        });
      }),
    ).rejects.toThrow(/procedure_consent_representative_states_who/);

    await prisma.$transaction(async (tx) => {
      const procedure = await tx.encounterProcedure.create({ data: procedureData(encounter, concept) }); // prettier-ignore
      await tx.procedureConsent.create({
        data: {
          ...signedConsent(procedure, user.id),
          signer: 'REPRESENTATIVE',
          representativeName: 'Rosa Cedeño',
          representativeRelationship: 'MOTHER',
        },
      });
    });
  });

  it('EN-152 el procedimiento restaurado conserva el 024 del original; cambiarlo a un concepto que lo exige, sin él, se rechaza', async () => {
    const prisma = db();
    const { encounter, user } = await anAttention(prisma);
    const marked = await aConcept(prisma, user, true);
    const plain = await aConcept(prisma, user, false);

    const original = await prisma.$transaction(async (tx) => {
      const procedure = await tx.encounterProcedure.create({ data: procedureData(encounter, marked) }); // prettier-ignore
      await tx.procedureConsent.create({
        data: signedConsent(procedure, user.id),
      });
      return procedure;
    });

    // Removed as EN-245 does, then restored as a new row (EN-246).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO encounter_procedure_retraction
          (id, encounter_id, concept_id, procedure_code, procedure_display,
           quantity, performed_at, note, tariff_amount, edited_by_id, edited_at,
           retracted_at, retracted_by_id, reason)
        SELECT id, encounter_id, concept_id, procedure_code, procedure_display,
               quantity, performed_at, note, tariff_amount, edited_by_id, edited_at,
               ${new Date()}, ${user.id}::uuid, 'Registrado por error'
          FROM encounter_procedure WHERE id = ${original.id}::uuid`;
      await tx.encounterProcedure.delete({ where: { id: original.id } });
    });
    await prisma.$transaction(async (tx) => {
      const restored = await tx.encounterProcedure.create({
        data: {
          ...procedureData(encounter, marked),
          performedAt: original.performedAt,
        },
      });
      await tx.encounterProcedureRetraction.update({
        where: { id: original.id },
        data: {
          restoredAt: new Date(),
          restoredById: user.id,
          restoredAsId: restored.id,
        },
      });
    });
    expect(await prisma.encounterProcedure.count({ where: { encounterId: encounter.id } })).toBe(1); // prettier-ignore

    // A plain procedure corrected into the marked concept, without a 024.
    const other = await prisma.encounterProcedure.create({ data: procedureData(encounter, plain) }); // prettier-ignore
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.encounterProcedure.update({
          where: { id: other.id },
          data: {
            conceptId: marked.id,
            procedureCode: marked.code,
            editedById: user.id,
            editedAt: new Date(),
          },
        });
      }),
    ).rejects.toThrow(/encounter_procedure_consent_required/);
    // Positive control: editing what is not the concept is not judged.
    await prisma.encounterProcedure.update({
      where: { id: other.id },
      data: { quantity: 2, editedById: user.id, editedAt: new Date() },
    });
  });

  it('EN-154 la BASE no deja editar ni borrar un consentimiento', async () => {
    const prisma = db();
    const { encounter, user } = await anAttention(prisma);
    const concept = await aConcept(prisma, user, true);
    const consent = await prisma.$transaction(async (tx) => {
      const procedure = await tx.encounterProcedure.create({ data: procedureData(encounter, concept) }); // prettier-ignore
      return tx.procedureConsent.create({
        data: signedConsent(procedure, user.id),
      });
    });

    await expect(
      prisma.$executeRaw`UPDATE procedure_consent SET signer = 'REPRESENTATIVE' WHERE id = ${consent.id}::uuid`,
    ).rejects.toThrow(/procedure_consent_frozen/);
    await expect(
      prisma.$executeRaw`DELETE FROM procedure_consent WHERE id = ${consent.id}::uuid`,
    ).rejects.toThrow(/procedure_consent_frozen/);
    expect(
      await prisma.procedureConsent.count({ where: { id: consent.id } }),
    ).toBe(1);
  });

  it('EN-153 la negativa sin firma exige el testigo con su documento; con él, entra sin procedimiento', async () => {
    const prisma = db();
    const { encounter, user } = await anAttention(prisma);
    const concept = await aConcept(prisma, user, true);
    const refusal: Prisma.ProcedureConsentUncheckedCreateInput = {
      encounterId: encounter.id,
      conceptId: concept.id,
      kind: 'REFUSED',
      signer: 'NONE',
      informedById: user.id,
      signedAt: new Date(),
      recordedAt: new Date(),
      recordedById: user.id,
    };

    await expect(
      prisma.procedureConsent.create({ data: refusal }),
    ).rejects.toThrow(/procedure_consent_refusal_states_who/);
    await prisma.procedureConsent.create({
      data: {
        ...refusal,
        witnessName: 'Luis Andrade',
        witnessDocument: '1710034065',
      },
    });
    expect(await prisma.encounterProcedure.count({ where: { encounterId: encounter.id } })).toBe(0); // prettier-ignore
    expect((await prisma.encounter.findUniqueOrThrow({ where: { id: encounter.id } })).status).toBe(encounter.status); // prettier-ignore
  });

  it('EN-154 sólo se revoca un consentimiento firmado, una vez, y la revocación tampoco cambia', async () => {
    const prisma = db();
    const { encounter, user } = await anAttention(prisma);
    const concept = await aConcept(prisma, user, true);
    const { signed, exception } = await prisma.$transaction(async (tx) => {
      const first = await tx.encounterProcedure.create({ data: procedureData(encounter, concept) }); // prettier-ignore
      const second = await tx.encounterProcedure.create({ data: procedureData(encounter, concept) }); // prettier-ignore
      return {
        signed: await tx.procedureConsent.create({
          data: signedConsent(first, user.id),
        }),
        exception: await tx.procedureConsent.create({
          data: {
            encounterId: encounter.id,
            conceptId: concept.id,
            procedureId: second.id,
            kind: 'EXCEPTION',
            exceptionKind: 'UNEXPECTED_DURING_PROCEDURE',
            exceptionReason: 'Hallazgo durante la intervención',
            recordedAt: new Date(),
            recordedById: user.id,
          },
        }),
      };
    });
    const revocation = (consentId: string) =>
      prisma.procedureConsentRevocation.create({
        data: {
          consentId,
          signer: 'PATIENT',
          revokedAt: new Date(),
          revokedById: user.id,
        },
      });

    await expect(revocation(exception.id)).rejects.toThrow(
      /procedure_consent_revocation_of_signed/,
    );
    await revocation(signed.id);
    await expect(revocation(signed.id)).rejects.toThrow();
    await expect(
      prisma.$executeRaw`DELETE FROM procedure_consent_revocation WHERE consent_id = ${signed.id}::uuid`,
    ).rejects.toThrow(/procedure_consent_frozen/);
    // The revoked consent is exactly as it was.
    expect(await prisma.procedureConsent.findUniqueOrThrow({ where: { id: signed.id } })).toEqual(signed); // prettier-ignore
  });

  it('BI-256 la BASE no admite la marca sin quién y cuándo, ni en una prestación que no ata un procedimiento', async () => {
    const prisma = db();
    const user = await createUser(prisma);
    const service = await createExamService(prisma, { code: 'P-SIN', name: 'Sin atadura', kind: 'PROCEDURE' }); // prettier-ignore

    await expect(
      prisma.billableService.update({
        where: { id: service.id },
        data: { requiresWrittenConsent: true, writtenConsentSetAt: new Date(), writtenConsentSetById: user.id }, // prettier-ignore
      }),
    ).rejects.toThrow(/billable_service_written_consent_needs_a_procedure/);

    const concept = await aTariffConcept(prisma);
    await expect(
      prisma.billableService.update({
        where: { id: service.id },
        data: { procedureConceptId: concept.id, requiresWrittenConsent: true },
      }),
    ).rejects.toThrow(/billable_service_written_consent_states_who/);

    await prisma.billableService.update({
      where: { id: service.id },
      data: {
        procedureConceptId: concept.id,
        requiresWrittenConsent: true,
        writtenConsentSetAt: new Date(),
        writtenConsentSetById: user.id,
      },
    });
    const [answer] = await prisma.$queryRaw<{ required: boolean }[]>`
      SELECT procedure_requires_written_consent(${concept.id}::uuid) AS required`;
    expect(answer?.required).toBe(true);
  });
});
