import { describe, expect, it } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';
import { PRIORITY_LEVEL } from '../../../shared/domain/priority-level';

import {
  DEFAULT_WAITLIST_PARAMETERS,
  type FreedSlot,
  type WaitlistCandidate,
  entriesToExpire,
  hasExhaustedContactAttempts,
  hasLapsed,
  isCompatibleWith,
  rankCandidates,
  resolveWaitlistParameters,
  statusAfterContact,
} from './waitlist';

const d = parseClinicalDate;

/** Today, for every test in this file. */
const TODAY = d('2026-09-10');

/** An adult with no priority group: level 2 unless a test says otherwise. */
const ADULT = d('1990-03-15');

/** The slot that just came free: 14 September, Dr. P, general consultation. */
const SLOT: FreedSlot = {
  date: d('2026-09-14'),
  practitionerId: 'practitioner-p',
  serviceTypeId: 'service-general',
};

let sequence = 0;

/**
 * An entry that waits, with everything left open — which is what AG-060 makes
 * optional. Tests narrow only the field they are about.
 */
function waiting(
  overrides: Partial<WaitlistCandidate> = {},
): WaitlistCandidate {
  sequence += 1;
  return {
    id: `entry-${String(sequence).padStart(3, '0')}`,
    patientId: `patient-${String(sequence).padStart(3, '0')}`,
    status: 'WAITING',
    enrolledAt: new Date(Date.UTC(2026, 8, sequence, 12, 0)),
    preferredFrom: d('2026-09-01'),
    preferredTo: d('2026-09-30'),
    practitionerId: null,
    serviceTypeId: null,
    contactAttempts: 0,
    lastContactedAt: null,
    patient: { birthDate: ADULT, periods: [], chartMergedAway: false },
    ...overrides,
  };
}

const idsOf = (candidates: readonly { entryId: string }[]) =>
  candidates.map((candidate) => candidate.entryId);

