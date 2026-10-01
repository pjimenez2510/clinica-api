import { afterEach, describe, expect, it } from 'vitest';

import {
  addDays,
  atWallClock,
  clinicalDateOf,
  wallClockOf,
  WallClockTime,
} from '../../../shared/domain/clinic-time';

import { sessionFamilyExpiry } from './session';

/**
 * AU-043 — the session family expires at 03:00 in the clinic, never after its
 * lifetime (D-065).
 *
 * No instant is written by hand: every one is a wall-clock time on a clinical
 * date counted from today, so the cases read the way the requirement does
 * («entra el lunes a las 08:10») and keep meaning it whatever day they run.
 */
const DAY_MS = 86_400_000;
const today = clinicalDateOf(new Date());

/** `hour:minute` in Guayaquil, `days` after today. */
function at(days: number, hour: number, minute = 0): Date {
  return atWallClock(addDays(today, days), WallClockTime.of(hour, minute));
}

describe('AU-043 la caducidad de una familia de sesión', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    // Assigning `undefined` would leave the string "undefined", an invalid zone.
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('AU-043 quien entra a las 08:10 pierde la sesión a las 03:00 del día 7, no a las 08:10', () => {
    expect(sessionFamilyExpiry(at(0, 8, 10), 7)).toEqual(at(7, 3));
  });

  it('AU-043 quien entra a las 02:00 la pierde a las 03:00 del día 6: nunca después de los 7 días', () => {
    // Las 03:00 del día 7 caerían una hora DESPUÉS del tope.
    expect(sessionFamilyExpiry(at(0, 2), 7)).toEqual(at(6, 3));
  });

  it('AU-043 quien entra a las 03:00 justas la pierde a los 7 días exactos', () => {
    const start = at(0, 3);
    expect(sessionFamilyExpiry(start, 7).getTime() - start.getTime()).toBe(
      7 * DAY_MS,
    );
  });

  it('AU-043 en cada minuto de un día y con el servidor en otro huso: a las 03:00 de Guayaquil, nunca más de N días ni N−1 o menos', () => {
    // N = 1 is allowed by the schema: its sessions live between 0 and 24 h
    // (the SPEC says so); the rule still holds.
    for (const zone of ['UTC', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
      process.env.TZ = zone;
      for (const days of [7, 3, 1]) {
        for (let minute = 0; minute < 24 * 60; minute++) {
          const start = new Date(at(0, 0).getTime() + minute * 60_000);
          const expiry = sessionFamilyExpiry(start, days);
          const life = expiry.getTime() - start.getTime();

          expect(life, start.toISOString()).toBeLessThanOrEqual(days * DAY_MS);
          expect(life, start.toISOString()).toBeGreaterThan(
            (days - 1) * DAY_MS,
          );
          expect(wallClockOf(expiry)).toEqual(WallClockTime.of(3, 0));
        }
      }
    }
  });

  it('AU-043 el huso del servidor no cuenta: se calcula en America/Guayaquil', () => {
    const start = at(0, 8, 10);
    const inGuayaquil = sessionFamilyExpiry(start, 7);

    process.env.TZ = 'Asia/Tokyo';
    expect(new Date(start).getHours()).not.toBe(8); // control: el huso cambió
    expect(sessionFamilyExpiry(start, 7)).toEqual(inGuayaquil);
  });
});
