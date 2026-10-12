import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createIssuedPrescription,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
} from './setup/fixtures';

/**
 * EN-283, PR-122, ORD-182 against PostgreSQL: `draft_revision_counts_writes`
 * raises the revision of a draft on every UPDATE, whoever writes and whatever
 * they send, and leaves alone the revision of what is no longer a draft.
 * Raw `UPDATE`s on purpose: the guarantee is for `psql` and the assistant
 * too, not only for the API.
 */
const db = useDatabase();

async function anEncounter(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const encounter = await createEncounter(prisma, {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
  });
  return { encounter, practitionerId: practitioner.id };
}

async function aDraftNote(prisma: PrismaClient) {
  const { encounter, practitionerId } = await anEncounter(prisma);
  const id = randomUUID();
  return prisma.clinicalNote.create({
    data: {
      id,
      chainId: id,
      encounterId: encounter.id,
      formCode: '005',
      formVersion: '1',
      content: { evolucion: 'Primera' },
      authorId: practitionerId,
    },
  });
}

const revisionOf = async (
  prisma: PrismaClient,
  table: 'clinical_note' | 'prescription' | 'service_order',
  id: string,
) =>
  (
    await prisma.$queryRawUnsafe<{ revision: number }[]>(
      `SELECT revision FROM "${table}" WHERE id = $1::uuid`,
      id,
    )
  )[0]!.revision;

describe('draft revision (record revision)', () => {
  it('EN-283 a draft note starts at 1 and every raw UPDATE raises it by one, whatever revision it sends', async () => {
    const prisma = db();
    const note = await aDraftNote(prisma);
    expect(note.revision).toBe(1);

    await prisma.$executeRaw`UPDATE clinical_note SET content = '{"evolucion":"Segunda"}' WHERE id = ${note.id}::uuid`;
    expect(await revisionOf(prisma, 'clinical_note', note.id)).toBe(2);

    // The writer cannot set it back, nor jump ahead.
    await prisma.$executeRaw`UPDATE clinical_note SET revision = 1 WHERE id = ${note.id}::uuid`;
    expect(await revisionOf(prisma, 'clinical_note', note.id)).toBe(3);
    await prisma.$executeRaw`UPDATE clinical_note SET revision = 99 WHERE id = ${note.id}::uuid`;
    expect(await revisionOf(prisma, 'clinical_note', note.id)).toBe(4);
  });

  it('EN-283 signing raises it once more, and the signed note keeps it from then on', async () => {
    const prisma = db();
    const note = await aDraftNote(prisma);

    await prisma.clinicalNote.update({
      where: { id: note.id },
      data: {
        status: 'SIGNED',
        signedById: note.authorId,
        signedAt: new Date(),
        contentHash: 'a'.repeat(64),
      },
    });
    expect(await revisionOf(prisma, 'clinical_note', note.id)).toBe(2);

    // A signed note only moves to SUPERSEDED or ENTERED_IN_ERROR; the
    // revision stays where the signature left it.
    await prisma.$executeRaw`UPDATE clinical_note SET status = 'ENTERED_IN_ERROR', revision = 7 WHERE id = ${note.id}::uuid`;
    expect(await revisionOf(prisma, 'clinical_note', note.id)).toBe(2);
  });

  it('PR-122 a draft receta raises its revision on every UPDATE and a discarded one keeps it', async () => {
    const prisma = db();
    const { encounter, practitionerId } = await anEncounter(prisma);
    const draft = await prisma.prescription.create({
      data: {
        encounterId: encounter.id,
        prescriberId: practitionerId,
        siteId: encounter.siteId,
      },
    });
    expect(draft.revision).toBe(1);

    await prisma.$executeRaw`UPDATE prescription SET warning_signs = 'Fiebre', revision = 1 WHERE id = ${draft.id}::uuid`;
    expect(await revisionOf(prisma, 'prescription', draft.id)).toBe(2);

    // Discarding is still a write on a draft; restoring brings it back as one.
    await prisma.prescription.update({
      where: { id: draft.id },
      data: {
        status: 'DISCARDED',
        discardedAt: new Date(),
        discardedById: (await prisma.practitioner.findUniqueOrThrow({ where: { id: practitionerId } })).userId, // prettier-ignore
      },
    });
    expect(await revisionOf(prisma, 'prescription', draft.id)).toBe(3);
    // A discarded receta is no draft: a write that does not bring it back
    // leaves the revision alone.
    await prisma.$executeRaw`UPDATE prescription SET revision = 40 WHERE id = ${draft.id}::uuid`;
    expect(await revisionOf(prisma, 'prescription', draft.id)).toBe(3);
  });

  it('ORD-182 a draft order raises its revision on every UPDATE, a discarded one keeps it and restoring counts', async () => {
    const prisma = db();
    const { encounter, practitionerId } = await anEncounter(prisma);
    const draft = await prisma.serviceOrder.create({
      data: {
        encounterId: encounter.id,
        siteId: encounter.siteId,
        orderedById: practitionerId,
        category: 'LABORATORY',
      },
    });
    expect(draft.revision).toBe(1);

    await prisma.$executeRaw`UPDATE service_order SET clinical_note_text = 'Ayuno', revision = 5 WHERE id = ${draft.id}::uuid`;
    expect(await revisionOf(prisma, 'service_order', draft.id)).toBe(2);

    const userId = (
      await prisma.practitioner.findUniqueOrThrow({
        where: { id: practitionerId },
      })
    ).userId;
    await prisma.serviceOrder.update({
      where: { id: draft.id },
      data: { status: 'DISCARDED', discardedAt: new Date(), discardedById: userId }, // prettier-ignore
    });
    expect(await revisionOf(prisma, 'service_order', draft.id)).toBe(3);
    await prisma.$executeRaw`UPDATE service_order SET revision = 40 WHERE id = ${draft.id}::uuid`;
    expect(await revisionOf(prisma, 'service_order', draft.id)).toBe(3);

    // Restoring makes it a draft again: that write counts.
    await prisma.serviceOrder.update({
      where: { id: draft.id },
      data: { status: 'DRAFT', discardedAt: null, discardedById: null },
    });
    expect(await revisionOf(prisma, 'service_order', draft.id)).toBe(4);
  });

  it('PR-122 an issued receta keeps its revision when it is annulled: the freezing trigger sees the row unchanged', async () => {
    const prisma = db();
    const { encounter, practitionerId } = await anEncounter(prisma);
    const issued = await createIssuedPrescription(prisma, {
      encounterId: encounter.id,
      prescriberId: practitionerId,
      siteId: encounter.siteId,
    });
    const revision = await revisionOf(prisma, 'prescription', issued.id);

    await prisma.prescription.update({
      where: { id: issued.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledById: (await createUser(prisma)).id,
        cancelReason: 'Pérdida',
      },
    });
    expect(await revisionOf(prisma, 'prescription', issued.id)).toBe(revision);
  });

  it('EN-283 a signed note keeps its revision when an amendment supersedes it', async () => {
    const prisma = db();
    const note = await aDraftNote(prisma);
    await prisma.clinicalNote.update({
      where: { id: note.id },
      data: {
        status: 'SIGNED',
        signedById: note.authorId,
        signedAt: new Date(),
        contentHash: 'a'.repeat(64),
      },
    });
    const revision = await revisionOf(prisma, 'clinical_note', note.id);

    await prisma.clinicalNote.update({
      where: { id: note.id },
      data: { status: 'SUPERSEDED' },
    });
    expect(await revisionOf(prisma, 'clinical_note', note.id)).toBe(revision);
  });
});
