import { describe, expect, it } from 'vitest';

import {
  WallClockTime,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';

import {
  closeScheduleRuleOn,
  isInForceOn,
  scheduleRuleProblems,
} from './schedule-rule';

const on = (value: string) => parseClinicalDate(value);
const at = (value: string) => WallClockTime.parse(value);

const RULE = {
  weekday: 1,
  startTime: at('08:00'),
  endTime: at('12:00'),
  slotMinutes: 20,
  validFrom: on('2026-01-01'),
  validTo: null,
};

describe('la regla de horario', () => {
  it('ST-045 acepta una franja en la que el turno cabe holgadamente', () => {
    expect(scheduleRuleProblems(RULE)).toEqual([]);
  });

  it('ST-045 rechaza que la hora de fin no sea posterior a la de inicio', () => {
    const problems = scheduleRuleProblems({
      ...RULE,
      startTime: at('12:00'),
      endTime: at('08:00'),
    });

    expect(problems.map((problem) => problem.field)).toContain('endTime');
  });

  it('ST-045 rechaza un turno que no cabe ni una vez en la franja', () => {
    // Representable, ordered, positive — and it yields NOT ONE slot. On screen
    // that is a practitioner with no agenda and nothing saying why.
    const problems = scheduleRuleProblems({
      ...RULE,
      startTime: at('08:00'),
      endTime: at('08:15'),
      slotMinutes: 20,
    });

    expect(problems).toEqual([
      expect.objectContaining({ field: 'slotMinutes' }),
    ]);
  });

  it('ST-045 admite el turno que cabe EXACTAMENTE una vez', () => {
    expect(
      scheduleRuleProblems({
        ...RULE,
        startTime: at('08:00'),
        endTime: at('08:20'),
        slotMinutes: 20,
      }),
    ).toEqual([]);
  });

  it('ST-045 informa de TODOS los errores a la vez, no del primero', () => {
    // An administrator fixing a form one refusal at a time is how a two-field
    // mistake becomes three round trips.
    const problems = scheduleRuleProblems({
      weekday: 9,
      startTime: at('12:00'),
      endTime: at('08:00'),
      slotMinutes: 0,
      validFrom: on('2026-03-01'),
      validTo: on('2026-02-01'),
    });

    expect(problems.map((problem) => problem.field).sort()).toEqual([
      'endTime',
      'slotMinutes',
      'validTo',
      'weekday',
    ]);
  });

  it('ST-041 rechaza una vigencia vacía: el fin no puede ser anterior al inicio', () => {
    // An empty daterange overlaps nothing, so such a rule would also slip past
    // the ST-042 exclusion entirely.
    expect(
      scheduleRuleProblems({
        ...RULE,
        validFrom: on('2026-05-02'),
        validTo: on('2026-05-01'),
      }).map((problem) => problem.field),
    ).toEqual(['validTo']);
  });

  it('ST-041 admite una vigencia de UN SOLO día: el fin es inclusivo', () => {
    // `valid_to` means «the last day the rule rules», the same way
    // `slot-availability.ts` has read it since E1. A rule for one Monday only
    // is a real thing — a locum covering a single day.
    expect(
      scheduleRuleProblems({
        ...RULE,
        validFrom: on('2026-05-01'),
        validTo: on('2026-05-01'),
      }),
    ).toEqual([]);
  });

  it('ST-041 cerrar una regla rige HACIA ADELANTE: hoy sigue vigente, mañana no', () => {
    const closure = closeScheduleRuleOn(
      { validFrom: on('2026-01-01'), validTo: null },
      on('2026-08-13'),
    );

    // `validTo` is the LAST day the rule rules, so closing today leaves today
    // intact: a schedule change must not cancel the morning already half over.
    expect(closure).toEqual({ kind: 'CLOSE', validTo: '2026-08-13' });
    expect(
      isInForceOn({ validFrom: on('2026-01-01'), validTo: on('2026-08-13') }, on('2026-08-13')), // prettier-ignore
    ).toBe(true);
    expect(
      isInForceOn({ validFrom: on('2026-01-01'), validTo: on('2026-08-13') }, on('2026-08-14')), // prettier-ignore
    ).toBe(false);
  });

  it('ST-041 cerrar no toca los días ya pasados: la vigencia anterior se conserva', () => {
    const rule = { validFrom: on('2026-01-01'), validTo: null };

    const closure = closeScheduleRuleOn(rule, on('2026-08-13'));

    expect(closure.kind).toBe('CLOSE');
    // Every day before the closure still falls inside the validity, so last
    // month's appointments keep the rule that justified them.
    expect(
      isInForceOn({ ...rule, validTo: on('2026-08-13') }, on('2026-07-15')),
    ).toBe(true);
  });

  it('ST-041 cerrar una regla ya cerrada antes no alarga su vigencia', () => {
    const closure = closeScheduleRuleOn(
      { validFrom: on('2026-01-01'), validTo: on('2026-06-01') },
      on('2026-08-13'),
    );

    expect(closure).toEqual({ kind: 'CLOSE', validTo: '2026-06-01' });
  });

  it('ST-041 una regla que aún no empieza se desactiva en vez de cerrarse', () => {
    // Ending it «from today» would produce an empty range, which the base
    // refuses — and there are no past days to protect, because it never ruled.
    const closure = closeScheduleRuleOn(
      { validFrom: on('2026-09-01'), validTo: null },
      on('2026-08-13'),
    );

    expect(closure).toEqual({ kind: 'DEACTIVATE' });
  });

  it('ST-041 el día de fin SÍ rige, y el siguiente ya no', () => {
    // Inclusive, exactly as `slot-availability.ts` reads it. If these two
    // disagreed, the agenda would offer a slot the exclusion constraint
    // considers to belong to a different rule.
    const rule = { validFrom: on('2026-01-01'), validTo: on('2026-08-14') };

    expect(isInForceOn(rule, on('2026-08-14'))).toBe(true);
    expect(isInForceOn(rule, on('2026-08-15'))).toBe(false);
    expect(isInForceOn(rule, on('2025-12-31'))).toBe(false);
  });

  it('ST-041 sin fecha de fin la regla rige indefinidamente', () => {
    expect(
      isInForceOn({ validFrom: on('2026-01-01'), validTo: null }, on('2030-01-01')), // prettier-ignore
    ).toBe(true);
  });
});
