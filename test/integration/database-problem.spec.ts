import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { extractDatabaseProblem } from '../../src/shared/http/database-problem';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  hourSlot,
} from './setup/fixtures';

/**
 * The database error mapping, fed by REAL PostgreSQL errors.
 *
 * A unit test with a hand-written fake would only prove that the mapper reads
 * the object I invented. The whole risk here is the opposite one: that Prisma
 * puts the constraint name somewhere else than assumed, and every violation
 * quietly degrades into a 500. Only the real driver can settle that — and when
 * a Prisma upgrade moves the field, this fails instead of the production API.
 */
describe('database errors become usable responses', () => {
  const db = useDatabase();

  /** Runs an operation expected to fail and maps whatever it threw. */
  async function problemFrom(operation: Promise<unknown>) {
    try {
      await operation;
      throw new Error('the operation should have failed');
    } catch (error) {
      return extractDatabaseProblem(error);
    }
  }

  async function agenda() {
    const prisma = db();
    const site = await createSite(prisma);
    const practitioner = await createPractitioner(prisma);
    const patient = await createPatient(prisma);
    return { prisma, site, practitioner, patient };
  }

  it('turns an appointment overlap into 409 with an actionable message', async () => {
    // The case that motivated all of this: the receptionist was told the
    // server had failed, when the slot was simply taken.
    const { prisma, site, practitioner, patient } = await agenda();
    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    const problem = await problemFrom(
      prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: (await createPatient(prisma)).id,
          ...hourSlot(9),
        },
      }),
    );

    expect(problem).toEqual({
      status: HttpStatus.CONFLICT,
      slug: 'conflict',
      title: 'Conflicto con el estado actual',
      code: 'PRACTITIONER_SLOT_TAKEN',
      errors: [
        {
          field: 'startsAt',
          code: 'PRACTITIONER_SLOT_TAKEN',
          message: 'El profesional ya tiene una cita en ese horario',
        },
      ],
    });
  });

  it('distinguishes a busy room from a busy practitioner', async () => {
    const { prisma, site, patient } = await agenda();
    const room = await prisma.siteRoom.create({
      data: { siteId: site.id, name: 'Consultorio 1' },
    });
    const first = await createPractitioner(prisma);
    const second = await createPractitioner(prisma);

    await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        siteId: site.id,
        practitionerId: first.id,
        roomId: room.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });

    const problem = await problemFrom(
      prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: site.id,
          practitionerId: second.id,
          roomId: room.id,
          patientId: (await createPatient(prisma)).id,
          ...hourSlot(9),
        },
      }),
    );

    expect(problem?.code).toBe('ROOM_SLOT_TAKEN');
    expect(problem?.errors?.[0].field).toBe('roomId');
  });

  it('turns a wrong cedula check digit into 422, not 500', async () => {
    const { prisma, patient } = await agenda();

    const problem = await problemFrom(
      prisma.patientIdentifier.create({
        data: { patientId: patient.id, type: 'CEDULA', value: '1710034066' },
      }),
    );

    expect(problem?.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(problem?.code).toBe('INVALID_CEDULA');
    expect(problem?.errors?.[0].message).toMatch(/dígito verificador/);
  });

  it('turns a duplicate document into 409', async () => {
    const { prisma, patient } = await agenda();
    await prisma.patientIdentifier.create({
      data: { patientId: patient.id, type: 'CEDULA', value: '1710034065' },
    });

    const problem = await problemFrom(
      prisma.patientIdentifier.create({
        data: {
          patientId: (await createPatient(prisma)).id,
          type: 'CEDULA',
          value: '1710034065',
        },
      }),
    );

    expect(problem?.status).toBe(HttpStatus.CONFLICT);
    expect(problem?.code).toBe('DUPLICATE_IDENTIFIER');
  });

  it('turns a missing referenced record into 422', async () => {
    const { prisma, practitioner, patient } = await agenda();

    const problem = await problemFrom(
      prisma.agendaEntry.create({
        data: {
          kind: 'APPOINTMENT',
          siteId: '00000000-0000-7000-8000-000000000000',
          practitionerId: practitioner.id,
          patientId: patient.id,
          ...hourSlot(15),
        },
      }),
    );

    expect(problem?.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(problem?.code).toBe('RELATED_RECORD_MISSING');
  });

  it('turns an update on a vanished record into 404', async () => {
    const prisma = db();

    const problem = await problemFrom(
      prisma.patient.update({
        where: { id: '00000000-0000-7000-8000-000000000000' },
        data: { phone: '0999999999' },
      }),
    );

    expect(problem?.status).toBe(HttpStatus.NOT_FOUND);
    expect(problem?.code).toBe('NOT_FOUND');
  });

  it('turns tampering with the audit log into 409, not 403', async () => {
    // It is not a permissions problem — nobody may do it, ever. The record's
    // state forbids the operation, and that is a conflict.
    const prisma = db();
    const entry = await prisma.accessAudit.create({
      data: { resourceType: 'Patient', resourceId: 'x', action: 'READ' },
    });

    const problem = await problemFrom(
      prisma.accessAudit.delete({ where: { id: entry.id } }),
    );

    expect(problem?.status).toBe(HttpStatus.CONFLICT);
    expect(problem?.code).toBe('IMMUTABLE_RECORD');
  });

  it('turns editing a signed note into 409', async () => {
    const { prisma, site, practitioner, patient } = await agenda();
    const encounter = await createEncounter(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    });
    const note = await prisma.clinicalNote.create({
      data: {
        chainId: encounter.id,
        formCode: '002',
        encounterId: encounter.id,
        authorId: practitioner.id,
        content: { motivo: 'cefalea' },
        status: 'SIGNED',
        signedById: practitioner.id,
        signedAt: new Date('2026-09-14T14:30:00Z'),
        contentHash: 'a'.repeat(64),
      },
    });

    const problem = await problemFrom(
      prisma.clinicalNote.update({
        where: { id: note.id },
        data: { content: { motivo: 'otra cosa' } },
      }),
    );

    expect(problem?.status).toBe(HttpStatus.CONFLICT);
    expect(problem?.code).toBe('IMMUTABLE_RECORD');
  });

  it('turns an out-of-range vital sign into 422', async () => {
    const { prisma, site, practitioner, patient } = await agenda();
    const encounter = await createEncounter(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    });

    const problem = await problemFrom(
      prisma.encounterVitals.create({
        data: { encounterId: encounter.id, weightKg: 750, heightCm: 175 },
      }),
    );

    expect(problem?.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(problem?.code).toBe('VITALS_OUT_OF_RANGE');
  });

  it('NEVER lets the offending row reach the response', async () => {
    // PostgreSQL puts the whole failing row in `detail`, cedula included.
    // Nothing produced here may carry it.
    const { prisma, patient } = await agenda();

    const problem = await problemFrom(
      prisma.patientIdentifier.create({
        data: { patientId: patient.id, type: 'CEDULA', value: '1710034066' },
      }),
    );

    expect(JSON.stringify(problem)).not.toContain('1710034066');
    expect(JSON.stringify(problem)).not.toContain(patient.id);
    expect(JSON.stringify(problem)).not.toMatch(/Failing row/i);
  });

  it('leaves an error it does not understand alone', () => {
    // An unmapped failure is a bug on our side. Returning `undefined` sends it
    // to the generic 500 instead of inventing a reassuring message.
    expect(extractDatabaseProblem(new Error('boom'))).toBeUndefined();
    expect(extractDatabaseProblem(undefined)).toBeUndefined();
    expect(
      extractDatabaseProblem({ code: 'P2999', clientVersion: '7.9.1' }),
    ).toBeUndefined();
  });
});
