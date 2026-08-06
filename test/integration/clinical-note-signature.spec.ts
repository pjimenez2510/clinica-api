import { describe, expect, it } from 'vitest';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
} from './setup/fixtures';

/**
 * A note either is signed, or it is not. There is no half-signed.
 *
 * `clinical_note_signature_coherence` is what stops a record that LOOKS signed
 * from existing without a signer or without the hash that makes the signature
 * verifiable. In front of an expert witness, a note marked SIGNED with no
 * `content_hash` proves nothing at all — and the constraint had no test.
 */
describe('a note is signed, or it is not', () => {
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

  /** Everything a note needs, minus whatever the test is about to break. */
  function noteData(encounterId: string, authorId: string) {
    return {
      chainId: encounterId,
      formCode: '002',
      encounterId,
      authorId,
      content: { motivo: 'cefalea' },
    };
  }

  it('accepts a complete signature', async () => {
    const { prisma, practitioner, encounter } = await noteContext();

    const note = await prisma.clinicalNote.create({
      data: {
        ...noteData(encounter.id, practitioner.id),
        status: 'SIGNED',
        signedById: practitioner.id,
        signedAt: new Date('2026-09-14T14:30:00Z'),
        contentHash: 'a'.repeat(64),
      },
    });

    expect(note.status).toBe('SIGNED');
  });

  it('REFUSES a note marked SIGNED with no signature at all', async () => {
    const { prisma, practitioner, encounter } = await noteContext();

    await expect(
      prisma.clinicalNote.create({
        data: { ...noteData(encounter.id, practitioner.id), status: 'SIGNED' },
      }),
    ).rejects.toThrow(/clinical_note_signature_coherence/);
  });

  it('REFUSES a signature with no signer', async () => {
    // "Signed at 14:30" — by whom? Nothing to hold anyone to.
    const { prisma, practitioner, encounter } = await noteContext();

    await expect(
      prisma.clinicalNote.create({
        data: {
          ...noteData(encounter.id, practitioner.id),
          status: 'SIGNED',
          signedAt: new Date('2026-09-14T14:30:00Z'),
          contentHash: 'a'.repeat(64),
        },
      }),
    ).rejects.toThrow(/clinical_note_signature_coherence/);
  });

  it('REFUSES a signature with no content hash', async () => {
    // The hash is what makes the signature verifiable. Without it the record
    // says "signed" and proves nothing.
    const { prisma, practitioner, encounter } = await noteContext();

    await expect(
      prisma.clinicalNote.create({
        data: {
          ...noteData(encounter.id, practitioner.id),
          status: 'SIGNED',
          signedById: practitioner.id,
          signedAt: new Date('2026-09-14T14:30:00Z'),
        },
      }),
    ).rejects.toThrow(/clinical_note_signature_coherence/);
  });

  it('REFUSES a DRAFT that carries a signature', async () => {
    // The other direction: a draft with a signature date would let someone
    // keep editing text that already looks signed.
    const { prisma, practitioner, encounter } = await noteContext();

    await expect(
      prisma.clinicalNote.create({
        data: {
          ...noteData(encounter.id, practitioner.id),
          status: 'DRAFT',
          signedById: practitioner.id,
          signedAt: new Date('2026-09-14T14:30:00Z'),
          contentHash: 'a'.repeat(64),
        },
      }),
    ).rejects.toThrow(/clinical_note_signature_coherence/);
  });

  it('REFUSES an amendment with no reason', async () => {
    // Superseding a signed note without saying why makes the chain
    // unauditable: the record shows the text changed and not what justified it.
    const { prisma, practitioner, encounter } = await noteContext();
    const original = await prisma.clinicalNote.create({
      data: {
        ...noteData(encounter.id, practitioner.id),
        status: 'SIGNED',
        signedById: practitioner.id,
        signedAt: new Date('2026-09-14T14:30:00Z'),
        contentHash: 'a'.repeat(64),
      },
    });
    await prisma.clinicalNote.update({
      where: { id: original.id },
      data: { status: 'SUPERSEDED' },
    });

    await expect(
      prisma.clinicalNote.create({
        data: {
          ...noteData(encounter.id, practitioner.id),
          version: 2,
          supersedesId: original.id,
          content: { motivo: 'cefalea tensional' },
        },
      }),
    ).rejects.toThrow(/clinical_note_amendment_reason/);
  });

  it('accepts an amendment that states its reason', async () => {
    const { prisma, practitioner, encounter } = await noteContext();
    const original = await prisma.clinicalNote.create({
      data: {
        ...noteData(encounter.id, practitioner.id),
        status: 'SIGNED',
        signedById: practitioner.id,
        signedAt: new Date('2026-09-14T14:30:00Z'),
        contentHash: 'a'.repeat(64),
      },
    });
    await prisma.clinicalNote.update({
      where: { id: original.id },
      data: { status: 'SUPERSEDED' },
    });

    const amendment = await prisma.clinicalNote.create({
      data: {
        ...noteData(encounter.id, practitioner.id),
        version: 2,
        supersedesId: original.id,
        amendmentReason: 'Se precisó el diagnóstico tras el resultado de laboratorio', // prettier-ignore
        content: { motivo: 'cefalea tensional' },
      },
    });

    expect(amendment.version).toBe(2);
    // The original stays readable. That is the whole point of amending rather
    // than editing.
    const kept = await prisma.clinicalNote.findUnique({
      where: { id: original.id },
    });
    expect(kept?.content).toEqual({ motivo: 'cefalea' });
  });

  it('REFUSES rewriting the content while marking a note superseded', async () => {
    // THE ATTACK THIS DEFENDS AGAINST: tampering disguised as an amendment.
    // The existing test only performed the clean transition, so removing the
    // `content IS NOT DISTINCT FROM` clause from the trigger would not have
    // failed anything — the request would still have been rejected, but by the
    // catch-all branch, for the wrong reason.
    const { prisma, practitioner, encounter } = await noteContext();
    const note = await prisma.clinicalNote.create({
      data: {
        ...noteData(encounter.id, practitioner.id),
        status: 'SIGNED',
        signedById: practitioner.id,
        signedAt: new Date('2026-09-14T14:30:00Z'),
        contentHash: 'a'.repeat(64),
      },
    });

    await expect(
      prisma.clinicalNote.update({
        where: { id: note.id },
        data: {
          status: 'SUPERSEDED',
          content: { motivo: 'algo que el médico nunca escribió' },
        },
      }),
    ).rejects.toThrow(/cannot be modified/);
  });

  it('REFUSES backdating the signature', async () => {
    const { prisma, practitioner, encounter } = await noteContext();
    const note = await prisma.clinicalNote.create({
      data: {
        ...noteData(encounter.id, practitioner.id),
        status: 'SIGNED',
        signedById: practitioner.id,
        signedAt: new Date('2026-09-14T14:30:00Z'),
        contentHash: 'a'.repeat(64),
      },
    });

    await expect(
      prisma.clinicalNote.update({
        where: { id: note.id },
        data: {
          status: 'SUPERSEDED',
          signedAt: new Date('2026-09-01T08:00:00Z'),
        },
      }),
    ).rejects.toThrow(/cannot be modified/);
  });

  it('REFUSES deleting a DRAFT, not only a signed note', async () => {
    // The DELETE branch fires before the status is examined, so a draft is
    // just as undeletable. The existing test only covered the signed case and
    // its name claimed more than it checked.
    const { prisma, practitioner, encounter } = await noteContext();
    const draft = await prisma.clinicalNote.create({
      data: noteData(encounter.id, practitioner.id),
    });

    await expect(
      prisma.clinicalNote.delete({ where: { id: draft.id } }),
    ).rejects.toThrow(/never deleted/);
  });

  it('REFUSES emptying the note table', async () => {
    const { prisma, practitioner, encounter } = await noteContext();
    await prisma.clinicalNote.create({
      data: noteData(encounter.id, practitioner.id),
    });

    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE clinical_note'),
    ).rejects.toThrow();
  });
});
