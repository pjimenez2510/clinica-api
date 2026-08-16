import { describe, expect, it } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';

import {
  type NoShowCountRow,
  noShowWindow,
  summariseNoShow,
} from './no-show-metric';

/**
 * The inasistencia metric, judged without a database.
 *
 * EVERYTHING HERE IS THE RULE, NOT THE QUERY. The adapter counts rows; which
 * cells of that cube belong in the numerator, which in the denominator and
 * which in neither is AG-081, and it is written once in this file so a single
 * test can name it. A `WHERE status <> 'CANCELLED'` in SQL would be a second
 * copy nothing points at.
 */

const NORTE = { siteId: 'site-norte', siteName: 'Sede Norte' };
const SUR = { siteId: 'site-sur', siteName: 'Sede Sur' };
const ANA = { practitionerId: 'prac-ana', practitionerName: 'Ana Vera' };
const LUIS = { practitionerId: 'prac-luis', practitionerName: 'Luis Mora' };

function row(overrides: Partial<NoShowCountRow> = {}): NoShowCountRow {
  return {
    ...NORTE,
    ...ANA,
    bookingChannel: 'PHONE',
    status: 'FULFILLED',
    count: 1,
    ...overrides,
  };
}

describe('la tasa de inasistencia', () => {
  describe('el rango', () => {
    // 06:00Z is 01:00 in Guayaquil, so the host reading it as UTC and the
    // clinic reading it in Ecuador disagree about which day it is.
    const LATE_ENOUGH = new Date('2026-10-31T06:00:00Z');

    it('AG-001 delimita el rango en América/Guayaquil, no en el huso del servidor', () => {
      const window = noShowWindow(
        parseClinicalDate('2026-09-01'),
        parseClinicalDate('2026-09-29'),
        LATE_ENOUGH,
      );

      // 00:00 on the 1st and 00:00 on the 30th, both in Ecuador: UTC-5, so
      // 05:00Z. An appointment at 19:30 on the 29th is 00:30Z on the 30th and
      // has to fall INSIDE — read in UTC it would drop out of its own month
      // and the evening figures would be reported against the next day.
      expect(window.from.toISOString()).toBe('2026-09-01T05:00:00.000Z');
      expect(window.untilExclusive.toISOString()).toBe(
        '2026-09-30T05:00:00.000Z',
      );

      const eveningOfTheLastDay = new Date('2026-09-30T00:30:00Z');
      expect(eveningOfTheLastDay.getTime()).toBeLessThan(
        window.untilExclusive.getTime(),
      );
      expect(eveningOfTheLastDay.getTime()).toBeGreaterThanOrEqual(
        window.from.getTime(),
      );
    });

    it('AG-001 lee el desplazamiento de la zona y no lo da por supuesto', () => {
      // A zone that MOVES, which Ecuador does not: if the five hours were a
      // constant anywhere in this file, this range would come out identical to
      // the one above instead of on Santiago's summer offset.
      const window = noShowWindow(
        parseClinicalDate('2026-01-05'),
        parseClinicalDate('2026-01-05'),
        LATE_ENOUGH,
        'America/Santiago',
      );

      expect(window.from.toISOString()).toBe('2026-01-05T03:00:00.000Z');
      expect(window.untilExclusive.toISOString()).toBe(
        '2026-01-06T03:00:00.000Z',
      );
    });

    it('AG-081 cierra el rango en el instante actual: una cita futura aún no llegó a su hora', () => {
      // Asked for the whole of September, halfway through the 15th.
      const now = new Date('2026-09-15T18:00:00Z');
      const window = noShowWindow(
        parseClinicalDate('2026-09-01'),
        parseClinicalDate('2026-09-30'),
        now,
      );

      // Not the end of the month: an appointment on the 20th has not had the
      // chance to be missed, and counting it would dilute the rate with
      // appointments nobody could have attended yet.
      expect(window.untilExclusive.toISOString()).toBe(now.toISOString());
    });

    it('AG-081 deja el rango vacío cuando entero está por venir', () => {
      const window = noShowWindow(
        parseClinicalDate('2026-12-01'),
        parseClinicalDate('2026-12-31'),
        new Date('2026-09-15T18:00:00Z'),
      );

      // Empty, and not inverted: an adapter handed `untilExclusive < from`
      // would answer with whatever `BETWEEN` does with a backwards range.
      expect(window.untilExclusive.getTime()).toBe(window.from.getTime());
    });
  });

  describe('el cálculo', () => {
    it('AG-080 desglosa la misma tasa por sede, por profesional y por canal', () => {
      const report = summariseNoShow([
        row({ ...NORTE, ...ANA, bookingChannel: 'PHONE', status: 'NO_SHOW', count: 3 }), // prettier-ignore
        row({ ...NORTE, ...ANA, bookingChannel: 'PHONE', status: 'FULFILLED', count: 7 }), // prettier-ignore
        row({ ...SUR, ...LUIS, bookingChannel: 'WEB', status: 'NO_SHOW', count: 1 }), // prettier-ignore
        row({ ...SUR, ...LUIS, bookingChannel: 'WEB', status: 'FULFILLED', count: 9 }), // prettier-ignore
      ]);

      expect(report.overall).toMatchObject({ noShow: 4, total: 20, rate: 0.2 });

      expect(report.bySite).toEqual([
        expect.objectContaining({ siteName: 'Sede Norte', noShow: 3, total: 10, rate: 0.3 }), // prettier-ignore
        expect.objectContaining({ siteName: 'Sede Sur', noShow: 1, total: 10, rate: 0.1 }), // prettier-ignore
      ]);

      expect(report.byPractitioner).toEqual([
        expect.objectContaining({ practitionerName: 'Ana Vera', noShow: 3, total: 10 }), // prettier-ignore
        expect.objectContaining({ practitionerName: 'Luis Mora', noShow: 1, total: 10 }), // prettier-ignore
      ]);

      expect(report.byChannel).toEqual([
        expect.objectContaining({ bookingChannel: 'PHONE', noShow: 3, total: 10 }), // prettier-ignore
        expect.objectContaining({ bookingChannel: 'WEB', noShow: 1, total: 10 }), // prettier-ignore
      ]);
    });

    it('AG-080 suma los canales de un mismo profesional en una sola fila suya', () => {
      // The three breakdowns are cuts of ONE set, not three separate counts:
      // a doctor who takes appointments by telephone and at the counter has
      // one no-show rate, not two.
      const report = summariseNoShow([
        row({ bookingChannel: 'PHONE', status: 'NO_SHOW', count: 2 }),
        row({ bookingChannel: 'WALK_IN', status: 'FULFILLED', count: 6 }),
      ]);

      expect(report.byPractitioner).toHaveLength(1);
      expect(report.byPractitioner[0]).toMatchObject({ noShow: 2, total: 8 });
      expect(report.byChannel).toHaveLength(2);
    });

    it('AG-081 excluye las citas anuladas del numerador y del denominador', () => {
      const report = summariseNoShow([
        row({ status: 'NO_SHOW', count: 2 }),
        row({ status: 'FULFILLED', count: 8 }),
        // Annulled, and one of them is a reschedule's original (AG-050 leaves
        // it CANCELLED): counting them would report an absence that never was.
        row({ status: 'CANCELLED', count: 40 }),
      ]);

      expect(report.overall).toMatchObject({ noShow: 2, total: 10, rate: 0.2 });
    });

    it('AG-081 no publica un grupo cuyas citas fueron todas anuladas', () => {
      const report = summariseNoShow([
        row({ status: 'NO_SHOW', count: 1 }),
        row({ status: 'FULFILLED', count: 3 }),
        row({ ...SUR, ...LUIS, bookingChannel: 'WEB', status: 'CANCELLED', count: 5 }), // prettier-ignore
      ]);

      // A row reading «Sede Sur · 0 de 0» is not information: nothing of that
      // site reached its hour un-annulled, so there is no rate to state.
      expect(report.bySite.map((site) => site.siteName)).toEqual([
        'Sede Norte',
      ]);
      expect(report.byChannel.map((c) => c.bookingChannel)).toEqual(['PHONE']);
    });

    it('AG-080 no inventa una tasa donde no hubo ninguna cita', () => {
      const report = summariseNoShow([]);

      // `null`, never `0`. Zero per cent means «nadie faltó»; this means
      // «no hubo a quién faltar», and a dashboard that shows the first for the
      // second reports a clinic behaving perfectly on a day it did not open.
      expect(report.overall).toEqual({
        noShow: 0,
        total: 0,
        pending: 0,
        rate: null,
      });
      expect(report.bySite).toEqual([]);
      expect(report.byPractitioner).toEqual([]);
      expect(report.byChannel).toEqual([]);
    });

    it('AG-081 cuenta como pendiente la cita que llegó a su hora y nadie cerró', () => {
      const report = summariseNoShow([
        row({ status: 'NO_SHOW', count: 1 }),
        row({ status: 'FULFILLED', count: 5 }),
        // Reached its hour, not annulled, and nobody marked anything: it is in
        // the denominator by AG-081 and it is what makes the rate readable —
        // hiding it would let the figure improve by not recording absences.
        row({ status: 'BOOKED', count: 3 }),
        row({ status: 'CHECKED_IN', count: 1 }),
      ]);

      expect(report.overall).toMatchObject({
        noShow: 1,
        total: 10,
        pending: 4,
        rate: 0.1,
      });
    });

    it('AG-080 redondea la tasa sin arrastrar el ruido del binario', () => {
      const report = summariseNoShow([
        row({ status: 'NO_SHOW', count: 1 }),
        row({ status: 'FULFILLED', count: 2 }),
      ]);

      // 1/3 is not representable: served raw it reaches the screen as
      // 0.3333333333333333 and every client rounds it differently.
      expect(report.overall.rate).toBe(0.3333);
    });

    it('AG-080 ordena los canales como los enumera AG-034, no por su nombre', () => {
      const report = summariseNoShow([
        row({ bookingChannel: 'WEB', status: 'NO_SHOW', count: 1 }),
        row({ bookingChannel: 'PHONE', status: 'NO_SHOW', count: 1 }),
        row({ bookingChannel: 'REFERRAL', status: 'NO_SHOW', count: 1 }),
        row({ bookingChannel: 'WALK_IN', status: 'NO_SHOW', count: 1 }),
      ]);

      // The server decides the order so two screens cannot disagree about it.
      expect(report.byChannel.map((channel) => channel.bookingChannel)).toEqual(
        ['PHONE', 'WALK_IN', 'WEB', 'REFERRAL'],
      );
    });
  });
});
