import { describe, expect, it } from 'vitest';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * EN-156. How a note was signed travels WITH the note, and the database writes
 * it at the signature: the only way to sign today is the credential (D-177.1),
 * so a signature that states no other method is that one.
 */
describe('EN-156 cómo se firmó la nota', () => {
  const db = useDatabase();

  async function noteContext() {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);
    const encounter = await createEncounter(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    });
    return { prisma, practitioner, encounter };
  }

  function noteData(encounterId: string, authorId: string) {
    return {
      chainId: encounterId,
      formCode: '002',
      encounterId,
      authorId,
      content: { motivo: 'cefalea' },
    };
  }

  it('EN-156 un borrador no dice cómo se firmó, y firmarlo escribe la credencial', async () => {
    const { prisma, practitioner, encounter } = await noteContext();
    const draft = await prisma.clinicalNote.create({
      data: noteData(encounter.id, practitioner.id),
    });
    expect(draft.signatureMethod).toBeNull();

    const signed = await prisma.clinicalNote.update({
      where: { id: draft.id },
      data: {
        status: 'SIGNED',
        signedById: practitioner.id,
        signedAt: new Date(),
        contentHash: 'a'.repeat(64),
      },
    });

    expect(signed.signatureMethod).toBe('CREDENTIAL');
  });

  it('EN-156 una nota que nace firmada (la enmienda) también la lleva', async () => {
    const { prisma, practitioner, encounter } = await noteContext();

    const note = await prisma.clinicalNote.create({
      data: {
        ...noteData(encounter.id, practitioner.id),
        status: 'SIGNED',
        signedById: practitioner.id,
        signedAt: new Date(),
        contentHash: 'a'.repeat(64),
      },
    });

    expect(note.signatureMethod).toBe('CREDENTIAL');
  });

  it('EN-156 control positivo: un método declarado no se pisa', async () => {
    // The day the custody exists, the certificate path writes CERTIFICATE;
    // the default must not overwrite it.
    const { prisma, practitioner, encounter } = await noteContext();

    const note = await prisma.clinicalNote.create({
      data: {
        ...noteData(encounter.id, practitioner.id),
        status: 'SIGNED',
        signedById: practitioner.id,
        signedAt: new Date(),
        contentHash: 'a'.repeat(64),
        signatureMethod: 'CERTIFICATE',
      },
    });

    expect(note.signatureMethod).toBe('CERTIFICATE');
  });

  it('EN-156 un borrador con método lo rechaza la base', async () => {
    const { prisma, practitioner, encounter } = await noteContext();

    await expect(
      prisma.clinicalNote.create({
        data: {
          ...noteData(encounter.id, practitioner.id),
          signatureMethod: 'CREDENTIAL',
        },
      }),
    ).rejects.toThrow(/clinical_note_method_only_when_signed/);
  });

  it('EN-156 la constancia de una nota firmada no se cambia, y enmendarla la conserva', async () => {
    const { prisma, practitioner, encounter } = await noteContext();
    const note = await prisma.clinicalNote.create({
      data: {
        ...noteData(encounter.id, practitioner.id),
        status: 'SIGNED',
        signedById: practitioner.id,
        signedAt: new Date(),
        contentHash: 'a'.repeat(64),
      },
    });

    await expect(
      prisma.clinicalNote.update({
        where: { id: note.id },
        data: { signatureMethod: 'CERTIFICATE' },
      }),
    ).rejects.toThrow(/is signed and cannot be modified/);
    await expect(
      prisma.clinicalNote.update({
        where: { id: note.id },
        data: { status: 'SUPERSEDED', signatureMethod: 'CERTIFICATE' },
      }),
    ).rejects.toThrow(/is signed and cannot be modified/);

    // Control positivo: la transición permitida, con la constancia intacta.
    const superseded = await prisma.clinicalNote.update({
      where: { id: note.id },
      data: { status: 'SUPERSEDED' },
    });
    expect(superseded.signatureMethod).toBe('CREDENTIAL');
  });

  it('EN-156 una nota firmada antes de la columna (NULL) todavía se enmienda: no se le inventa nada', async () => {
    const { prisma, practitioner, encounter } = await noteContext();
    const note = await prisma.clinicalNote.create({
      data: {
        ...noteData(encounter.id, practitioner.id),
        status: 'SIGNED',
        signedById: practitioner.id,
        signedAt: new Date(),
        contentHash: 'a'.repeat(64),
      },
    });
    // As the rows signed before this migration are: the default only runs at
    // the act of signing, so wiping it here reproduces them.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        'ALTER TABLE clinical_note DISABLE TRIGGER trg_clinical_note_immutable',
      ),
      prisma.$executeRaw`UPDATE clinical_note SET signature_method = NULL WHERE id = ${note.id}::uuid`,
      prisma.$executeRawUnsafe(
        'ALTER TABLE clinical_note ENABLE TRIGGER trg_clinical_note_immutable',
      ),
    ]);

    const superseded = await prisma.clinicalNote.update({
      where: { id: note.id },
      data: { status: 'SUPERSEDED' },
    });

    expect(superseded.signatureMethod).toBeNull();
  });
});
