import { describe, expect, it } from 'vitest';

import { resolveDuration } from './duration-resolution';

/**
 * The D-010 contract. Three levels and their precedence, nothing else: the
 * ranges (5..240, multiples of 5) are the database's CHECK and the DTO's
 * schema, proven where they live.
 */
describe('resolveDuration (SP-023, D-010)', () => {
  it('SP-023 la excepción del médico gana a la duración base y a la regla', () => {
    expect(
      resolveDuration({
        exceptionMinutes: 45,
        serviceTypeMinutes: 30,
        ruleSlotMinutes: 20,
      }),
    ).toBe(45);
  });

  it('SP-023 sin excepción rige la duración base del especialidad·tipo', () => {
    expect(
      resolveDuration({
        exceptionMinutes: null,
        serviceTypeMinutes: 30,
        ruleSlotMinutes: 20,
      }),
    ).toBe(30);
  });

  it('SP-023 sin excepción ni tipo rigen los minutos de la regla de horario', () => {
    expect(
      resolveDuration({
        exceptionMinutes: null,
        serviceTypeMinutes: null,
        ruleSlotMinutes: 20,
      }),
    ).toBe(20);
  });

  it('SP-023 un nivel ausente y uno nulo pesan lo mismo: se sigue bajando', () => {
    // The callers mix `undefined` (never loaded) and `null` (loaded, absent);
    // the hierarchy must not distinguish them or the agenda and the screen
    // would resolve differently depending on which repository answered.
    expect(resolveDuration({ serviceTypeMinutes: 30 })).toBe(30);
    expect(resolveDuration({ ruleSlotMinutes: 15 })).toBe(15);
  });

  it('SP-023 devuelve null cuando ninguna fuente conoce una duración', () => {
    expect(resolveDuration({})).toBeNull();
  });

  it('SP-023 no confunde una duración con falsy: el cero no existe pero no se salta', () => {
    // 0 is not a legal duration (the CHECK starts at 5), but the hierarchy
    // must be decided by presence, not truthiness: a bug upstream that
    // produced 0 should surface as 0 and fail the range check, not silently
    // fall through to the rule's minutes.
    expect(
      resolveDuration({ exceptionMinutes: 0, serviceTypeMinutes: 30 }),
    ).toBe(0);
  });
});
