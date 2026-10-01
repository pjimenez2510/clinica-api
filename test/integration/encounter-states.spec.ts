import type { PrismaClient } from '@prisma/client';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it } from 'vitest';

import { EncounterExitService } from '../../src/modules/encounter/application/encounter-exit.service';
import {
  contentHashOf,
  type NoteContent,
} from '../../src/modules/encounter/domain/clinical-note';
import {
  EncounterAlreadyClosedError,
  EncounterCloserNotAuthorError,
  AppointmentArrivalNotRecordedError,
  EncounterHasLiveActsError,
  EncounterHasOthersDraftsError,
  InvalidEncounterTransitionError,
  PractitionerNotLicensedError,
  SubstituteClosureReasonRequiredError,
} from '../../src/modules/encounter/domain/encounter.errors';
import { PrismaClinicalActsRepository } from '../../src/modules/billing/infrastructure/prisma-clinical-acts.repository';
import { PrismaEncounterExitRepository } from '../../src/modules/encounter/infrastructure/prisma-encounter-exit.repository';
import { addDays, clinicalDateOf } from '../../src/shared/domain/clinic-time';
import { PrismaClinicalCodingRepository } from '../../src/modules/encounter/infrastructure/prisma-clinical-coding.repository';
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
 * EN-166/AG-147 and EN-167/AG-149 through the real service and adapters: the
 * attention, its notes and its appointment move in ONE transaction.
 */
