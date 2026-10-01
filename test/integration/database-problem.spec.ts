import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { extractDatabaseProblem } from '../../src/shared/http/database-problem';
import '../../src/modules/agenda/infrastructure/agenda.constraints';
import '../../src/modules/patients/infrastructure/patients.constraints';
import '../../src/modules/catalogs/infrastructure/catalogs.constraints';
import '../../src/modules/encounter/infrastructure/encounter.constraints';
import '../../src/modules/certificates/infrastructure/certificate.constraints';
import {
  addDays,
  clinicalDateOf,
  type ClinicalDate,
} from '../../src/shared/domain/clinic-time';

import { useDatabase } from './setup/database';
import {
  createDiagnosis,
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
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
        bookingChannel: 'PHONE',
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
          bookingChannel: 'PHONE',
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
        bookingChannel: 'PHONE',
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
          bookingChannel: 'PHONE',
          siteId: site.id,
          practitionerId: second.id,
          roomId: room.id,
          patientId: (await createPatient(prisma)).id,
          ...hourSlot(9),
        },
      }),
    );

    expect(problem?.code).toBe('ROOM_SLOT_TAKEN');
    expect(problem?.errors?.[0]?.field).toBe('roomId');
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
    expect(problem?.errors?.[0]?.message).toMatch(/dígito verificador/);
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
          bookingChannel: 'PHONE',
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
        data: {
          encounterId: encounter.id,
          weightKg: 750,
          heightCm: 175,
          heightPosition: 'STANDING',
          recordedById: (await createUser(prisma)).id,
        },
      }),
    );

    expect(problem?.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(problem?.code).toBe('VITALS_OUT_OF_RANGE');
    // EN-062: the constraint name says which box, never the value it held.
    expect(problem?.errors?.[0]?.field).toBe('weightKg');
    expect(JSON.stringify(problem)).not.toContain('750');
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

  it('turns an encounter starting before the patient was born into 422', async () => {
    // Raised by a TRIGGER, not by a declarative constraint, so it carries
    // SQLSTATE 23000 — the class code. That was missing from the table and
    // this plain data-entry mistake answered 500.
    const { prisma, site, practitioner } = await agenda();
    const baby = await createPatient(prisma, {
      birthDate: new Date('2026-09-20'),
    });

    const problem = await problemFrom(
      prisma.encounter.create({
        data: {
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: baby.id,
          startedAt: new Date('2026-09-14T14:00:00Z'),
          careModality: 'MORBIDITY',
          visitSequence: 'FIRST_TIME',
        },
      }),
    );

    expect(problem?.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(problem?.code).toBe('INTEGRITY_RULE_FAILED');
  });

  it('turns an encounter filed against another patient into 422', async () => {
    // The only thing standing between a diagnosis and the wrong medical
    // record. It also answered 500.
    const { prisma, site, practitioner, patient } = await agenda();
    const appointment = await prisma.agendaEntry.create({
      data: {
        kind: 'APPOINTMENT',
        bookingChannel: 'PHONE',
        siteId: site.id,
        practitionerId: practitioner.id,
        patientId: patient.id,
        ...hourSlot(9),
      },
    });
    const someoneElse = await createPatient(prisma);

    const problem = await problemFrom(
      prisma.encounter.create({
        data: {
          siteId: site.id,
          practitionerId: practitioner.id,
          patientId: someoneElse.id,
          agendaEntryId: appointment.id,
          startedAt: new Date('2026-09-14T14:00:00Z'),
          careModality: 'MORBIDITY',
          visitSequence: 'FIRST_TIME',
        },
      }),
    );

    expect(problem?.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(problem?.code).toBe('INTEGRITY_RULE_FAILED');
  });

  /**
   * One medical certificate by raw SQL, so the trigger and not the service is
   * what refuses it. Every date derives from the encounter's own `started_at`.
   */
  function certificate(
    prisma: ReturnType<typeof db>,
    row: {
      encounterId: string;
      patientId: string;
      issuedById: string;
      issuedAt: Date;
      rest?: { from: ClinicalDate; to: ClinicalDate };
      maternity?: { admissionOn: ClinicalDate; birthOn: ClinicalDate; dischargeOn: ClinicalDate }; // prettier-ignore
      backdatingReason?: string;
    },
  ) {
    const rest = row.rest ?? null;
    const maternity = row.maternity ?? null;
    const contingency =
      rest === null
        ? null
        : maternity === null
          ? 'GENERAL_ILLNESS'
          : 'MATERNITY';
    return prisma.$executeRaw`
      INSERT INTO medical_certificate
        (encounter_id, patient_id, issued_by_id, type, rest_from, rest_to,
         include_diagnosis, contingency_type, verification_code, issued_at,
         rest_backdating_reason, maternity_admission_on, birth_on,
         maternity_discharge_on)
      VALUES (${row.encounterId}::uuid, ${row.patientId}::uuid,
              ${row.issuedById}::uuid,
              ${rest === null ? 'ATTENDANCE' : 'MEDICAL_REST'}::certificate_type,
              ${rest?.from ?? null}::date, ${rest?.to ?? null}::date,
              ${rest !== null},
              ${contingency}::certificate_contingency_type,
              ${`DBP-${crypto.randomUUID().slice(0, 8)}`}, ${row.issuedAt},
              ${row.backdatingReason ?? null},
              ${maternity?.admissionOn ?? null}::date,
              ${maternity?.birthOn ?? null}::date,
              ${maternity?.dischargeOn ?? null}::date)
    `;
  }

  it('CER-039 keeps the code of a check_violation a TRIGGER raises by name', async () => {
    // `RAISE … USING CONSTRAINT` names the rule, but @prisma/adapter-pg only
    // copies `constraint` for a foreign key: for 23514 the name survives only
    // as the prefix of the message the trigger wrote. Without reading it, a
    // certificate issued by a colleague without a reason answered the generic
    // CHECK_FAILED and no field was highlighted.
    const { prisma, site, practitioner, patient } = await agenda();
    const encounter = await createEncounter(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    });
    // Control positivo: the practitioner who attended issues it without one.
    await expect(
      certificate(prisma, {
        encounterId: encounter.id,
        patientId: patient.id,
        issuedById: practitioner.id,
        issuedAt: encounter.startedAt,
      }),
    ).resolves.toBe(1);

    const problem = await problemFrom(
      certificate(prisma, {
        encounterId: encounter.id,
        patientId: patient.id,
        issuedById: (await createPractitioner(prisma)).id,
        issuedAt: encounter.startedAt,
      }),
    );

    expect(problem).toEqual({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      slug: 'validation',
      title: 'Datos inválidos',
      code: 'CERTIFICATE_ISSUER_REASON_REQUIRED',
      errors: [
        {
          field: 'issuedByOtherReason',
          code: 'CERTIFICATE_ISSUER_REASON_REQUIRED',
          message:
            'Explique por qué emite el certificado de una atención que no registró',
        },
      ],
    });
  });

  it('CER-048 keeps the code of an exclusion_violation a TRIGGER raises by name, as 409', async () => {
    const { prisma, site, practitioner, patient } = await agenda();
    const encounter = await createEncounter(prisma, {
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
    });
    await createDiagnosis(prisma, encounter.id, 'O80');
    const day = clinicalDateOf(encounter.startedAt);
    const birth = addDays(day, -2);
    const backdatingReason = 'Dio a luz antes de la atención';
    const maternity = {
      admissionOn: addDays(birth, -2),
      birthOn: birth,
      dischargeOn: addDays(birth, 2),
    };
    // Control positivo: the same rows that overlap below are accepted alone.
    await expect(
      certificate(prisma, {
        encounterId: encounter.id,
        patientId: patient.id,
        issuedById: practitioner.id,
        issuedAt: encounter.startedAt,
        rest: { from: birth, to: day },
        maternity,
        backdatingReason,
      }),
    ).resolves.toBe(1);

    const problem = await problemFrom(
      certificate(prisma, {
        encounterId: encounter.id,
        patientId: patient.id,
        issuedById: practitioner.id,
        issuedAt: encounter.startedAt,
        rest: { from: birth, to: day },
        maternity,
        backdatingReason,
      }),
    );

    expect(problem?.status).toBe(HttpStatus.CONFLICT);
    expect(problem?.code).toBe('CERTIFICATE_REST_OVERLAPS');
    expect(problem?.errors?.[0]?.field).toBe('restFrom');
  });

  it('reads a trigger prefix only for a REGISTERED name, at the start, in class 23', () => {
    // The prefix is the trigger's own text, but the guard is the registry:
    // a name nobody registered, a registered name anywhere but the start, or
    // a SQLSTATE outside class 23 keeps the generic answer.
    const raised = (code: string, originalMessage: string) => ({
      code: 'P2039',
      clientVersion: '7.9.1',
      meta: { driverAdapterError: { cause: { code, originalMessage } } },
    });

    expect(
      extractDatabaseProblem(
        raised('23514', 'medical_certificate_issuer_reason_required: x'),
      )?.code,
    ).toBe('CERTIFICATE_ISSUER_REASON_REQUIRED');
    expect(
      extractDatabaseProblem(raised('23514', 'nobody_registered_this: x'))
        ?.code,
    ).toBe('CHECK_FAILED');
    expect(
      extractDatabaseProblem(raised('23P01', 'nobody_registered_this: x'))
        ?.code,
    ).toBe('OVERLAPPING_RECORD');
    expect(
      extractDatabaseProblem(
        raised('23514', 'value medical_certificate_issuer_reason_required: x'),
      )?.code,
    ).toBe('CHECK_FAILED');
    expect(
      extractDatabaseProblem(
        raised('P0001', 'medical_certificate_issuer_reason_required: x'),
      )?.code,
    ).toBe('INTEGRITY_RULE_FAILED');
    expect(
      extractDatabaseProblem(raised('23514', 'constructor: x'))?.code,
    ).toBe('CHECK_FAILED');
  });

  it('NEVER lets a client steer which error it gets back', () => {
    // A trigger message interpolates the value it rejected. With an unanchored
    // search, a client sending a field containing `constraint "..."` chose
    // which of the registry messages the API returned, and which input the
    // interface highlighted.
    const forged = {
      code: 'P2039',
      clientVersion: '7.9.1',
      meta: {
        driverAdapterError: {
          cause: {
            code: '23000',
            originalMessage:
              'frozen cie10_code constraint "agenda_entry_no_practitioner_overlap" does not match concept',
          },
        },
      },
    };

    const problem = extractDatabaseProblem(forged);

    expect(problem?.code).toBe('INTEGRITY_RULE_FAILED');
    expect(problem?.code).not.toBe('PRACTITIONER_SLOT_TAKEN');
    expect(problem?.errors).toBeUndefined();
  });

  it('reports the database being unreachable as 503, not 500', () => {
    // The client has to be able to tell "retry in a moment" from "this server
    // has a bug". /health already called this `down`; the API contradicted it.
    const unreachable = { code: 'P1001', clientVersion: '7.9.1' };

    expect(extractDatabaseProblem(unreachable)).toEqual({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      slug: 'service-unavailable',
      title: 'Servicio no disponible',
      code: 'DATABASE_UNAVAILABLE',
    });
  });

  it('does NOT dress a real privilege failure up as a business conflict', () => {
    // 42501 is also what a missing GRANT raises. Mapping it wholesale meant a
    // least-privilege deployment would answer 409 — and 409 logs at `warn`, so
    // a total write outage would page nobody.
    const missingGrant = {
      code: 'P2039',
      clientVersion: '7.9.1',
      meta: {
        driverAdapterError: {
          cause: {
            code: '42501',
            originalMessage: 'permission denied for table patient',
          },
        },
      },
    };

    expect(extractDatabaseProblem(missingGrant)).toBeUndefined();
  });

  it('does not resolve a constraint name through the prototype chain', () => {
    const hostile = {
      code: 'P2039',
      clientVersion: '7.9.1',
      meta: {
        driverAdapterError: {
          cause: {
            code: '23514',
            originalMessage:
              'new row for relation "x" violates check constraint "constructor"',
          },
        },
      },
    };

    // Falls back to the SQLSTATE meaning instead of building a malformed body
    // out of `Object.prototype.constructor`.
    expect(extractDatabaseProblem(hostile)?.code).toBe('CHECK_FAILED');
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