describe('lista de espera', () => {
  describe('AG-061 · qué entrada encaja en el cupo que se liberó', () => {
    it('AG-061 admits an entry that fixes neither practitioner nor service type', () => {
      // «Opcionalmente» in AG-060 means an unstated field matches ANYTHING, so
      // leaving it open widens the match instead of narrowing it.
      expect(isCompatibleWith(waiting(), SLOT)).toBe(true);
    });

    it('AG-061 refuses a slot outside the preferred range and admits both of its ends', () => {
      const entry = waiting({
        preferredFrom: d('2026-09-14'),
        preferredTo: d('2026-09-14'),
      });

      // «Del 14 al 14» is a legitimate range — the patient can only that day.
      expect(isCompatibleWith(entry, SLOT)).toBe(true);
      expect(isCompatibleWith(entry, { ...SLOT, date: d('2026-09-13') })).toBe(
        false,
      );
      expect(isCompatibleWith(entry, { ...SLOT, date: d('2026-09-15') })).toBe(
        false,
      );
    });

    it('AG-061 refuses a slot of another practitioner when the entry fixes one', () => {
      const entry = waiting({ practitionerId: 'practitioner-q' });

      expect(isCompatibleWith(entry, SLOT)).toBe(false);
      expect(
        isCompatibleWith(entry, { ...SLOT, practitionerId: 'practitioner-q' }),
      ).toBe(true);
    });

    it('AG-061 refuses a slot of another service type when the entry fixes one', () => {
      const entry = waiting({ serviceTypeId: 'service-paediatrics' });

      expect(isCompatibleWith(entry, SLOT)).toBe(false);
      // A released BLOCK frees an interval with no service type at all, and an
      // entry that demands one is not satisfied by it.
      expect(isCompatibleWith(entry, { ...SLOT, serviceTypeId: null })).toBe(
        false,
      );
    });
  });

  describe('AG-061 · el orden', () => {
    it('AG-061 puts priority 1 ahead of priority 2 however late it enrolled', () => {
      const early = waiting({
        enrolledAt: new Date(Date.UTC(2026, 7, 1, 8, 0)),
      });
      const lateButPrioritised = waiting({
        enrolledAt: new Date(Date.UTC(2026, 8, 9, 8, 0)),
        patient: {
          birthDate: d('1950-01-01'),
          periods: [],
          chartMergedAway: false,
        },
      });

      const ranked = rankCandidates([early, lateButPrioritised], SLOT, TODAY);

      expect(idsOf(ranked)).toEqual([lateButPrioritised.id, early.id]);
      expect(ranked[0]?.priority).toBe(PRIORITY_LEVEL.PRIORITY);
      expect(ranked[1]?.priority).toBe(PRIORITY_LEVEL.STANDARD);
    });

    it('AG-061 breaks a tie in priority by seniority of enrolment', () => {
      const second = waiting({
        enrolledAt: new Date(Date.UTC(2026, 8, 5, 9, 0)),
      });
      const first = waiting({
        enrolledAt: new Date(Date.UTC(2026, 8, 2, 9, 0)),
      });

      expect(idsOf(rankCandidates([second, first], SLOT, TODAY))).toEqual([
        first.id,
        second.id,
      ]);
    });

    it('AG-061 answers the same order twice when two entries share both criteria', () => {
      /**
       * «¿Por qué el cupo se lo llevó ella y no yo?» cannot have two answers
       * depending on which row PostgreSQL returned first. Same instant, same
       * level: the identifier decides, and it decides the same way every time.
       */
      const sameInstant = new Date(Date.UTC(2026, 8, 3, 9, 0));
      const a = waiting({ id: 'entry-aaa', enrolledAt: sameInstant });
      const b = waiting({ id: 'entry-bbb', enrolledAt: sameInstant });

      expect(idsOf(rankCandidates([b, a], SLOT, TODAY))).toEqual([
        'entry-aaa',
        'entry-bbb',
      ]);
      expect(idsOf(rankCandidates([a, b], SLOT, TODAY))).toEqual([
        'entry-aaa',
        'entry-bbb',
      ]);
    });

    it('AG-061 leaves out every entry the slot does not satisfy', () => {
      const fits = waiting();
      const wrongDay = waiting({
        preferredFrom: d('2026-10-01'),
        preferredTo: d('2026-10-31'),
      });
      const wrongPractitioner = waiting({ practitionerId: 'practitioner-q' });

      expect(
        idsOf(rankCandidates([fits, wrongDay, wrongPractitioner], SLOT, TODAY)),
      ).toEqual([fits.id]);
    });
  });

  describe('AG-062 · la prioridad se deriva, no se guarda', () => {
    it('AG-062 gives priority 1 for a period in force and drops it the day after it lapses, with no write', () => {
      const pregnant = waiting({
        patient: {
          birthDate: ADULT,
          periods: [{ startsOn: d('2026-02-01'), endsOn: d('2026-09-10') }],
          chartMergedAway: false,
        },
      });

      // The very same row, unchanged, read on two consecutive days. A number
      // frozen at enrolment — the `priority` column this table used to carry —
      // would still say 1 in October.
      expect(rankCandidates([pregnant], SLOT, TODAY)[0]?.priority).toBe(
        PRIORITY_LEVEL.PRIORITY,
      );
      expect(
        rankCandidates([pregnant], SLOT, d('2026-09-11'))[0]?.priority,
      ).toBe(PRIORITY_LEVEL.STANDARD);
    });

    it('AG-062 gives priority 1 from the birth date alone, with no recorded group at all', () => {
      const child = waiting({
        patient: {
          birthDate: d('2015-05-05'),
          periods: [],
          chartMergedAway: false,
        },
      });
      const elder = waiting({
        patient: {
          birthDate: d('1950-01-01'),
          periods: [],
          chartMergedAway: false,
        },
      });

      for (const entry of [child, elder]) {
        expect(rankCandidates([entry], SLOT, TODAY)[0]?.priority).toBe(
          PRIORITY_LEVEL.PRIORITY,
        );
      }
    });

    it('AG-062 orders without ever naming the reason', () => {
      /**
       * THE SIGNATURE IS THE GUARANTEE (PA-042, AG-073). A candidate carries
       * two date columns and a birth date; there is nowhere to put a group
       * code, so the four groups of the second sentence of article 35 count
       * for the ORDER — «la misma atención prioritaria» — while staying
       * unreadable without `patient:priority:protected`.
       */
      const victim = waiting({
        patient: {
          birthDate: ADULT,
          periods: [{ startsOn: d('2026-05-01'), endsOn: null }],
          chartMergedAway: false,
        },
      });

      const [ranked] = rankCandidates([victim], SLOT, TODAY);

      expect(ranked?.priority).toBe(PRIORITY_LEVEL.PRIORITY);
      expect(Object.keys(ranked ?? {})).not.toContain('group');
      expect(JSON.stringify(ranked)).not.toMatch(/VIOLENCE|VICTIM|PREGNANT/);
    });

    it('AG-062 leaves out a chart that was merged into another', () => {
      // AG-027 refuses booking for a merged chart and
      // `trg_waitlist_entry_conversion_consented` demands the appointment be of
      // the SAME chart, so proposing it would be offering an untakeable slot.
      const merged = waiting({
        patient: {
          birthDate: d('1950-01-01'),
          periods: [],
          chartMergedAway: true,
        },
      });

      expect(rankCandidates([merged], SLOT, TODAY)).toEqual([]);
    });
  });

  describe('AG-065 · caducar por fecha', () => {
    it('AG-065 expires an entry whose last preferred day is already past, and spares the day itself', () => {
      const today = waiting({ preferredTo: TODAY });
      const yesterday = waiting({ preferredTo: d('2026-09-09') });

      expect(hasLapsed(today, TODAY)).toBe(false);
      expect(hasLapsed(yesterday, TODAY)).toBe(true);

      expect(
        entriesToExpire([today, yesterday], TODAY, DEFAULT_WAITLIST_PARAMETERS),
      ).toEqual([yesterday.id]);
    });

    it('AG-065 never proposes an entry whose preferred range has closed', () => {
      const lapsed = waiting({
        preferredFrom: d('2026-08-01'),
        preferredTo: d('2026-08-31'),
      });

      // Both halves: it does not reach the proposal even if the write that
      // marks it EXPIRED has not happened yet.
      expect(rankCandidates([lapsed], SLOT, TODAY)).toEqual([]);
    });
  });

  describe('AG-066 · caducar por agotar los intentos de la sede', () => {
    it('AG-066 expires an entry that reached the site cap and spares the one below it', () => {
      const parameters = { maxContactAttempts: 3 };
      const exhausted = waiting({ contactAttempts: 3 });
      const oneLeft = waiting({ contactAttempts: 2 });

      expect(hasExhaustedContactAttempts(3, parameters)).toBe(true);
      expect(hasExhaustedContactAttempts(2, parameters)).toBe(false);

      expect(entriesToExpire([exhausted, oneLeft], TODAY, parameters)).toEqual([
        exhausted.id,
      ]);
    });

    it('AG-066 obeys the cap of THIS site and not a number in the code', () => {
      // AG-094: the cap is a site parameter. Two attempts exhaust a site that
      // allows two and leave one to spare in a site that allows three, with
      // the same rows and no deploy in between (D-040 (a)).
      const entry = waiting({ contactAttempts: 2 });

      expect(
        entriesToExpire([entry], TODAY, { maxContactAttempts: 2 }),
      ).toEqual([entry.id]);
      expect(
        entriesToExpire([entry], TODAY, { maxContactAttempts: 3 }),
      ).toEqual([]);
    });

    it('AG-066 closes the entry on the attempt that reaches the cap, and only contacts it before', () => {
      const parameters = { maxContactAttempts: 3 };

      expect(statusAfterContact(1, parameters)).toBe('CONTACTED');
      expect(statusAfterContact(2, parameters)).toBe('CONTACTED');
      expect(statusAfterContact(3, parameters)).toBe('EXPIRED');
    });

    it('AG-066 falls back to the code default only when the site states nothing', () => {
      expect(resolveWaitlistParameters(null)).toEqual({
        maxContactAttempts: 3,
      });
      expect(resolveWaitlistParameters({ maxContactAttempts: 5 })).toEqual({
        maxContactAttempts: 5,
      });
    });
  });

  describe('AG-067 · una entrada cerrada no se propone', () => {
    it('AG-067 leaves SCHEDULED, EXPIRED and CANCELLED out of the candidates', () => {
      const open = waiting();
      const closed = (['SCHEDULED', 'EXPIRED', 'CANCELLED'] as const).map(
        (status) => waiting({ status }),
      );

      expect(idsOf(rankCandidates([...closed, open], SLOT, TODAY))).toEqual([
        open.id,
      ]);
    });

    it('AG-067 does not expire again what is already closed', () => {
      // `trg_waitlist_entry_closure_final` would refuse the write anyway; not
      // issuing it is what keeps the sweep idempotent.
      const closed = waiting({
        status: 'EXPIRED',
        preferredTo: d('2026-01-01'),
      });

      expect(
        entriesToExpire([closed], TODAY, DEFAULT_WAITLIST_PARAMETERS),
      ).toEqual([]);
    });
  });
});
