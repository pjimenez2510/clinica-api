import { describe, expect, it } from 'vitest';

import {
  CLINIC_TIME_ZONE,
  WallClockTime,
  addDays,
  atWallClock,
  clinicalDateOf,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import { PatientMergedError } from '../../../shared/domain/errors/patient-merged.error';
import {
  AgendaEntryNotFoundError,
  ReleasedSlotInThePastError,
  SlotNotReleasedError,
  WaitlistEntryClosedError,
  WaitlistEntryNotFoundError,
} from '../domain/agenda.errors';
import type {
  AgendaEntryView,
  AgendaRepository,
  EntryQuery,
  PatientBookingStatus,
} from '../domain/agenda.repository';
import type { WaitlistCandidate, WaitlistStatus } from '../domain/waitlist';
import type {
  NewContactAttempt,
  NewWaitlistEntry,
  StoredWaitlistParameters,
  WaitlistConversion,
  WaitlistEntryQuery,
  WaitlistEntryView,
  WaitlistRepository,
} from '../domain/waitlist.repository';

import { WaitlistService } from './waitlist.service';

const d = parseClinicalDate;

const SITE = 'site-norte';
const OTHER_SITE = 'site-sur';
const PATIENT = 'patient-001';
const PRACTITIONER = 'practitioner-p';
const RECEPTIONIST = 'user-recepcion';

/**
 * ⚠️ THE SERVICE READS THE REAL CLOCK, so everything it is asked about is
 * placed RELATIVE TO NOW.
 *
 * A pinned September would pass today and fail the week the calendar goes past
 * it — AG-061 refuses a slot whose hour has gone, and AG-065 expires an entry
 * whose last preferred day has. The clock is the service's, not the domain's:
 * every rule underneath takes the instant as a parameter, which is what these
 * tests exercise.
 */
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const NOW = new Date();
const inMinutes = (count: number) =>
  new Date(NOW.getTime() + count * MINUTE_MS);
const inDays = (count: number) => new Date(NOW.getTime() + count * DAY_MS);

/** The freed slot, a week away: still there to be offered. */
const FREED_SLOT_STARTS_AT = inDays(7);
/** A range that covers it, from today. */
const PREFERRED_FROM = clinicalDateOf(NOW, CLINIC_TIME_ZONE);
const PREFERRED_TO = clinicalDateOf(inDays(30), CLINIC_TIME_ZONE);

/**
 * The waiting list as the SERVICE decides it.
 *
 * WHAT THIS LEVEL PROVES AND THE INTEGRATION SUITE DOES NOT: which port calls
 * each use case makes and in what order — that a lapsed entry is closed BEFORE
 * anybody is proposed or called, that the author of a contact attempt comes
 * from the session and never from the request, and that a slot still occupying
 * the calendar is refused. The constraints and the triggers are proven where
 * they live, against a real PostgreSQL (`test/integration/agenda-waitlist.spec.ts`).
 */

interface Recorded {
  enrolled: NewWaitlistEntry[];
  expired: string[][];
  attempts: NewContactAttempt[];
  conversions: WaitlistConversion[];
  entryQueries: EntryQuery[];
}

/** Whatever `openWaitlistEntriesFor` is told to answer, with sane defaults. */
function candidate(
  overrides: Partial<WaitlistCandidate> = {},
): WaitlistCandidate {
  return {
    id: 'entry-001',
    patientId: PATIENT,
    status: 'WAITING',
    enrolledAt: inDays(-30),
    preferredFrom: PREFERRED_FROM,
    preferredTo: PREFERRED_TO,
    practitionerId: null,
    serviceTypeId: null,
    contactAttempts: 0,
    lastContactedAt: null,
    patient: {
      birthDate: d('1990-03-15'),
      periods: [],
      chartMergedAway: false,
    },
    ...overrides,
  };
}

function entryView(
  overrides: Partial<WaitlistEntryView> = {},
): WaitlistEntryView {
  return {
    id: 'entry-001',
    siteId: SITE,
    patientId: PATIENT,
    practitionerId: null,
    serviceTypeId: null,
    preferredFrom: PREFERRED_FROM,
    preferredTo: PREFERRED_TO,
    status: 'WAITING',
    convertedEntryId: null,
    contactAttempts: 0,
    lastContactedAt: null,
    createdAt: inDays(-30),
    ...overrides,
  };
}

/** An appointment of the agenda, released or not. */
function agendaEntry(
  overrides: Partial<AgendaEntryView> = {},
): AgendaEntryView {
  return {
    id: 'agenda-001',
    kind: 'APPOINTMENT',
    siteId: SITE,
    practitionerId: PRACTITIONER,
    roomId: null,
    patientId: 'patient-999',
    patientName: null,
    startsAt: FREED_SLOT_STARTS_AT,
    endsAt: new Date(FREED_SLOT_STARTS_AT.getTime() + 30 * MINUTE_MS),
    status: 'CANCELLED',
    blocksCalendar: true,
    overbookingReason: null,
    overbookingAuthorisedById: null,
    releasedAt: inMinutes(-60),
    // AG-041, AG-121, AG-128: nothing of the arrival axis on an entry that
    // was annulled before anybody came.
    checkedInAt: null,
    subjectStatus: null,
    subjectStatusAt: null,
    emergencyAssessedAt: null,
    emergencyFlaggedAt: null,
    bookingChannel: 'PHONE',
    serviceTypeId: 'service-general',
    createdById: RECEPTIONIST,
    rescheduledFromId: null,
    rescheduledToId: null,
    ...overrides,
  };
}

function build(
  overrides: {
    open?: readonly WaitlistCandidate[];
    entry?: WaitlistEntryView | null;
    parameters?: StoredWaitlistParameters | null;
    agenda?: AgendaEntryView | null;
    patient?: PatientBookingStatus | null;
  } = {},
) {
  const recorded: Recorded = {
    enrolled: [],
    expired: [],
    attempts: [],
    conversions: [],
    entryQueries: [],
  };

  const waitlist: WaitlistRepository = {
    enrolInWaitlist: (entry: NewWaitlistEntry) => {
      recorded.enrolled.push(entry);
      return Promise.resolve(
        entryView({
          siteId: entry.siteId,
          patientId: entry.patientId,
          preferredFrom: entry.preferredFrom,
          preferredTo: entry.preferredTo,
          practitionerId: entry.practitionerId,
          serviceTypeId: entry.serviceTypeId,
        }),
      );
    },
    waitlistParametersFor: () =>
      Promise.resolve(
        overrides.parameters === undefined ? null : overrides.parameters,
      ),
    openWaitlistEntriesFor: () => Promise.resolve(overrides.open ?? []),
    expireWaitlistEntries: (ids: readonly string[]) => {
      recorded.expired.push([...ids]);
      return Promise.resolve(ids.length);
    },
    findWaitlistEntry: (query: WaitlistEntryQuery) =>
      Promise.resolve(
        overrides.entry === undefined
          ? entryView({ id: query.entryId, siteId: query.siteId })
          : overrides.entry,
      ),
    recordWaitlistContact: (attempt: NewContactAttempt) => {
      recorded.attempts.push(attempt);
      return Promise.resolve(entryView({ status: attempt.status }));
    },
    convertWaitlistEntry: (conversion: WaitlistConversion) => {
      recorded.conversions.push(conversion);
      return Promise.resolve(
        entryView({
          status: 'SCHEDULED',
          convertedEntryId: conversion.appointmentId,
        }),
      );
    },
  };

  const agenda = {
    findEntry: (query: EntryQuery) => {
      recorded.entryQueries.push(query);
      if (query.siteId !== SITE) return Promise.resolve(null);
      return Promise.resolve(
        overrides.agenda === undefined ? agendaEntry() : overrides.agenda,
      );
    },
    findPatientForBooking: () =>
      Promise.resolve(
        overrides.patient === undefined
          ? { id: PATIENT, mergedIntoMrn: null }
          : overrides.patient,
      ),
  } as unknown as AgendaRepository;

  const logger = {
    setContext: () => undefined,
    info: () => undefined,
  } as never;

  return {
    service: new WaitlistService(waitlist, agenda, logger),
    recorded,
  };
}

describe('WaitlistService', () => {
  describe('AG-060 · inscribir cuando no hay cupo', () => {
    it('AG-060 enrols with site, chart and preferred range, leaving practitioner and service type open', async () => {
      const { service, recorded } = build();

      const entry = await service.enrol({
        siteId: SITE,
        patientId: PATIENT,
        preferredFrom: d('2026-09-01'),
        preferredTo: d('2026-09-30'),
      });

      expect(recorded.enrolled).toEqual([
        {
          siteId: SITE,
          patientId: PATIENT,
          preferredFrom: '2026-09-01',
          preferredTo: '2026-09-30',
          practitionerId: null,
          serviceTypeId: null,
        },
      ]);
      expect(entry.status).toBe('WAITING');
    });

    it('AG-060 keeps the practitioner and the service type when the enrolment fixes them', async () => {
      const { service, recorded } = build();

      await service.enrol({
        siteId: SITE,
        patientId: PATIENT,
        preferredFrom: d('2026-09-01'),
        preferredTo: d('2026-09-30'),
        practitionerId: PRACTITIONER,
        serviceTypeId: 'service-general',
      });

      expect(recorded.enrolled[0]?.practitionerId).toBe(PRACTITIONER);
      expect(recorded.enrolled[0]?.serviceTypeId).toBe('service-general');
    });

    it('AG-060 refuses to enrol a chart that was merged into another', async () => {
      // AG-027 refuses to book it, so the slot could never be given: enrolling
      // would be putting somebody in a queue they can never leave.
      const { service, recorded } = build({
        patient: { id: PATIENT, mergedIntoMrn: 'MRN-000042' },
      });

      await expect(
        service.enrol({
          siteId: SITE,
          patientId: PATIENT,
          preferredFrom: d('2026-09-01'),
          preferredTo: d('2026-09-30'),
        }),
      ).rejects.toBeInstanceOf(PatientMergedError);
      expect(recorded.enrolled).toEqual([]);
    });
  });

  describe('AG-061 · proponer sobre un cupo liberado', () => {
    it('AG-061 proposes the compatible candidates of the released slot, in order', async () => {
      const early = candidate({
        id: 'entry-early',
        enrolledAt: new Date(Date.UTC(2026, 7, 1, 8, 0)),
      });
      const prioritised = candidate({
        id: 'entry-prioritised',
        enrolledAt: new Date(Date.UTC(2026, 8, 9, 8, 0)),
        patient: {
          birthDate: d('1950-01-01'),
          periods: [],
          chartMergedAway: false,
        },
      });
      const otherPractitioner = candidate({
        id: 'entry-other',
        practitionerId: 'practitioner-q',
      });

      const { service } = build({
        open: [early, prioritised, otherPractitioner],
      });

      const proposal = await service.proposeCandidates({
        siteId: SITE,
        entryId: 'agenda-001',
      });

      expect(proposal.candidates.map((c) => c.entryId)).toEqual([
        'entry-prioritised',
        'entry-early',
      ]);
      // The slot comes from the released ROW and not from the query string, so
      // nobody can ask about an interval that never came free.
      expect(proposal.slot.practitionerId).toBe(PRACTITIONER);
      expect(proposal.slot.serviceTypeId).toBe('service-general');
    });

    it('AG-061 resolves the day of the freed slot in Ecuador and not in the session zone', async () => {
      // 20:30 in Guayaquil is already the following day in UTC. An entry whose
      // ONLY preferred day is that one must still be offered the slot.
      const evening = clinicalDateOf(inDays(7), CLINIC_TIME_ZONE);
      const at2030 = atWallClock(evening, WallClockTime.of(20, 30));
      // The premise the test rests on, asserted instead of assumed.
      expect(clinicalDateOf(at2030, 'UTC')).toBe(addDays(evening, 1));

      const onlyThatEvening = candidate({
        preferredFrom: evening,
        preferredTo: evening,
      });
      const { service } = build({
        open: [onlyThatEvening],
        agenda: agendaEntry({
          startsAt: at2030,
          endsAt: new Date(at2030.getTime() + 30 * MINUTE_MS),
        }),
      });

      const proposal = await service.proposeCandidates({
        siteId: SITE,
        entryId: 'agenda-001',
      });

      expect(proposal.slot.date).toBe(evening);
      expect(proposal.candidates).toHaveLength(1);
    });

    /**
     * AG-061. EL DEFECTO QUE ESTA PRUEBA CIERRA: la cita de la mañana se
     * anuló y por la tarde se seguía ofreciendo. Se proponía la cola, se
     * llamaba a alguien de verdad, aceptaba, y la reserva chocaba con AG-031 —
     * gastando por el camino un intento de los tres que la entrada tiene
     * (AG-066), sobre un rastro que no se puede reescribir.
     */
    it('AG-061 refuses to propose over a slot whose hour has already gone', async () => {
      const { service, recorded } = build({
        open: [candidate()],
        agenda: agendaEntry({
          startsAt: inMinutes(-240),
          endsAt: inMinutes(-220),
        }),
      });

      await expect(
        service.proposeCandidates({ siteId: SITE, entryId: 'agenda-001' }),
      ).rejects.toBeInstanceOf(ReleasedSlotInThePastError);
      // Y ni siquiera se barre la cola: no hay nada que repartir, así que
      // nadie sale de ella por una consulta que no se podía responder.
      expect(recorded.expired).toEqual([]);
    });

    /**
     * EL BORDE. Estrictamente antes del instante, como `checkBookingWindow`
     * lee AG-031: lo que empieza dentro de cinco minutos se puede dar —el
     * mínimo de antelación de la sede es de AG-032 y D-001 lo dejó en cero—, y
     * lo que empezó hace un minuto no. Que las dos reglas lean el borde igual
     * es lo que impide que la cola esconda un cupo que la reserva sí acepta.
     */
    it('AG-061 still proposes a slot that starts five minutes from now', async () => {
      const { service } = build({
        open: [candidate({ id: 'entry-soon' })],
        agenda: agendaEntry({
          startsAt: inMinutes(5),
          endsAt: inMinutes(25),
        }),
      });

      const proposal = await service.proposeCandidates({
        siteId: SITE,
        entryId: 'agenda-001',
      });

      expect(proposal.candidates.map((c) => c.entryId)).toEqual(['entry-soon']);
    });

    it('AG-061 refuses a slot that started a minute ago', async () => {
      const { service } = build({
        open: [candidate()],
        agenda: agendaEntry({
          startsAt: inMinutes(-1),
          endsAt: inMinutes(19),
        }),
      });

      await expect(
        service.proposeCandidates({ siteId: SITE, entryId: 'agenda-001' }),
      ).rejects.toBeInstanceOf(ReleasedSlotInThePastError);
    });

    it('AG-061 answers that the slot was never freed before it looks at the clock', async () => {
      // Nombrar una entrada que sigue en pie es otro error, con otra salida
      // —nombrar la que sí se liberó— y es verdad diga lo que diga el reloj.
      const { service } = build({
        agenda: agendaEntry({
          releasedAt: null,
          startsAt: inMinutes(-240),
          endsAt: inMinutes(-220),
        }),
      });

      await expect(
        service.proposeCandidates({ siteId: SITE, entryId: 'agenda-001' }),
      ).rejects.toBeInstanceOf(SlotNotReleasedError);
    });

    it('AG-061 refuses to propose over an entry that still occupies the calendar', async () => {
      const { service } = build({ agenda: agendaEntry({ releasedAt: null }) });

      await expect(
        service.proposeCandidates({ siteId: SITE, entryId: 'agenda-001' }),
      ).rejects.toBeInstanceOf(SlotNotReleasedError);
    });

    it('AG-061 refuses to propose over an overbooking, which never occupied the calendar', async () => {
      const { service } = build({
        agenda: agendaEntry({ blocksCalendar: false }),
      });

      await expect(
        service.proposeCandidates({ siteId: SITE, entryId: 'agenda-001' }),
      ).rejects.toBeInstanceOf(SlotNotReleasedError);
    });

    it('AG-071 answers the same for a released entry of another site as for one that does not exist', async () => {
      const { service } = build();

      await expect(
        service.proposeCandidates({
          siteId: OTHER_SITE,
          entryId: 'agenda-001',
        }),
      ).rejects.toBeInstanceOf(AgendaEntryNotFoundError);
    });
  });

  describe('AG-065 y AG-066 · caducar es un acto, y ocurre antes de decidir', () => {
    it('AG-065 expires the lapsed entries BEFORE proposing anybody', async () => {
      const lapsed = candidate({
        id: 'entry-lapsed',
        preferredFrom: d('2026-01-01'),
        preferredTo: d('2026-01-31'),
      });
      const live = candidate({ id: 'entry-live' });

      const { service, recorded } = build({ open: [lapsed, live] });

      const proposal = await service.proposeCandidates({
        siteId: SITE,
        entryId: 'agenda-001',
      });

      expect(recorded.expired).toEqual([['entry-lapsed']]);
      expect(proposal.candidates.map((c) => c.entryId)).toEqual(['entry-live']);
    });

    it('AG-066 expires the entries that used up the site cap, and obeys the site and not a constant', async () => {
      const twoCalls = candidate({ id: 'entry-two', contactAttempts: 2 });

      // A site that allows three keeps it waiting…
      const generous = build({ open: [twoCalls], parameters: null });
      await generous.service.review({ siteId: SITE });
      expect(generous.recorded.expired).toEqual([]);

      // …and the same rows in a site that allows two close it (AG-094, D-040).
      const strict = build({
        open: [twoCalls],
        parameters: { maxContactAttempts: 2 },
      });
      await strict.service.review({ siteId: SITE });
      expect(strict.recorded.expired).toEqual([['entry-two']]);
    });

    it('AG-065 writes nothing when nothing has lapsed', async () => {
      const { service, recorded } = build({ open: [candidate()] });

      await service.review({ siteId: SITE });

      expect(recorded.expired).toEqual([]);
    });
  });

  describe('AG-064 · registrar el intento, y no reasignar sin confirmación', () => {
    it('AG-064 records the attempt with the author taken from the session', async () => {
      const { service, recorded } = build();

      await service.recordContact(
        { siteId: SITE, entryId: 'entry-001', outcome: 'NO_ANSWER' },
        { userId: RECEPTIONIST },
      );

      expect(recorded.attempts).toEqual([
        {
          entryId: 'entry-001',
          outcome: 'NO_ANSWER',
          recordedById: RECEPTIONIST,
          status: 'CONTACTED',
        },
      ]);
    });

    it('AG-066 closes the entry on the attempt that reaches the site cap', async () => {
      const { service, recorded } = build({
        entry: entryView({ contactAttempts: 2 }),
        parameters: { maxContactAttempts: 3 },
      });

      await service.recordContact(
        { siteId: SITE, entryId: 'entry-001', outcome: 'NO_ANSWER' },
        { userId: RECEPTIONIST },
      );

      expect(recorded.attempts[0]?.status).toBe('EXPIRED');
    });

    it('AG-064 leaves the entry open when the patient accepts: the acceptance authorises, it does not schedule', async () => {
      // The entry becomes SCHEDULED when the appointment exists and is linked
      // (AG-063). Closing it here would leave the patient off the list holding
      // no appointment at all.
      const { service, recorded } = build();

      await service.recordContact(
        { siteId: SITE, entryId: 'entry-001', outcome: 'ACCEPTED' },
        { userId: RECEPTIONIST },
      );

      expect(recorded.attempts[0]?.status).toBe('CONTACTED');
      expect(recorded.conversions).toEqual([]);
    });

    it('AG-064 leaves the entry open when the patient declines, because D-040 (b) is not ours to answer', async () => {
      const { service, recorded } = build();

      await service.recordContact(
        { siteId: SITE, entryId: 'entry-001', outcome: 'DECLINED' },
        { userId: RECEPTIONIST },
      );

      expect(recorded.attempts[0]?.status).toBe('CONTACTED');
    });

    it('AG-071 answers the same for an entry of another site as for one that does not exist', async () => {
      const { service } = build({ entry: null });

      await expect(
        service.recordContact(
          { siteId: OTHER_SITE, entryId: 'entry-001', outcome: 'NO_ANSWER' },
          { userId: RECEPTIONIST },
        ),
      ).rejects.toBeInstanceOf(WaitlistEntryNotFoundError);
    });
  });

  describe('AG-063 · convertir en cita', () => {
    it('AG-063 links the appointment and closes the entry as SCHEDULED', async () => {
      const { service, recorded } = build();

      const converted = await service.convert({
        siteId: SITE,
        entryId: 'entry-001',
        appointmentId: 'agenda-001',
      });

      expect(recorded.conversions).toEqual([
        { entryId: 'entry-001', appointmentId: 'agenda-001' },
      ]);
      expect(converted.status).toBe('SCHEDULED');
      expect(converted.convertedEntryId).toBe('agenda-001');
    });

    it('AG-071 refuses to link an appointment of another site, with the same answer as a missing one', async () => {
      const { service, recorded } = build({ agenda: null });

      await expect(
        service.convert({
          siteId: SITE,
          entryId: 'entry-001',
          appointmentId: 'agenda-999',
        }),
      ).rejects.toBeInstanceOf(AgendaEntryNotFoundError);
      expect(recorded.conversions).toEqual([]);
    });
  });

  describe('AG-067 · lo cerrado no se propone ni se toca', () => {
    it.each(['SCHEDULED', 'EXPIRED', 'CANCELLED'] as const)(
      'AG-067 refuses to record a contact on an entry that is already %s',
      async (status: WaitlistStatus) => {
        const { service, recorded } = build({ entry: entryView({ status }) });

        await expect(
          service.recordContact(
            { siteId: SITE, entryId: 'entry-001', outcome: 'NO_ANSWER' },
            { userId: RECEPTIONIST },
          ),
        ).rejects.toBeInstanceOf(WaitlistEntryClosedError);
        expect(recorded.attempts).toEqual([]);
      },
    );

    it('AG-067 refuses to convert an entry that is already closed', async () => {
      const { service, recorded } = build({
        entry: entryView({ status: 'EXPIRED' }),
      });

      await expect(
        service.convert({
          siteId: SITE,
          entryId: 'entry-001',
          appointmentId: 'agenda-001',
        }),
      ).rejects.toBeInstanceOf(WaitlistEntryClosedError);
      expect(recorded.conversions).toEqual([]);
    });

    it('AG-067 leaves closed entries out of the waiting list of the site', async () => {
      const { service } = build({
        open: [
          candidate({ id: 'entry-open' }),
          candidate({ id: 'entry-closed', status: 'CANCELLED' }),
        ],
      });

      const waiting = await service.review({ siteId: SITE });

      expect(waiting.map((entry) => entry.entryId)).toEqual(['entry-open']);
    });
  });
});
