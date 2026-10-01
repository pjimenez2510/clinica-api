import type { PrismaClient } from '@prisma/client';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it } from 'vitest';

import { EncounterService } from '../../src/modules/encounter/application/encounter.service';
import { InvalidEncounterTransitionError } from '../../src/modules/encounter/domain/encounter.errors';
import { PrismaClinicalNoteRepository } from '../../src/modules/encounter/infrastructure/prisma-clinical-note.repository';
import { PrismaEncounterRepository } from '../../src/modules/encounter/infrastructure/prisma-encounter.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createEncounter,
  createPatient,
  createPractitioner,
  createSite,
  createUser,
  hourSlot,
} from './setup/fixtures';

/**
 * Annulling and interrupting an attention, as the DATABASE guarantees them
 * (EN-166, EN-167, EN-168 — D-077, D-080, D-081, D-082).
 *
 * Each refusal goes with its positive control: the same row with the missing
 * datum filled in is accepted. A refusal alone would also pass if the check
 * refused everything.
 */
const db = useDatabase();

async function anAttendedAppointment(prisma: PrismaClient) {
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const patient = await createPatient(prisma);
  const entry = await prisma.agendaEntry.create({
    data: {
      kind: 'APPOINTMENT',
      bookingChannel: 'PHONE',
      siteId: site.id,
      practitionerId: practitioner.id,
      patientId: patient.id,
      ...hourSlot(9),
    },
  });
  const ids = {
    siteId: site.id,
    practitionerId: practitioner.id,
    patientId: patient.id,
    agendaEntryId: entry.id,
  };
  const encounter = await createEncounter(prisma, ids);
  return { ids, entry, encounter };
}

/** The instant the act ends: after it started, never typed by hand. */
const endOf = (startedAt: Date) => new Date(startedAt.getTime() + 20 * 60_000);

describe('EN-166 la atención anulada dice por qué, quién y cuándo', () => {
  it('EN-166 la base rechaza ENTERED_IN_ERROR sin motivo y lo admite con los tres datos', async () => {
    const prisma = db();
    const { encounter } = await anAttendedAppointment(prisma);
    const annuller = await createUser(prisma);
    const endedAt = endOf(encounter.startedAt);

    await expect(
      prisma.encounter.update({
        where: { id: encounter.id },
        data: { status: 'ENTERED_IN_ERROR', endedAt },
      }),
    ).rejects.toThrow(/encounter_entered_in_error_states_who_why_when/);

    await expect(
      prisma.encounter.update({
        where: { id: encounter.id },
        data: {
          status: 'ENTERED_IN_ERROR',
          endedAt,
          enteredInErrorReason: '   ',
          enteredInErrorById: annuller.id,
          enteredInErrorAt: endedAt,
        },
      }),
    ).rejects.toThrow(/encounter_entered_in_error_states_who_why_when/);

    // Control positivo: los tres datos, y la base lo admite.
    const annulled = await prisma.encounter.update({
      where: { id: encounter.id },
      data: {
        status: 'ENTERED_IN_ERROR',
        endedAt,
        enteredInErrorReason: 'Se abrió sobre la ficha de otro paciente',
        enteredInErrorById: annuller.id,
        enteredInErrorAt: endedAt,
      },
    });
    expect(annulled.status).toBe('ENTERED_IN_ERROR');
  });

  it('EN-166 la base rechaza un motivo de anulación en una atención viva', async () => {
    const prisma = db();
    const { encounter } = await anAttendedAppointment(prisma);

    await expect(
      prisma.encounter.update({
        where: { id: encounter.id },
        data: { enteredInErrorReason: 'a medias' },
      }),
    ).rejects.toThrow(/encounter_entered_in_error_states_who_why_when/);
  });
});

