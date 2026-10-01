import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

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
describe('privacy: lo que prueba el consentimiento y las solicitudes no se reescribe', () => {
  const db = useDatabase();

  async function publish(prisma: PrismaClient, version: number, body: string) {
    const author = await createUser(prisma);
    return prisma.consentTextVersion.create({
      data: { version, body, publishedBy: author.id },
    });
  }

  async function consentOn(prisma: PrismaClient, textVersionId: string) {
    const [patient, clerk] = await Promise.all([
      createPatient(prisma),
      createUser(prisma),
    ]);
    return prisma.patientConsent.create({
      data: {
        patientId: patient.id,
        textVersionId,
        medium: 'ON_SCREEN',
        grantedBy: 'HOLDER',
        recordedBy: clerk.id,
      },
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
          dueOn: receivedAt,
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
      prisma.consentTextVersion.update({
        where: { id: first.id },
        data: { body: 'Texto reescrito' },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.consentTextVersion.delete({ where: { id: first.id } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE consent_text_version CASCADE'),
    ).rejects.toThrow(/append-only/);

    const stored = await prisma.consentTextVersion.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(stored.body).toBe('Texto original');
  });

  it('PD-004 la base rechaza un texto en blanco', async () => {
    const prisma = db();
    await expect(publish(prisma, 1, '   ')).rejects.toThrow(
      /consent_text_version_body_valid/,
    );
    // Positive control: the same number with real text is accepted.
    await expect(publish(prisma, 1, 'Texto')).resolves.toBeTruthy();
  });

  it('PD-005 dos publicaciones con el mismo número: solo una queda', async () => {
    const prisma = db();
    const author = await createUser(prisma);
    const attempt = (body: string) =>
      prisma.consentTextVersion.create({
        data: { version: 1, body, publishedBy: author.id },
      });

    const outcomes = await Promise.allSettled([attempt('A'), attempt('B')]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.consentTextVersion.count()).toBe(1);
  });

  it('PD-013 PD-014 un consentimiento no cambia ni se borra, y una versión nueva no lo toca', async () => {
    const prisma = db();
    const first = await publish(prisma, 1, 'Texto uno');
    const consent = await consentOn(prisma, first.id);

    await publish(prisma, 2, 'Texto dos');

    await expect(
      prisma.patientConsent.update({
        where: { id: consent.id },
        data: { medium: 'SIGNED_PAPER' },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.patientConsent.delete({ where: { id: consent.id } }),
    ).rejects.toThrow(/append-only/);

    const stored = await prisma.patientConsent.findUniqueOrThrow({
      where: { id: consent.id },
      include: { textVersion: true },
    });
    expect(stored.medium).toBe('ON_SCREEN');
    expect(stored.textVersion.version).toBe(1);
    expect(stored.textVersion.body).toBe('Texto uno');
  });

  it('PD-038 una solicitud admite su respuesta una vez, entera, y nada más', async () => {
    const prisma = db();
    const { clerk, request } = await openRequest(prisma);

    // Changing what was registered, even while open, is refused.
    await expect(
      prisma.dataSubjectRequest.update({
        where: { id: request.id },
        data: { description: 'Otra cosa' },
      }),
    ).rejects.toThrow(/admits only its answer/);
    // Half an answer is refused by the CHECK.
    await expect(
      prisma.dataSubjectRequest.update({
        where: { id: request.id },
        data: { outcome: 'GRANTED' },
      }),
    ).rejects.toThrow(/data_subject_request_answer_complete/);

    // Positive control: the whole answer, once, is accepted.
    await expect(
      prisma.dataSubjectRequest.update({
        where: { id: request.id },
        data: {
          outcome: 'GRANTED',
          response: 'Se entregó la exportación',
          answeredAt: new Date(),
          answeredBy: clerk.id,
        },
      }),
    ).resolves.toBeTruthy();

    // And after that, nothing.
    await expect(
      prisma.dataSubjectRequest.update({
        where: { id: request.id },
        data: { response: 'Respuesta cambiada' },
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
          dueOn: later,
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
    const answer = {
      outcome: 'GRANTED' as const,
      response: 'Atendida',
      answeredAt: new Date(),
      answeredBy: clerk.id,
    };
    const later = new Date(request.dueOn.getTime() + 7 * 24 * 60 * 60 * 1000);

    for (const change of [
      { dueOn: later },
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
          dueOn: now,
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
      row({ dueOn: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000) }),
    ).rejects.toThrow(/data_subject_request_due_after_receipt/);
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
        await tx.consentTextVersion.create({
          data: { version, body: 'Texto', publishedBy: author.id },
        });
      });
    await expect(insert(0)).rejects.toThrow(
      /consent_text_version_number_positive/,
    );
    await expect(insert(1)).resolves.toBeUndefined();
  });

  it('PD-014 PD-038 la base rechaza vaciar de golpe consentimientos y solicitudes', async () => {
    const prisma = db();
    const first = await publish(prisma, 1, 'Texto');
    await consentOn(prisma, first.id);
    await openRequest(prisma);

    await expect(
      prisma.$executeRawUnsafe('TRUNCATE patient_consent'),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE data_subject_request'),
    ).rejects.toThrow(/append-only/);
    expect(await prisma.patientConsent.count()).toBe(1);
    expect(await prisma.dataSubjectRequest.count()).toBe(1);
  });
});
