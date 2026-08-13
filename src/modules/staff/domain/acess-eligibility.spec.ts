import { describe, expect, it } from 'vitest';

import { parseClinicalDate } from '../../../shared/domain/clinic-time';

import { ACESS_WARNING_DAYS, acessStatusOn } from './acess-eligibility';

/**
 * The habilitación, day by day.
 *
 * Every case here is a DATE COMPARISON, which is precisely why it is a unit
 * test: the boundary between «may sign» and «may not» is one calendar day
 * wide, and the failure mode is an off-by-one that refuses a signature on a
 * day the ACESS paper says is valid.
 */
const on = (value: string) => parseClinicalDate(value);

describe('la habilitación ACESS', () => {
  it('ST-002 sin registro no está habilitado para firmar, aunque haya fecha', () => {
    const status = acessStatusOn(
      { registration: null, expiresOn: on('2027-01-01') },
      on('2026-08-13'),
    );

    expect(status.eligible).toBe(false);
    expect(status.reason).toBe('MISSING');
  });

  it('ST-002 con registro y sin fecha de caducidad tampoco está habilitado', () => {
    const status = acessStatusOn(
      { registration: 'ACESS-1001', expiresOn: null },
      on('2026-08-13'),
    );

    expect(status.eligible).toBe(false);
    expect(status.reason).toBe('MISSING');
    expect(status.daysToExpiry).toBeNull();
  });

  it('ST-004 un ACESS caducado ayer no habilita a firmar hoy', () => {
    const status = acessStatusOn(
      { registration: 'ACESS-1001', expiresOn: on('2026-08-12') },
      on('2026-08-13'),
    );

    expect(status.eligible).toBe(false);
    expect(status.reason).toBe('EXPIRED');
    // Negative and not zero: the warning and the refusal read the same number.
    expect(status.daysToExpiry).toBe(-1);
    expect(status.expiringSoon).toBe(false);
  });

  it('ST-004 el mismo profesional con el ACESS vigente sí firma', () => {
    // The independent test the SPEC names for S1, both halves of it.
    const status = acessStatusOn(
      { registration: 'ACESS-1001', expiresOn: on('2026-08-14') },
      on('2026-08-13'),
    );

    expect(status.eligible).toBe(true);
    expect(status.reason).toBeUndefined();
  });

  it('ST-004 el día de caducidad es el ÚLTIMO válido, no el primero inválido', () => {
    // The ACESS prints an expiry date and that date is still good. Reading it
    // as exclusive would refuse a signature the paper allows — the kind of
    // off-by-one somebody discovers with a patient at the counter.
    const status = acessStatusOn(
      { registration: 'ACESS-1001', expiresOn: on('2026-08-13') },
      on('2026-08-13'),
    );

    expect(status.eligible).toBe(true);
    expect(status.daysToExpiry).toBe(0);
  });

  it('ST-005 avisa a 30 días o menos sin bloquear nada', () => {
    const status = acessStatusOn(
      { registration: 'ACESS-1001', expiresOn: on('2026-09-12') },
      on('2026-08-13'),
    );

    expect(status.daysToExpiry).toBe(ACESS_WARNING_DAYS);
    expect(status.expiringSoon).toBe(true);
    // The whole point of D-009: the warning replaces the block, it is not one.
    expect(status.eligible).toBe(true);
  });

  it('ST-005 a 31 días todavía no avisa', () => {
    const status = acessStatusOn(
      { registration: 'ACESS-1001', expiresOn: on('2026-09-13') },
      on('2026-08-13'),
    );

    expect(status.daysToExpiry).toBe(31);
    expect(status.expiringSoon).toBe(false);
  });

  it('ST-005 un ACESS ya caducado no se anuncia como «por caducar»', () => {
    // It is past warning: `expiringSoon` would send the screen to the amber
    // banner when what applies is the red one.
    const status = acessStatusOn(
      { registration: 'ACESS-1001', expiresOn: on('2026-07-01') },
      on('2026-08-13'),
    );

    expect(status.expiringSoon).toBe(false);
    expect(status.daysToExpiry).toBe(-43);
  });

  it('ST-004 cruza el cambio de año sin contar de más', () => {
    // 2026 has 365 days; a naive month/day subtraction gets this wrong.
    const status = acessStatusOn(
      { registration: 'ACESS-1001', expiresOn: on('2027-01-05') },
      on('2026-12-31'),
    );

    expect(status.daysToExpiry).toBe(5);
    expect(status.eligible).toBe(true);
  });
});