describe('EN-167 la atención interrumpida dice por qué, de dónde, quién y cuándo', () => {
  it('EN-167 la base rechaza DISCONTINUED sin origen y lo admite con los cuatro datos', async () => {
    const prisma = db();
    const { encounter } = await anAttendedAppointment(prisma);
    const doctor = await createUser(prisma);
    const endedAt = endOf(encounter.startedAt);

    await expect(
      prisma.encounter.update({
        where: { id: encounter.id },
        data: {
          status: 'DISCONTINUED',
          endedAt,
          discontinuedReason: 'El paciente se retiró a mitad de la consulta',
          discontinuedById: doctor.id,
          discontinuedAt: endedAt,
        },
      }),
    ).rejects.toThrow(/encounter_discontinued_states_who_why_when/);

    const discontinued = await prisma.encounter.update({
      where: { id: encounter.id },
      data: {
        status: 'DISCONTINUED',
        endedAt,
        discontinuedReason: 'El paciente se retiró a mitad de la consulta',
        discontinuedOrigin: 'PATIENT',
        discontinuedById: doctor.id,
        discontinuedAt: endedAt,
      },
    });
    expect(discontinued.discontinuedOrigin).toBe('PATIENT');
  });
});

describe('EN-168 una atención viva por cita', () => {
  it('EN-168 la base rechaza una segunda atención viva sobre la misma cita', async () => {
    const prisma = db();
    const { ids } = await anAttendedAppointment(prisma);

    // P2002: the unique violation. Prisma names the columns and not the
    // index, so the index is identified by the control below: the same insert
    // passes once the first attention is annulled.
    await expect(createEncounter(prisma, ids)).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('EN-168 anulada la primera, la cita admite otra y la anulada sigue atada a ella', async () => {
    const prisma = db();
    const { ids, entry, encounter } = await anAttendedAppointment(prisma);
    const annuller = await createUser(prisma);
    const endedAt = endOf(encounter.startedAt);

    await prisma.encounter.update({
      where: { id: encounter.id },
      data: {
        status: 'ENTERED_IN_ERROR',
        endedAt,
        enteredInErrorReason: 'Se abrió sobre la ficha de otro paciente',
        enteredInErrorById: annuller.id,
        enteredInErrorAt: endedAt,
      },
    });

    const second = await createEncounter(prisma, ids);

    const attached = await prisma.encounter.findMany({
      where: { agendaEntryId: entry.id },
      select: { id: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(attached).toEqual([
      { id: encounter.id, status: 'ENTERED_IN_ERROR' },
      { id: second.id, status: 'OPEN' },
    ]);
  });
});

/**
 * EN-166/AG-147 and EN-167/AG-149 through the real service and adapter: the
 * attention and its appointment move in ONE transaction.
 */
describe('anular e interrumpir mueven la cita en la misma transacción', () => {
  const quietLogger = {
    setContext: () => undefined,
    info: () => undefined,
  } as unknown as PinoLogger;
  const noAudit = { record: () => Promise.resolve() };

  const serviceOf = (prisma: PrismaClient) =>
    new EncounterService(
      new PrismaEncounterRepository(prisma as unknown as PrismaService),
      noAudit,
      quietLogger,
    );

  /** Cita en atención con la nota abierta: la captura del autor, ya corregida. */
  async function inAttentionWithNote(prisma: PrismaClient) {
    const { ids, entry, encounter } = await anAttendedAppointment(prisma);
    const doctor = await prisma.practitioner.findUniqueOrThrow({
      where: { id: ids.practitionerId },
    });
    await prisma.agendaEntry.update({
      where: { id: entry.id },
      data: {
        status: 'CHECKED_IN',
        checkedInAt: encounter.startedAt,
        subjectStatus: 'ARRIVED',
        subjectStatusAt: encounter.startedAt,
        emergencyAssessedAt: encounter.startedAt,
        emergencyAssessedById: doctor.userId,
      },
    });
    const note = await new PrismaClinicalNoteRepository(
      prisma as unknown as PrismaService,
    ).createDraft({
      encounterId: encounter.id,
      formCode: '002',
      formVersion: '1',
      content: { motivoConsulta: 'Cefalea de tres días' },
      authorId: ids.practitionerId,
      authorUserId: doctor.userId,
      sites: [ids.siteId],
    });
    const requester = { userId: doctor.userId, sites: [ids.siteId] };
    return { ids, entry, encounter, note, requester };
  }

  it('EN-166 AG-147 anular la atención la deja con su motivo, conserva la nota y devuelve la cita a la sala', async () => {
    const prisma = db();
    const { entry, encounter, note, requester } =
      await inAttentionWithNote(prisma);
    expect(
      (await prisma.agendaEntry.findUniqueOrThrow({ where: { id: entry.id } }))
        .status,
    ).toBe('IN_PROGRESS');

    const annulled = await serviceOf(prisma).annul(
      { encounterId: encounter.id, reason: 'Nota abierta a otro paciente' },
      requester,
    );

    expect(annulled.status).toBe('ENTERED_IN_ERROR');
    expect(annulled.annulment?.reason).toBe('Nota abierta a otro paciente');
    const kept = await prisma.clinicalNote.findUniqueOrThrow({
      where: { id: note.id },
    });
    expect(kept.status).toBe('DRAFT');
    expect(kept.content).toEqual({ motivoConsulta: 'Cefalea de tres días' });

    const back = await prisma.agendaEntry.findUniqueOrThrow({
      where: { id: entry.id },
    });
    expect(back).toMatchObject({ status: 'CHECKED_IN', subjectStatus: 'ARRIVED' }); // prettier-ignore
    expect(back.releasedAt).toBeNull();
    const last = await prisma.agendaStatusHistory.findFirstOrThrow({
      where: { agendaEntryId: entry.id },
      orderBy: { id: 'desc' },
    });
    expect(last).toMatchObject({
      fromStatus: 'IN_PROGRESS',
      toStatus: 'CHECKED_IN',
      changedById: requester.userId,
      note: 'Nota abierta a otro paciente',
    });
  });

  it('EN-168 AG-147 tras anular, la misma cita admite la atención buena', async () => {
    const prisma = db();
    const { ids, encounter, requester } = await inAttentionWithNote(prisma);
    await serviceOf(prisma).annul(
      { encounterId: encounter.id, reason: 'Ficha equivocada' },
      requester,
    );

    const good = await new PrismaEncounterRepository(
      prisma as unknown as PrismaService,
    ).open({
      siteId: ids.siteId,
      practitionerId: ids.practitionerId,
      patientId: ids.patientId,
      agendaEntryId: ids.agendaEntryId,
      startedAt: new Date(),
      careModality: 'MORBIDITY',
      careSetting: 'INTRAMURAL',
      visitSequence: 'FIRST_TIME',
    });
    expect(good.status).toBe('OPEN');
  });

  it('EN-167 AG-149 interrumpir firma la nota con lo hecho, sin alta, y deja la cita atendida', async () => {
    const prisma = db();
    const { entry, encounter, note, requester } =
      await inAttentionWithNote(prisma);

    const discontinued = await serviceOf(prisma).discontinue(
      {
        encounterId: encounter.id,
        reason: 'El paciente se retiró a mitad de la consulta',
        origin: 'PATIENT',
      },
      requester,
    );

    expect(discontinued.status).toBe('DISCONTINUED');
    expect(discontinued.dischargeCondition).toBeNull();
    expect(discontinued.interruption?.origin).toBe('PATIENT');

    // D-082: firmada con lo escrito, aunque le falte todo lo de un cierre.
    const signed = await prisma.clinicalNote.findUniqueOrThrow({
      where: { id: note.id },
    });
    expect(signed.status).toBe('SIGNED');
    expect(signed.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.content).toEqual({ motivoConsulta: 'Cefalea de tres días' });

    const attended = await prisma.agendaEntry.findUniqueOrThrow({
      where: { id: entry.id },
    });
    expect(attended).toMatchObject({
      status: 'FULFILLED',
      subjectStatus: 'DEPARTED',
    });
  });

  it('EN-167 no interrumpe una atención ya firmada y dada de alta', async () => {
    const prisma = db();
    const { encounter, requester } = await inAttentionWithNote(prisma);
    await prisma.encounter.update({
      where: { id: encounter.id },
      data: {
        status: 'DISCHARGED',
        endedAt: endOf(encounter.startedAt),
        dischargeCondition: 'ALIVE',
      },
    });

    await expect(
      serviceOf(prisma).discontinue(
        { encounterId: encounter.id, reason: 'x', origin: 'PATIENT' },
        requester,
      ),
    ).rejects.toBeInstanceOf(InvalidEncounterTransitionError);
  });
});
