import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { addDays, clinicalDateOf } from '../../src/shared/domain/clinic-time';

import { isSecondStandingAuthorization } from '../../src/modules/privacy/infrastructure/privacy-database-errors';

import { useDatabase } from './setup/database';
import { createPatient, createUser } from './setup/fixtures';

/**
 * What the LOPDP lets the clinic PROVE about a patient's data only holds if the
 * rows that say it cannot be rewritten afterwards (Reglamento D.E. 904 arts. 5
 * and 15). These are refusals of PostgreSQL itself, so they survive a
 * hand-typed `UPDATE` in `psql` as much as a bug in the service.
 *
 * Every refusal comes with its POSITIVE CONTROL: the permitted write passes on
 * the same row, so a trigger that refused everything would fail here too.
 */
describe('privacy: lo que prueba el aviso, las autorizaciones y las solicitudes no se reescribe', () => {
  const db = useDatabase();

  async function publish(prisma: PrismaClient, version: number, body: string) {
    const author = await createUser(prisma);
    return prisma.privacyNoticeVersion.create({
      data: { version, body, publishedBy: author.id },
    });
  }

  /** PD-068. An authorization as the service writes it: the app's clock. */
  async function authorize(
    prisma: PrismaClient,
    patientId: string,
    purpose: 'REMINDERS' | 'MARKETING' | 'PHOTOS' | 'RESEARCH',
    channel: 'WHATSAPP' | 'EMAIL' | null,
  ) {
    const clerk = await createUser(prisma);
    return prisma.patientAuthorization.create({
      data: {
        patientId,
        purpose,
        channel,
        recordedAt: new Date(),
        recordedBy: clerk.id,
      },
    });
  }

  /**
   * PD-071. Refused by `patient_authorization_one_standing`, read the way the
   * repository reads it: the driver does not put the name in the message.
   */
  async function refusedAsSecondStanding(attempt: Promise<unknown>) {
    const error = await attempt.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).not.toBeNull();
    expect(isSecondStandingAuthorization(error)).toBe(true);
  }

  async function revoke(prisma: PrismaClient, authorizationId: string) {
    const clerk = await createUser(prisma);
    return prisma.patientAuthorizationRevocation.create({
      data: { authorizationId, revokedAt: new Date(), revokedBy: clerk.id },
    });
  }

  async function openRequest(prisma: PrismaClient) {
    const [patient, clerk] = await Promise.all([
      createPatient(prisma),
      createUser(prisma),
    ]);
    const receivedAt = new Date();
    return {
      clerk,
      request: await prisma.dataSubjectRequest.create({
        data: {
          patientId: patient.id,
          right: 'ACCESS',
          requestedBy: 'HOLDER',
          description: 'Copia de mis datos',
          receivedAt,
          dueAt: new Date(receivedAt.getTime() + 24 * 60 * 60 * 1000),
          registeredBy: clerk.id,
        },
      }),
    };
  }

  it('PD-001 acepta la versión siguiente y rechaza saltarse números', async () => {
    const prisma = db();
    // Positive control: 1, then 2.
    await publish(prisma, 1, 'Texto uno');
    await expect(publish(prisma, 2, 'Texto dos')).resolves.toBeTruthy();

    await expect(publish(prisma, 7, 'Texto siete')).rejects.toThrow(
      /must be 3 and not 7/,
    );
  });

  it('PD-003 rechaza modificar o borrar una versión publicada', async () => {
    const prisma = db();
    const first = await publish(prisma, 1, 'Texto original');

    await expect(
      prisma.privacyNoticeVersion.update({
        where: { id: first.id },
        data: { body: 'Texto reescrito' },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.privacyNoticeVersion.delete({ where: { id: first.id } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE privacy_notice_version CASCADE'),
    ).rejects.toThrow(/append-only/);

    const stored = await prisma.privacyNoticeVersion.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(stored.body).toBe('Texto original');
  });

  it('PD-004 la base rechaza un texto en blanco', async () => {
    const prisma = db();
    await expect(publish(prisma, 1, '   ')).rejects.toThrow(
      /privacy_notice_version_body_valid/,
    );
    // Positive control: the same number with real text is accepted.
    await expect(publish(prisma, 1, 'Texto')).resolves.toBeTruthy();
  });

  it('PD-005 dos publicaciones con el mismo número: solo una queda', async () => {
    const prisma = db();
    const author = await createUser(prisma);
    const attempt = (body: string) =>
      prisma.privacyNoticeVersion.create({
        data: { version: 1, body, publishedBy: author.id },
      });

    const outcomes = await Promise.allSettled([attempt('A'), attempt('B')]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.privacyNoticeVersion.count()).toBe(1);
  });

  it('PD-072 una autorización y su revocación no cambian ni se borran', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const granted = await authorize(prisma, patient.id, 'PHOTOS', null);
    // Positive control: revoking is an INSERT, and it goes in.
    await expect(revoke(prisma, granted.id)).resolves.toBeTruthy();

    await expect(
      prisma.patientAuthorization.update({
        where: { id: granted.id },
        data: { purpose: 'RESEARCH' },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.patientAuthorization.delete({ where: { id: granted.id } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.patientAuthorizationRevocation.update({
        where: { authorizationId: granted.id },
        data: { revokedAt: new Date(0) },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.patientAuthorizationRevocation.delete({
        where: { authorizationId: granted.id },
      }),
    ).rejects.toThrow(/append-only/);
    // One revocation per authorization: its key.
    await expect(revoke(prisma, granted.id)).rejects.toThrow(
      /Unique constraint failed/,
    );

    const stored = await prisma.patientAuthorization.findUniqueOrThrow({
      where: { id: granted.id },
      include: { revocation: true },
    });
    expect(stored.purpose).toBe('PHOTOS');
    expect(stored.revocation).not.toBeNull();
  });

  it('PD-070 la base exige canal en recordatorios y publicidad, y ninguno en lo demás', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    await expect(
      authorize(prisma, patient.id, 'REMINDERS', null),
    ).rejects.toThrow(/patient_authorization_channel_matches_purpose/);
    await expect(
      authorize(prisma, patient.id, 'PHOTOS', 'EMAIL'),
    ).rejects.toThrow(/patient_authorization_channel_matches_purpose/);
    // Positive control.
    await expect(
      authorize(prisma, patient.id, 'REMINDERS', 'WHATSAPP'),
    ).resolves.toBeTruthy();
    await expect(
      authorize(prisma, patient.id, 'PHOTOS', null),
    ).resolves.toBeTruthy();
  });

  it('PD-071 una sola vigente por ficha, finalidad y canal; revocada, se vuelve a autorizar', async () => {
    const prisma = db();
    const [patient, other] = await Promise.all([
      createPatient(prisma),
      createPatient(prisma),
    ]);
    const first = await authorize(prisma, patient.id, 'REMINDERS', 'WHATSAPP');

    await refusedAsSecondStanding(
      authorize(prisma, patient.id, 'REMINDERS', 'WHATSAPP'),
    );
    // Positive controls: another channel, another purpose, another chart.
    await expect(
      authorize(prisma, patient.id, 'REMINDERS', 'EMAIL'),
    ).resolves.toBeTruthy();
    await expect(
      authorize(prisma, patient.id, 'MARKETING', 'WHATSAPP'),
    ).resolves.toBeTruthy();
    await expect(
      authorize(prisma, other.id, 'REMINDERS', 'WHATSAPP'),
    ).resolves.toBeTruthy();
    // Once revoked, the same one can be granted again.
    await revoke(prisma, first.id);
    await expect(
      authorize(prisma, patient.id, 'REMINDERS', 'WHATSAPP'),
    ).resolves.toBeTruthy();
    // Without channel, NULL counts as equal: one standing «fotos».
    await authorize(prisma, patient.id, 'PHOTOS', null);
    await refusedAsSecondStanding(
      authorize(prisma, patient.id, 'PHOTOS', null),
    );
  });

  it('PD-071 dos autorizaciones iguales a la vez: gana la primera y la segunda se rechaza', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const clerk = await createUser(prisma);
    const attempt = () =>
      prisma.patientAuthorization.create({
        data: {
          patientId: patient.id,
          purpose: 'RESEARCH',
          channel: null,
          recordedAt: new Date(),
          recordedBy: clerk.id,
        },
      });

    // The first holds the chart's lock in an open transaction; the second
    // is launched only once the first has inserted, so it must wait on the
    // lock and then see the first.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const firstIsIn = new Promise<void>((resolve) => (inserted = resolve));
    const first = prisma.$transaction(async (tx) => {
      const row = await tx.patientAuthorization.create({
        data: {
          patientId: patient.id,
          purpose: 'RESEARCH',
          channel: null,
          recordedAt: new Date(),
          recordedBy: clerk.id,
        },
      });
      inserted();
      await held;
      return row;
    });
    await firstIsIn;
    const second = attempt();
    // The second is blocked on the lock: committing the first unblocks it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'rejected']);
    expect(
      isSecondStandingAuthorization(
        (outcomes[1] as PromiseRejectedResult).reason,
      ),
    ).toBe(true);
    expect(
      await prisma.patientAuthorization.count({
        where: { patientId: patient.id },
      }),
    ).toBe(1);
  });

  it('PD-038 una solicitud admite su respuesta una vez, entera, y nada más', async () => {
    const prisma = db();
    const { clerk, request } = await openRequest(prisma);

    // Changing what was asked, while open, needs who and when (PD-046).
    await expect(
      prisma.dataSubjectRequest.update({
        where: { id: request.id },
        data: { description: 'Otra cosa' },
      }),
    ).rejects.toThrow(/record_version_change_is_stamped/);
    // Half an answer is refused by the CHECK, stamp or no stamp.
    await expect(
      prisma.dataSubjectRequest.update({
        where: { id: request.id },
        data: {
          outcome: 'GRANTED',
          changedBy: clerk.id,
          changedAt: new Date(Date.now() - 1000),
        },
      }),
    ).rejects.toThrow(/data_subject_request_answer_complete/);

    // Positive control: the whole answer, once, with its stamp, is accepted.
    const answeredAt = new Date();
    await expect(
      prisma.dataSubjectRequest.update({
        where: { id: request.id },
        data: {
          outcome: 'GRANTED',
          response: 'Se entregó la exportación',
          answeredAt,
          answeredBy: clerk.id,
          changedBy: clerk.id,
          changedAt: answeredAt,
        },
      }),
    ).resolves.toBeTruthy();

    // And after that, nothing — not even with a new stamp (PD-046, PD-047).
    await expect(
      prisma.dataSubjectRequest.update({
        where: { id: request.id },
        data: {
          response: 'Respuesta cambiada',
          changedBy: clerk.id,
          changedAt: new Date(answeredAt.getTime() + 1000),
        },
      }),
    ).rejects.toThrow(/already answered/);
    await expect(
      prisma.dataSubjectRequest.delete({ where: { id: request.id } }),
    ).rejects.toThrow(/append-only/);
  });

  it('PD-031 la base rechaza una solicitud recibida después de registrarse', async () => {
    const prisma = db();
    const [patient, clerk] = await Promise.all([
      createPatient(prisma),
      createUser(prisma),
    ]);
    const now = new Date();
    const later = new Date(now.getTime() + 60 * 60 * 1000);
    const row = (receivedAt: Date) =>
      prisma.dataSubjectRequest.create({
        data: {
          patientId: patient.id,
          right: 'ACCESS',
          requestedBy: 'HOLDER',
          description: 'Copia',
          receivedAt,
          dueAt: new Date(later.getTime() + 60 * 60 * 1000),
          registeredAt: now,
          registeredBy: clerk.id,
        },
      });

    await expect(row(later)).rejects.toThrow(
      /data_subject_request_received_not_future/,
    );
    await expect(row(now)).resolves.toBeTruthy();
  });

  it('PD-038 PD-032 responder no puede mover el vencimiento ni lo registrado, ni siquiera con la respuesta completa', async () => {
    const prisma = db();
    const { clerk, request } = await openRequest(prisma);
    const answeredAt = new Date();
    const answer = {
      outcome: 'GRANTED' as const,
      response: 'Atendida',
      answeredAt,
      answeredBy: clerk.id,
      changedBy: clerk.id,
      changedAt: answeredAt,
    };
    const later = new Date(request.dueAt.getTime() + 7 * 24 * 60 * 60 * 1000);

    for (const change of [
      { dueAt: later },
      { right: 'ERASURE' as const },
      { receivedAt: new Date(request.receivedAt.getTime() - 60_000) },
    ]) {
      await expect(
        prisma.dataSubjectRequest.update({
          where: { id: request.id },
          data: { ...answer, ...change },
        }),
      ).rejects.toThrow(/admits only its answer/);
    }
    // Control: the same answer, alone, goes in.
    await expect(
      prisma.dataSubjectRequest.update({
        where: { id: request.id },
        data: answer,
      }),
    ).resolves.toBeTruthy();
  });

  it('PD-030 PD-033 la base rechaza descripción y respuesta en blanco, y un vencimiento anterior a la recepción', async () => {
    const prisma = db();
    const [patient, clerk] = await Promise.all([
      createPatient(prisma),
      createUser(prisma),
    ]);
    const now = new Date();
    const row = (overrides: Record<string, unknown>) =>
      prisma.dataSubjectRequest.create({
        data: {
          patientId: patient.id,
          right: 'ACCESS',
          requestedBy: 'HOLDER',
          description: 'Copia',
          receivedAt: now,
          dueAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
          // Same instant on both sides: the base's own `now()` would race the
          // application clock in the not-future CHECK.
          registeredAt: now,
          registeredBy: clerk.id,
          ...overrides,
        },
      });

    await expect(row({ description: '  ' })).rejects.toThrow(
      /data_subject_request_description_valid/,
    );
    await expect(
      row({ dueAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000) }),
    ).rejects.toThrow(/data_subject_request_due_after_receipt/);
    // PD-054. Due at the very instant it arrived is due at birth, too.
    await expect(row({ dueAt: now })).rejects.toThrow(
      /data_subject_request_due_after_receipt/,
    );
    await expect(
      row({
        outcome: 'DENIED',
        response: '   ',
        answeredAt: now,
        answeredBy: clerk.id,
      }),
    ).rejects.toThrow(/data_subject_request_response_valid/);
    // Control: the same row, well formed, goes in.
    await expect(row({})).resolves.toBeTruthy();
  });

  it('PD-001 la base rechaza un número de versión cero o negativo, aun sin el disparador', async () => {
    const prisma = db();
    const author = await createUser(prisma);
    // The BEFORE INSERT trigger refuses 0 first; with triggers off for this
    // transaction only, what refuses it is the CHECK itself.
    const insert = (version: number) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SET LOCAL session_replication_role = replica',
        );
        await tx.privacyNoticeVersion.create({
          data: { version, body: 'Texto', publishedBy: author.id },
        });
      });
    await expect(insert(0)).rejects.toThrow(
      /privacy_notice_version_number_positive/,
    );
    await expect(insert(1)).resolves.toBeUndefined();
  });

  it('PD-072 PD-038 la base rechaza vaciar de golpe autorizaciones y solicitudes', async () => {
    const prisma = db();
    const patient = await createPatient(prisma);
    const granted = await authorize(prisma, patient.id, 'PHOTOS', null);
    await revoke(prisma, granted.id);
    await openRequest(prisma);

    await expect(
      prisma.$executeRawUnsafe('TRUNCATE patient_authorization_revocation'),
    ).rejects.toThrow(/append-only/);
    // Referenced by the revocations: refused either way.
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE patient_authorization'),
    ).rejects.toThrow(/append-only|referenced in a foreign key constraint/);
    // Refused before the trigger even runs since PD-047: the rectified
    // answers point at it, and PostgreSQL does not truncate a referenced
    // table. Either way, nothing goes.
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE data_subject_request'),
    ).rejects.toThrow(/append-only|referenced in a foreign key constraint/);
    expect(await prisma.patientAuthorization.count()).toBe(1);
    expect(await prisma.dataSubjectRequest.count()).toBe(1);
  });

  // --- D-127: corregir sin borrar (PD-046, PD-047) --------------------

  it('PD-046 una solicitud sin responder se edita con sello y deja su versión; ni el paciente ni quién la registró cambian', async () => {
    const prisma = db();
    const { clerk, request } = await openRequest(prisma);
    const editedAt = new Date();

    // Control positivo: derecho, texto, recepción y vencimiento, con sello.
    await prisma.dataSubjectRequest.update({
      where: { id: request.id },
      data: {
        right: 'RECTIFICATION',
        description: 'Corregir el apellido',
        receivedAt: new Date(request.receivedAt.getTime() - 60_000),
        dueAt: request.dueAt,
        changedBy: clerk.id,
        changedAt: editedAt,
      },
    });
    const versions = await prisma.recordVersion.findMany({
      where: { resourceType: 'data_subject_request', resourceId: request.id },
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]?.data).toMatchObject({
      right: 'ACCESS',
      description: 'Copia de mis datos',
    });

    const other = await createPatient(prisma);
    for (const change of [
      { patientId: other.id },
      { registeredBy: (await createUser(prisma)).id },
      { requestedBy: 'REPRESENTATIVE' as const },
    ]) {
      await expect(
        prisma.dataSubjectRequest.update({
          where: { id: request.id },
          data: {
            ...change,
            changedBy: clerk.id,
            changedAt: new Date(editedAt.getTime() + 1000),
          },
        }),
      ).rejects.toThrow(/data_subject_request_only_answered_once/);
    }
  });

  it('PD-047 la respuesta se rectifica con una fila nueva enlazada, y la original no cambia ni se borra', async () => {
    const prisma = db();
    const { clerk, request } = await openRequest(prisma);
    const correctAnswer = (correctsId: string | null) =>
      prisma.dataSubjectAnswerCorrection.create({
        data: {
          requestId: request.id,
          correctsId,
          outcome: 'PARTIALLY_GRANTED',
          response: 'Se entregó todo salvo la historia clínica',
          answeredAt: new Date(),
          answeredBy: clerk.id,
        },
      });

    // Sin respuesta no hay nada que rectificar.
    await expect(correctAnswer(null)).rejects.toThrow(
      /data_subject_answer_correction_follows/,
    );

    const answeredAt = new Date();
    await prisma.dataSubjectRequest.update({
      where: { id: request.id },
      data: {
        outcome: 'DENIED',
        response: 'No procede',
        answeredAt,
        answeredBy: clerk.id,
        changedBy: clerk.id,
        changedAt: answeredAt,
      },
    });

    // Control positivo: la primera rectificación sustituye a la original.
    const first = await correctAnswer(null);
    // Una segunda «primera» no: se rectifica la vigente, en cadena.
    await expect(correctAnswer(null)).rejects.toThrow(
      /Unique constraint failed|data_subject_answer_correction_first_once/,
    );
    const second = await correctAnswer(first.id);
    await expect(correctAnswer(first.id)).rejects.toThrow(
      /Unique constraint failed on the fields: \(`corrects_id`\)/,
    );

    // Nada se reescribe: ni la respuesta original ni las rectificaciones.
    const stored = await prisma.dataSubjectRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(stored).toMatchObject({ outcome: 'DENIED', response: 'No procede' });
    await expect(
      prisma.dataSubjectAnswerCorrection.update({
        where: { id: second.id },
        data: { response: 'Otra' },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.dataSubjectAnswerCorrection.delete({ where: { id: first.id } }),
    ).rejects.toThrow(/append-only/);
  });

  it('PD-047 una rectificación nombra la de su misma solicitud', async () => {
    const prisma = db();
    const a = await openRequest(prisma);
    const b = await openRequest(prisma);
    for (const { clerk, request } of [a, b]) {
      const at = new Date();
      await prisma.dataSubjectRequest.update({
        where: { id: request.id },
        data: {
          outcome: 'GRANTED',
          response: 'Atendida',
          answeredAt: at,
          answeredBy: clerk.id,
          changedBy: clerk.id,
          changedAt: at,
        },
      });
    }
    const ofA = await prisma.dataSubjectAnswerCorrection.create({
      data: {
        requestId: a.request.id,
        outcome: 'DENIED',
        response: 'Rectificada',
        answeredAt: new Date(),
        answeredBy: a.clerk.id,
      },
    });

    await expect(
      prisma.dataSubjectAnswerCorrection.create({
        data: {
          requestId: b.request.id,
          correctsId: ofA.id,
          outcome: 'DENIED',
          response: 'Cruzada',
          answeredAt: new Date(),
          answeredBy: b.clerk.id,
        },
      }),
    ).rejects.toThrow(/data_subject_answer_correction_follows/);
  });

  describe('la copia de la historia clínica (PD-052, PD-053, D-198 §1)', () => {
    async function copyRow(
      prisma: PrismaClient,
      overrides: Record<string, unknown> = {},
    ) {
      const [patient, clerk] = await Promise.all([
        createPatient(prisma),
        createUser(prisma),
      ]);
      const now = new Date();
      return prisma.dataSubjectRequest.create({
        data: {
          patientId: patient.id,
          right: 'ACCESS',
          requestedBy: 'ATTORNEY',
          requesterName: 'Ana Pérez',
          requesterDocument: '1710034065',
          clinicalRecordCopy: true,
          documentsChecked: true,
          description: 'Copia de la historia clínica',
          receivedAt: now,
          dueAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
          registeredAt: now,
          registeredBy: clerk.id,
          ...overrides,
        },
      });
    }

    it('PD-052 PD-053 EN-033 la base admite la copia de un apoderado con su nombre, su documento y la casilla', async () => {
      await expect(copyRow(db())).resolves.toMatchObject({
        requestedBy: 'ATTORNEY',
        clinicalRecordCopy: true,
      });
    });

    it('PD-052 la base rechaza un tercero que no pide la copia', async () => {
      await expect(
        copyRow(db(), { clinicalRecordCopy: false, documentsChecked: false }),
      ).rejects.toThrow(/data_subject_request_third_party_copy_only/);
    });

    it('PD-052 la base rechaza la copia de quien no es el titular sin nombre o sin documento', async () => {
      const prisma = db();
      await expect(copyRow(prisma, { requesterName: null })).rejects.toThrow(
        /data_subject_request_requester_named/,
      );
      await expect(
        copyRow(prisma, {
          requestedBy: 'REPRESENTATIVE',
          requesterDocument: null,
        }),
      ).rejects.toThrow(/data_subject_request_requester_named/);
      await expect(copyRow(prisma, { requesterName: '   ' })).rejects.toThrow(
        /data_subject_request_requester_valid/,
      );
      // Control positivo: el titular no da nombre.
      await expect(
        copyRow(prisma, {
          requestedBy: 'HOLDER',
          requesterName: null,
          requesterDocument: null,
        }),
      ).resolves.toBeTruthy();
    });

    it('PD-053 la base rechaza la copia con otro derecho o sin la casilla', async () => {
      const prisma = db();
      await expect(
        copyRow(prisma, { requestedBy: 'HOLDER', right: 'PORTABILITY' }),
      ).rejects.toThrow(/data_subject_request_copy_is_access/);
      await expect(
        copyRow(prisma, { documentsChecked: false }),
      ).rejects.toThrow(/data_subject_request_copy_documents_checked/);
    });

    it('PD-053 editar una copia no cambia que sea copia, la casilla, ni el nombre o el documento de quien la presenta', async () => {
      const prisma = db();
      const request = await copyRow(prisma);
      const changedBy = request.registeredBy;
      let stamp = new Date(request.registeredAt.getTime() + 1000);
      const edit = (data: Record<string, unknown>) => {
        stamp = new Date(stamp.getTime() + 1000);
        return prisma.dataSubjectRequest.update({
          where: { id: request.id },
          data: { ...data, changedBy, changedAt: stamp },
        });
      };

      for (const change of [
        { requesterName: 'Otra persona' },
        { requesterDocument: '0102030405' },
        { requestedBy: 'AUTHORIZED_PERSON' as const },
      ]) {
        await expect(edit(change)).rejects.toThrow(
          /data_subject_request_only_answered_once/,
        );
      }
      // Dejar de ser copia lo rechaza el disparador, y pasar a otro derecho, el CHECK.
      await expect(
        edit({ clinicalRecordCopy: false, requestedBy: 'HOLDER' }),
      ).rejects.toThrow(/data_subject_request_only_answered_once/);
      await expect(edit({ right: 'RECTIFICATION' })).rejects.toThrow(
        /data_subject_request_copy_is_access/,
      );
      // Control positivo: lo que pide sí se edita.
      await expect(
        edit({ description: 'Copia de la historia clínica completa' }),
      ).resolves.toBeTruthy();
    });

    it('PD-059 la base guarda el periodo sólo en una copia «Atendida en parte», y lo exige en ella; la rectificación igual', async () => {
      const prisma = db();
      const request = await copyRow(prisma);
      const answeredBy = request.registeredBy;
      const day = (offset: number) =>
        new Date(`${addDays(clinicalDateOf(new Date()), offset)}T00:00:00Z`);
      const answer = (data: Record<string, unknown>) =>
        prisma.dataSubjectRequest.update({
          where: { id: request.id },
          data: {
            response: 'Respuesta',
            answeredAt: new Date(),
            answeredBy,
            changedBy: answeredBy,
            changedAt: new Date(request.registeredAt.getTime() + 1000),
            ...data,
          },
        });
      await expect(
        answer({ outcome: 'GRANTED', copyFrom: day(-5), copyTo: day(0) }),
      ).rejects.toThrow(/data_subject_request_copy_period_shape/);
      await expect(answer({ outcome: 'PARTIALLY_GRANTED' })).rejects.toThrow(
        /data_subject_request_copy_period_required/,
      );
      await expect(
        answer({
          outcome: 'PARTIALLY_GRANTED',
          copyFrom: day(0),
          copyTo: day(-5),
        }),
      ).rejects.toThrow(/data_subject_request_copy_period_shape/);
      // Control positivo: el periodo ordenado, con «Atendida en parte».
      await expect(
        answer({
          outcome: 'PARTIALLY_GRANTED',
          copyFrom: day(-5),
          copyTo: day(0),
        }),
      ).resolves.toMatchObject({ outcome: 'PARTIALLY_GRANTED' });

      const correction = (data: Record<string, unknown>) =>
        prisma.dataSubjectAnswerCorrection.create({
          data: {
            requestId: request.id,
            response: 'Rectificada',
            answeredAt: new Date(),
            answeredBy,
            outcome: 'PARTIALLY_GRANTED',
            ...data,
          },
        });
      await expect(correction({})).rejects.toThrow(
        /data_subject_answer_correction_copy_period/,
      );
      await expect(
        correction({ outcome: 'GRANTED', copyFrom: day(-1), copyTo: day(0) }),
      ).rejects.toThrow(/data_subject_answer_correction_copy_period_shape/);
      await expect(
        correction({ copyFrom: day(-1), copyTo: day(0) }),
      ).resolves.toBeTruthy();
    });

    it('PD-063 la base exige el parentesco al familiar, sólo a él, y no lo deja cambiar', async () => {
      const prisma = db();
      await expect(
        copyRow(prisma, { requestedBy: 'DECEASED_RELATIVE' }),
      ).rejects.toThrow(/data_subject_request_relationship_required/);
      await expect(
        copyRow(prisma, { requesterRelationship: 'SPOUSE' }),
      ).rejects.toThrow(/data_subject_request_relationship_only_relative/);
      const relative = await copyRow(prisma, {
        requestedBy: 'DECEASED_RELATIVE',
        requesterRelationship: 'STEPCHILD',
      });
      await expect(
        prisma.dataSubjectRequest.update({
          where: { id: relative.id },
          data: {
            requesterRelationship: 'SPOUSE',
            changedBy: relative.registeredBy,
            changedAt: new Date(relative.registeredAt.getTime() + 1000),
          },
        }),
      ).rejects.toThrow(/data_subject_request_only_answered_once/);
    });

    it('PD-061 DOC-122 el visto bueno y lo congelado de una copia son de sólo inserción, y el visto bueno sólo de una copia', async () => {
      const prisma = db();
      const request = await copyRow(prisma);
      const review = (requestId: string) =>
        prisma.clinicalRecordCopyReview.create({
          data: {
            requestId,
            reviewedAt: new Date(),
            reviewedBy: request.registeredBy,
          },
        });
      const given = await review(request.id);
      await expect(
        prisma.clinicalRecordCopyReview.update({
          where: { id: given.id },
          data: { includesScreening: true },
        }),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.clinicalRecordCopyReview.delete({ where: { id: given.id } }),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.$executeRawUnsafe(
          'TRUNCATE clinical_record_copy_review CASCADE',
        ),
      ).rejects.toThrow(/append-only/);

      const snapshot = await prisma.clinicalRecordCopySnapshot.create({
        data: {
          requestId: request.id,
          data: { frozen: true },
          frozenAt: new Date(),
        },
      });
      // Una por respuesta: la original, otra vez, no.
      await expect(
        prisma.clinicalRecordCopySnapshot.create({
          data: {
            requestId: request.id,
            data: { again: true },
            frozenAt: new Date(),
          },
        }),
      ).rejects.toThrow(
        /Unique constraint failed on the fields: \(`request_id`, `correction_id`\)/,
      );
      await expect(
        prisma.clinicalRecordCopySnapshot.update({
          where: { id: snapshot.id },
          data: { data: { changed: true } },
        }),
      ).rejects.toThrow(/append-only/);

      const plain = await copyRow(prisma, {
        requestedBy: 'HOLDER',
        requesterName: null,
        requesterDocument: null,
        clinicalRecordCopy: false,
        documentsChecked: false,
      });
      await expect(review(plain.id)).rejects.toThrow(
        /clinical_record_copy_review_of_copy/,
      );
    });

    it('PD-063 una solicitud de familiar sin parentesco anterior a la regla se sigue respondiendo', async () => {
      const prisma = db();
      // Una fila de antes: el disparador de alta no corre si se desactiva.
      await prisma.$executeRawUnsafe(
        'ALTER TABLE data_subject_request DISABLE TRIGGER trg_data_subject_request_relationship_required',
      );
      let legacy: Awaited<ReturnType<typeof copyRow>>;
      try {
        legacy = await copyRow(prisma, { requestedBy: 'DECEASED_RELATIVE' });
      } finally {
        await prisma.$executeRawUnsafe(
          'ALTER TABLE data_subject_request ENABLE TRIGGER trg_data_subject_request_relationship_required',
        );
      }
      await expect(
        prisma.dataSubjectRequest.update({
          where: { id: legacy.id },
          data: {
            outcome: 'DENIED',
            response: 'Falta el certificado de defunción',
            answeredAt: new Date(),
            answeredBy: legacy.registeredBy,
            changedBy: legacy.registeredBy,
            changedAt: new Date(legacy.registeredAt.getTime() + 1000),
          },
        }),
      ).resolves.toMatchObject({ outcome: 'DENIED' });
    });
  });
});