describe('anular e interrumpir mueven la cita en la misma transacción', () => {
  const quietLogger = {
    setContext: () => undefined,
    info: () => undefined,
  } as unknown as PinoLogger;
  const noAudit = { record: () => Promise.resolve() };

  const serviceOf = (prisma: PrismaClient) =>
    new EncounterExitService(
      new PrismaEncounterExitRepository(prisma as unknown as PrismaService),
      new PrismaEncounterRepository(prisma as unknown as PrismaService),
      noAudit,
      quietLogger,
    );

  const notesOf = (prisma: PrismaClient) =>
    new PrismaClinicalNoteRepository(prisma as unknown as PrismaService);

  /** The appointment in the waiting room with its attention open, and nothing written yet. */
  async function inTheWaitingRoom(prisma: PrismaClient) {
    const { ids, entry, encounter } = await anAttendedAppointment(prisma);
    const doctor = await prisma.practitioner.findUniqueOrThrow({
      where: { id: ids.practitionerId },
    });
    await prisma.agendaEntry.update({
      where: { id: entry.id },
      data: {
        status: 'CHECKED_IN',
        checkedInAt: encounter.startedAt,
        subjectStatus: 'READY',
        subjectStatusAt: encounter.startedAt,
        emergencyAssessedAt: encounter.startedAt,
        emergencyAssessedById: doctor.userId,
      },
    });
    const requester = { userId: doctor.userId, sites: [ids.siteId] };
    return { ids, entry, encounter, doctor, requester };
  }

  /** The author's capture, fixed: the note open, the appointment in attendance. */
  async function inAttentionWithNote(prisma: PrismaClient) {
    const room = await inTheWaitingRoom(prisma);
    const note = await notesOf(prisma).createDraft({
      encounterId: room.encounter.id,
      formCode: '002',
      formVersion: '1',
      content: { motivoConsulta: 'Cefalea de tres días' },
      authorId: room.ids.practitionerId,
      authorUserId: room.doctor.userId,
      sites: [room.ids.siteId],
    });
    return { ...room, note };
  }

  const asAuthor = { canSignRecords: true, signSites: 'all' as const };
  const appointment = (prisma: PrismaClient, id: string) =>
    prisma.agendaEntry.findUniqueOrThrow({ where: { id } });

  it('EN-166 AG-147 anular la atención la deja con su motivo, conserva la nota y devuelve la cita a la sala', async () => {
    const prisma = db();
    const { entry, encounter, note, requester } =
      await inAttentionWithNote(prisma);
    expect((await appointment(prisma, entry.id)).status).toBe('IN_PROGRESS');

    const annulled = await serviceOf(prisma).annul(
      {
        encounterId: encounter.id,
        reason: 'Nota abierta a otro paciente',
        ...asAuthor,
      },
      requester,
    );

    expect(annulled.status).toBe('ENTERED_IN_ERROR');
    expect(annulled.annulment?.reason).toBe('Nota abierta a otro paciente');
    const kept = await prisma.clinicalNote.findUniqueOrThrow({
      where: { id: note.id },
    });
    expect(kept.status).toBe('DRAFT');
    expect(kept.content).toEqual({ motivoConsulta: 'Cefalea de tres días' });

    const back = await appointment(prisma, entry.id);
    expect(back).toMatchObject({ status: 'CHECKED_IN', subjectStatus: 'ARRIVED' }); // prettier-ignore
    expect(back.releasedAt).toBeNull();
    const last = await prisma.agendaStatusHistory.findFirstOrThrow({
      where: { agendaEntryId: entry.id },
      orderBy: { id: 'desc' },
    });
    // A fixed sentence and not the reason: the reason is clinical text, and
    // the agenda's history is read with `agenda:read`.
    expect(last).toMatchObject({
      fromStatus: 'IN_PROGRESS',
      toStatus: 'CHECKED_IN',
      changedById: requester.userId,
      note: 'Atención anulada',
    });
  });

  it('EN-168 AG-147 tras anular, la misma cita admite la atención buena', async () => {
    const prisma = db();
    const { ids, encounter, requester } = await inAttentionWithNote(prisma);
    await serviceOf(prisma).annul(
      { encounterId: encounter.id, reason: 'Ficha equivocada', ...asAuthor },
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

  it('EN-166 una atención ya firmada no se anula: lo firmado se retracta nota a nota (D-085 §1)', async () => {
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
      serviceOf(prisma).annul(
        { encounterId: encounter.id, reason: 'x', ...asAuthor },
        requester,
      ),
    ).rejects.toBeInstanceOf(InvalidEncounterTransitionError);
  });

  it('EN-166 otro profesional anula solo con `record:sign` y motivo de sustitución (D-085 §2)', async () => {
    const prisma = db();
    const { encounter } = await inAttentionWithNote(prisma);
    const other = await createPractitioner(prisma);
    const substitute = { userId: other.userId, sites: [encounter.siteId] };

    await expect(
      serviceOf(prisma).annul(
        { encounterId: encounter.id, reason: 'Ficha equivocada', signSites: [] }, // prettier-ignore
        substitute,
      ),
    ).rejects.toBeInstanceOf(EncounterCloserNotAuthorError);
    await expect(
      serviceOf(prisma).annul(
        { encounterId: encounter.id, reason: 'Ficha equivocada', signSites: [encounter.siteId] }, // prettier-ignore
        substitute,
      ),
    ).rejects.toBeInstanceOf(SubstituteClosureReasonRequiredError);

    // Control positivo: con el motivo, se anula y queda escrito.
    await serviceOf(prisma).annul(
      {
        encounterId: encounter.id,
        reason: 'Ficha equivocada',
        signSites: [encounter.siteId],
        substituteReason: 'La médica tratante salió de turno',
      },
      substitute,
    );
    const stored = await prisma.encounter.findUniqueOrThrow({
      where: { id: encounter.id },
    });
    expect(stored.exitSubstituteReason).toBe(
      'La médica tratante salió de turno',
    );
  });

  it('EN-167 AG-149 interrumpir firma la nota con lo hecho —hash de la firma normal—, sin alta, y deja la cita atendida', async () => {
    const prisma = db();
    const { entry, encounter, note, requester, ids } =
      await inAttentionWithNote(prisma);

    const discontinued = await serviceOf(prisma).discontinue(
      {
        encounterId: encounter.id,
        reason: 'El paciente se retiró a mitad de la consulta',
        origin: 'PATIENT',
        ...asAuthor,
      },
      requester,
    );

    expect(discontinued.status).toBe('DISCONTINUED');
    expect(discontinued.dischargeCondition).toBeNull();
    expect(discontinued.interruption?.origin).toBe('PATIENT');

    // D-082: firmada con lo escrito, y con EL MISMO hash que la firma normal.
    const signed = await prisma.clinicalNote.findUniqueOrThrow({
      where: { id: note.id },
    });
    expect(signed.status).toBe('SIGNED');
    expect(signed.signedById).toBe(ids.practitionerId);
    expect(signed.contentHash).toBe(
      contentHashOf({
        content: signed.content as NoteContent,
        signedById: signed.signedById!,
        signedAt: signed.signedAt!,
      }),
    );

    expect(await appointment(prisma, entry.id)).toMatchObject({
      status: 'FULFILLED',
      subjectStatus: 'DEPARTED',
    });
  });

  it('EN-167 con el ACESS vencido no firma, y la transacción entera se deshace', async () => {
    const prisma = db();
    const { encounter, note, requester, doctor } =
      await inAttentionWithNote(prisma);
    const yesterday = addDays(clinicalDateOf(new Date()), -1);
    await prisma.user.update({
      where: { id: doctor.userId },
      data: { acessExpiresOn: new Date(`${yesterday}T00:00:00.000Z`) },
    });

    await expect(
      serviceOf(prisma).discontinue(
        { encounterId: encounter.id, reason: 'x', origin: 'PATIENT', ...asAuthor }, // prettier-ignore
        requester,
      ),
    ).rejects.toBeInstanceOf(PractitionerNotLicensedError);
    expect(
      (
        await prisma.encounter.findUniqueOrThrow({
          where: { id: encounter.id },
        })
      ).status,
    ).toBe('OPEN');
    expect(
      (await prisma.clinicalNote.findUniqueOrThrow({ where: { id: note.id } }))
        .status,
    ).toBe('DRAFT');
  });

  it('EN-167 con un borrador de otra persona no se interrumpe: quedaría sin firma para siempre (D-085 §2)', async () => {
    const prisma = db();
    const { encounter, requester, ids } = await inAttentionWithNote(prisma);
    const resident = await createPractitioner(prisma);
    await notesOf(prisma).createDraft({
      encounterId: encounter.id,
      formCode: '005',
      formVersion: '1',
      content: { evolucion: 'Escrito por la residente' },
      authorId: resident.id,
      authorUserId: resident.userId,
      sites: [ids.siteId],
    });

    await expect(
      serviceOf(prisma).discontinue(
        { encounterId: encounter.id, reason: 'x', origin: 'PATIENT', ...asAuthor }, // prettier-ignore
        requester,
      ),
    ).rejects.toBeInstanceOf(EncounterHasOthersDraftsError);
  });

  it('EN-167 un borrador vacío no se firma: queda como borrador (D-085 §5)', async () => {
    const prisma = db();
    const room = await inTheWaitingRoom(prisma);
    const empty = await notesOf(prisma).createDraft({
      encounterId: room.encounter.id,
      formCode: '002',
      formVersion: '1',
      content: { motivoConsulta: '   ' },
      authorId: room.ids.practitionerId,
      authorUserId: room.doctor.userId,
      sites: [room.ids.siteId],
    });

    await serviceOf(prisma).discontinue(
      { encounterId: room.encounter.id, reason: 'Urgencia en sala', origin: 'ESTABLISHMENT', ...asAuthor }, // prettier-ignore
      room.requester,
    );

    expect(
      (await prisma.clinicalNote.findUniqueOrThrow({ where: { id: empty.id } }))
        .status,
    ).toBe('DRAFT');
  });

  it('AG-149 interrumpir sin ningún acto clínico con la cita en sala la deja «se fue sin ser atendido», con el cupo libre', async () => {
    const prisma = db();
    const { entry, encounter, requester } = await inTheWaitingRoom(prisma);

    await serviceOf(prisma).discontinue(
      { encounterId: encounter.id, reason: 'Se fue la luz', origin: 'ESTABLISHMENT', ...asAuthor }, // prettier-ignore
      requester,
    );

    const left = await appointment(prisma, entry.id);
    expect(left).toMatchObject({
      status: 'LEFT_WITHOUT_BEING_SEEN',
      subjectStatus: 'DEPARTED',
    });
    expect(left.releasedAt).not.toBeNull();
  });

  it('AG-149 con un acto clínico y la cita aún en sala, la cita queda atendida pasando por «en atención»', async () => {
    const prisma = db();
    const { entry, encounter, requester } = await inTheWaitingRoom(prisma);
    // Un acto clínico sin nota —aquí, una orden de examen— (D-085 §3).
    await prisma.serviceOrder.create({
      data: {
        encounterId: encounter.id,
        siteId: encounter.siteId,
        orderedById: encounter.practitionerId,
        category: 'LABORATORY',
      },
    });

    await serviceOf(prisma).discontinue(
      { encounterId: encounter.id, reason: 'Se retiró', origin: 'PATIENT', ...asAuthor }, // prettier-ignore
      requester,
    );

    const history = await prisma.agendaStatusHistory.findMany({
      where: { agendaEntryId: entry.id },
      orderBy: { id: 'asc' },
    });
    expect(
      history.map((row) => [row.fromStatus, row.toStatus]).slice(-2),
    ).toEqual([
      ['CHECKED_IN', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'FULFILLED'],
    ]);
    expect((await appointment(prisma, entry.id)).status).toBe('FULFILLED');
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
        { encounterId: encounter.id, reason: 'x', origin: 'PATIENT', ...asAuthor }, // prettier-ignore
        requester,
      ),
    ).rejects.toBeInstanceOf(InvalidEncounterTransitionError);
  });

  it('EN-169 lo escrito en una atención anulada no se reescribe, y la base lo garantiza', async () => {
    const prisma = db();
    const { encounter, note, requester, ids } =
      await inAttentionWithNote(prisma);

    // Control positivo: con la atención en curso, el borrador se edita.
    await prisma.clinicalNote.update({
      where: { id: note.id },
      data: { content: { motivoConsulta: 'Cefalea de cuatro días' } },
    });

    await serviceOf(prisma).annul(
      { encounterId: encounter.id, reason: 'Ficha equivocada', ...asAuthor },
      requester,
    );

    // Por el servicio…
    await expect(
      notesOf(prisma).updateDraft(
        { encounterId: encounter.id, noteId: note.id, sites: [ids.siteId] },
        {},
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(EncounterAlreadyClosedError);
    // …y por debajo de él.
    await expect(
      prisma.clinicalNote.update({
        where: { id: note.id },
        data: { content: {} },
      }),
    ).rejects.toThrow(/belongs to an encounter that is over/);
    expect(
      (await prisma.clinicalNote.findUniqueOrThrow({ where: { id: note.id } }))
        .content,
    ).toEqual({ motivoConsulta: 'Cefalea de cuatro días' });
  });

  it('EN-166 con una nota ya firmada en curso no se anula: se retracta antes (D-099 §1)', async () => {
    const prisma = db();
    const { encounter, note, requester, ids } =
      await inAttentionWithNote(prisma);
    const signedAt = new Date();
    await prisma.clinicalNote.update({
      where: { id: note.id },
      data: {
        status: 'SIGNED',
        signedById: ids.practitionerId,
        signedAt,
        contentHash: 'a'.repeat(64),
      },
    });

    await expect(
      serviceOf(prisma).annul(
        { encounterId: encounter.id, reason: 'Ficha equivocada', ...asAuthor },
        requester,
      ),
    ).rejects.toBeInstanceOf(EncounterHasLiveActsError);
    expect(
      (
        await prisma.encounter.findUniqueOrThrow({
          where: { id: encounter.id },
        })
      ).status,
    ).toBe('OPEN');
  });

  it('EN-167 con la cita sin llegada registrada no se interrumpe: se registra antes (D-099 §2)', async () => {
    const prisma = db();
    const { encounter, ids } = await anAttendedAppointment(prisma);
    const doctor = await prisma.practitioner.findUniqueOrThrow({
      where: { id: ids.practitionerId },
    });

    await expect(
      serviceOf(prisma).discontinue(
        { encounterId: encounter.id, reason: 'x', origin: 'PATIENT', ...asAuthor }, // prettier-ignore
        { userId: doctor.userId, sites: [ids.siteId] },
      ),
    ).rejects.toBeInstanceOf(AppointmentArrivalNotRecordedError);
  });

  it('AG-149 la nota abierta y vacía no es acto clínico: interrumpir deja «se fue sin ser atendido», volviendo por la sala (D-099 §2, §5)', async () => {
    const prisma = db();
    const room = await inTheWaitingRoom(prisma);
    // Abrir la nota pasa la cita a «en atención» (AG-146), aunque no se escriba nada.
    await notesOf(prisma).createDraft({
      encounterId: room.encounter.id,
      formCode: '002',
      formVersion: '1',
      content: {},
      authorId: room.ids.practitionerId,
      authorUserId: room.doctor.userId,
      sites: [room.ids.siteId],
    });
    expect((await appointment(prisma, room.entry.id)).status).toBe(
      'IN_PROGRESS',
    );

    await serviceOf(prisma).discontinue(
      { encounterId: room.encounter.id, reason: 'Se fue', origin: 'PATIENT', ...asAuthor }, // prettier-ignore
      room.requester,
    );

    const history = await prisma.agendaStatusHistory.findMany({
      where: { agendaEntryId: room.entry.id },
      orderBy: { id: 'asc' },
    });
    expect(
      history.map((row) => [row.fromStatus, row.toStatus]).slice(-2),
    ).toEqual([
      ['IN_PROGRESS', 'CHECKED_IN'],
      ['CHECKED_IN', 'LEFT_WITHOUT_BEING_SEEN'],
    ]);
  });

  it('EN-169 la base no admite un borrador nuevo en una atención terminada, y sí la enmienda firmada', async () => {
    const prisma = db();
    const { encounter, note, requester, ids } =
      await inAttentionWithNote(prisma);
    await serviceOf(prisma).discontinue(
      { encounterId: encounter.id, reason: 'Se retiró', origin: 'PATIENT', ...asAuthor }, // prettier-ignore
      requester,
    );
    const signed = await prisma.clinicalNote.findUniqueOrThrow({
      where: { id: note.id },
    });

    await expect(
      prisma.clinicalNote.create({
        data: {
          id: ids.agendaEntryId,
          chainId: ids.agendaEntryId,
          version: 1,
          encounterId: encounter.id,
          formCode: '005',
          formVersion: '1',
          status: 'DRAFT',
          content: { evolucion: 'Tarde' },
          authorId: ids.practitionerId,
        },
      }),
    ).rejects.toThrow(/belongs to an encounter that is over/);

    // Control positivo: la enmienda (EN-025) entra firmada y se admite.
    const at = new Date();
    await prisma.$transaction([
      prisma.clinicalNote.update({
        where: { id: signed.id },
        data: { status: 'SUPERSEDED' },
      }),
      prisma.clinicalNote.create({
        data: {
          chainId: signed.chainId,
          version: 2,
          encounterId: encounter.id,
          formCode: signed.formCode,
          formVersion: signed.formVersion,
          status: 'SIGNED',
          content: { motivoConsulta: 'Cefalea de tres días, corregido' },
          authorId: ids.practitionerId,
          signedById: ids.practitionerId,
          signedAt: at,
          contentHash: 'b'.repeat(64),
          supersedesId: signed.id,
          amendmentReason: 'Precisión',
        },
      }),
    ]);
  });

  it('EN-166 EN-167 la base no admite un motivo de sustitución en una atención viva', async () => {
    const prisma = db();
    const { encounter } = await anAttendedAppointment(prisma);

    await expect(
      prisma.encounter.update({
        where: { id: encounter.id },
        data: { exitSubstituteReason: 'a medias' },
      }),
    ).rejects.toThrow(/encounter_exit_substitute_reason_belongs_to_an_exit/);
  });

  it('BI-180 caja lee como no atendida una atención interrumpida sin ningún acto clínico', async () => {
    const prisma = db();
    const { encounter, requester } = await inTheWaitingRoom(prisma);
    await serviceOf(prisma).discontinue(
      { encounterId: encounter.id, reason: 'Se fue', origin: 'PATIENT', ...asAuthor }, // prettier-ignore
      requester,
    );

    const acts = await new PrismaClinicalActsRepository(
      prisma as unknown as PrismaService,
    ).findEncounterActs({
      encounterId: encounter.id,
      siteId: encounter.siteId,
    });

    expect(acts).toMatchObject({
      status: 'DISCONTINUED',
      clinicallyAttended: false,
    });
  });
});

/**
 * M-A (2.ª revisión). A diagnosis or a procedure written WHILE the attention
 * is being annulled or interrupted: the write takes the attention's row
 * `FOR UPDATE` — the same row `lockAndRead` locks — and reads its status
 * again under that lock. Without it the act landed on an attention already
 * closed, or after the exit had read «sin acto» and sent the patient away as
 * not seen.
 */
describe('escribir un diagnóstico o un procedimiento se serializa con anular e interrumpir', () => {
  const quietLogger = {
    setContext: () => undefined,
    info: () => undefined,
  } as unknown as PinoLogger;
  const noAudit = { record: () => Promise.resolve() };
  const asPrisma = (prisma: PrismaClient) => prisma as unknown as PrismaService;
  const coding = (prisma: PrismaClient) =>
    new PrismaClinicalCodingRepository(asPrisma(prisma));

  /** A concept in force since a year before the attention. */
  async function aConcept(
    prisma: PrismaClient,
    systemCode: string,
    since: Date,
  ): Promise<string> {
    const system = await prisma.catalogSystem.upsert({
      where: { code: systemCode },
      create: { code: systemCode, name: `Catálogo ${systemCode}` },
      update: {},
    });
    const concept = await prisma.catalogConcept.create({
      data: {
        systemId: system.id,
        code: systemCode === 'CIE10' ? 'J020' : '99213',
        display: 'Concepto de prueba',
        validFrom: new Date(addDays(clinicalDateOf(since), -365)),
      },
    });
    return concept.id;
  }

  /**
   * Holds the attention's row as `lockAndRead` does, starts `write` while it
   * is held, and then either interrupts the attention or leaves it open
   * before letting go. The write cannot finish before the holder does: the
   * row is locked, and even the foreign key of the insert waits for it.
   */
  async function writeWhileHeld<T>(
    prisma: PrismaClient,
    encounter: { id: string; startedAt: Date },
    closeIt: boolean,
    write: () => Promise<T>,
  ): Promise<PromiseSettledResult<T>> {
    const closer = await createUser(prisma);
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));

    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "encounter" WHERE "id" = ${encounter.id}::uuid FOR UPDATE`;
      locked();
      await released;
      if (!closeIt) return;
      const endedAt = endOf(encounter.startedAt);
      await tx.encounter.update({
        where: { id: encounter.id },
        data: {
          status: 'DISCONTINUED',
          endedAt,
          discontinuedReason: 'El paciente se retiró',
          discontinuedOrigin: 'PATIENT',
          discontinuedById: closer.id,
          discontinuedAt: endedAt,
        },
      });
    });
    await isLocked;
    const written = write().then(
      (value) => ({ status: 'fulfilled', value }) as const,
      (reason: unknown) => ({ status: 'rejected', reason }) as const,
    );
    release();
    await holder;
    return written;
  }

  it('EN-009 EN-167 un diagnóstico que espera a una interrupción en curso se rechaza al verla terminada', async () => {
    const prisma = db();
    const { ids, encounter } = await anAttendedAppointment(prisma);
    const conceptId = await aConcept(prisma, 'CIE10', encounter.startedAt);
    const diagnosis = () =>
      coding(prisma).addDiagnosis({
        encounterId: encounter.id,
        conceptId,
        certainty: 'DEFINITIVE',
        occurrence: 'FIRST_TIME',
        sites: [ids.siteId],
      });

    const refused = await writeWhileHeld(prisma, encounter, true, diagnosis);

    expect(refused.status).toBe('rejected');
    expect(refused.status === 'rejected' && refused.reason).toBeInstanceOf(
      EncounterAlreadyClosedError,
    );
    expect(await prisma.encounterDiagnosis.count({ where: { encounterId: encounter.id } })).toBe(0); // prettier-ignore

    // Control positivo: por el mismo camino, con la atención que sigue abierta, se escribe.
    const { ids: open, encounter: live } = await anAttendedAppointment(prisma);
    const written = await writeWhileHeld(prisma, live, false, () =>
      coding(prisma).addDiagnosis({
        encounterId: live.id,
        conceptId,
        certainty: 'DEFINITIVE',
        occurrence: 'FIRST_TIME',
        sites: [open.siteId],
      }),
    );
    expect(written.status).toBe('fulfilled');
    expect(await prisma.encounterDiagnosis.count({ where: { encounterId: live.id } })).toBe(1); // prettier-ignore
  });

  it('EN-009 EN-167 un procedimiento que espera a una interrupción en curso se rechaza al verla terminada', async () => {
    const prisma = db();
    const { ids, encounter } = await anAttendedAppointment(prisma);
    const conceptId = await aConcept(prisma, 'TARIFF', encounter.startedAt);
    const procedure = (encounterId: string, siteId: string) => () =>
      coding(prisma).addProcedure({
        encounterId,
        conceptId,
        quantity: 1,
        sites: [siteId],
      });

    const refused = await writeWhileHeld(prisma, encounter, true, procedure(encounter.id, ids.siteId)); // prettier-ignore
    expect(refused.status === 'rejected' && refused.reason).toBeInstanceOf(
      EncounterAlreadyClosedError,
    );
    expect(await prisma.encounterProcedure.count({ where: { encounterId: encounter.id } })).toBe(0); // prettier-ignore

    // Control positivo.
    const { ids: open, encounter: live } = await anAttendedAppointment(prisma);
    const written = await writeWhileHeld(prisma, live, false, procedure(live.id, open.siteId)); // prettier-ignore
    expect(written.status).toBe('fulfilled');
  });

  it('AG-149 EN-167 diagnosticar e interrumpir a la vez: o hubo acto y la cita queda atendida, o no lo hubo y se fue sin ser atendido', async () => {
    const prisma = db();
    const { ids, entry, encounter } = await anAttendedAppointment(prisma);
    const doctor = await prisma.practitioner.findUniqueOrThrow({
      where: { id: ids.practitionerId },
    });
    await prisma.agendaEntry.update({
      where: { id: entry.id },
      data: {
        status: 'CHECKED_IN',
        checkedInAt: encounter.startedAt,
        subjectStatus: 'READY',
        subjectStatusAt: encounter.startedAt,
        emergencyAssessedAt: encounter.startedAt,
        emergencyAssessedById: doctor.userId,
      },
    });
    const conceptId = await aConcept(prisma, 'CIE10', encounter.startedAt);
    const exits = new EncounterExitService(
      new PrismaEncounterExitRepository(asPrisma(prisma)),
      new PrismaEncounterRepository(asPrisma(prisma)),
      noAudit,
      quietLogger,
    );

    const [diagnosis, exit] = await Promise.allSettled([
      coding(prisma).addDiagnosis({
        encounterId: encounter.id,
        conceptId,
        certainty: 'DEFINITIVE',
        occurrence: 'FIRST_TIME',
        sites: [ids.siteId],
      }),
      exits.discontinue(
        { encounterId: encounter.id, reason: 'Se retiró', origin: 'PATIENT', canSignRecords: true }, // prettier-ignore
        { userId: doctor.userId, sites: [ids.siteId] },
      ),
    ]);

    // La interrupción no tiene por qué perder: lo que no puede pasar es que la
    // cita diga «no atendido» con un diagnóstico escrito en la atención.
    expect(exit.status).toBe('fulfilled');
    const stored = await prisma.agendaEntry.findUniqueOrThrow({
      where: { id: entry.id },
    });
    const diagnoses = await prisma.encounterDiagnosis.count({
      where: { encounterId: encounter.id },
    });
    if (diagnosis.status === 'fulfilled') {
      expect(diagnoses).toBe(1);
      expect(stored.status).toBe('FULFILLED');
    } else {
      expect(diagnosis.reason).toBeInstanceOf(EncounterAlreadyClosedError);
      expect(diagnoses).toBe(0);
      expect(stored.status).toBe('LEFT_WITHOUT_BEING_SEEN');
    }
  });
});
