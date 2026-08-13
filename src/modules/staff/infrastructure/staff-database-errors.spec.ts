import { describe, expect, it } from 'vitest';

import {
  isForeignKeyRestriction,
  isRecordNotFound,
} from './staff-database-errors';

/**
 * The translation table, against the error shapes the PostgreSQL 18 driver
 * adapter actually produces — the same shapes `database-problem.spec.ts`
 * re-verifies against the live database. What the real constraints REFUSE is
 * proven in `test/integration/staff-http.spec.ts`; this proves the refusal is
 * recognised for what it is, and that nothing else is mistaken for it.
 *
 * WHY THIS MATTERS FOR ST-010 SPECIFICALLY: the whole requirement hinges on
 * telling «this practitioner has history» apart from every other failure. Read
 * it too broadly and a network error offers the administrator deactivation;
 * too narrowly and a practitioner with a year of signed notes gets deleted.
 */

function prismaError(cause: Record<string, unknown>) {
  return {
    code: 'P2010',
    clientVersion: '7.0.0',
    meta: { driverAdapterError: { cause } },
  };
}

describe('staff database error translation', () => {
  it('ST-010 reconoce el rechazo RESTRICT tal como llega de Prisma 7 sobre el adaptador', () => {
    // The REAL shape, captured against PostgreSQL 18 through the driver
    // adapter: `P2039`, an empty `meta`, and the SQLSTATE only in the text.
    const restricted = {
      code: 'P2039',
      clientVersion: '7.9.1',
      meta: {},
      message:
        'Database error. Code: `23001`. Message: `update or delete on table "practitioner" violates RESTRICT setting of foreign key constraint "agenda_entry_practitioner_id_fkey" on table "agenda_entry"`',
    };

    expect(isForeignKeyRestriction(restricted)).toBe(true);
  });

  it('ST-010 reconoce también el 23503 clásico por si el adaptador vuelve a informarlo', () => {
    const classic = prismaError({
      code: '23503',
      originalMessage:
        'update or delete on table "practitioner" violates foreign key constraint "encounter_practitioner_id_fkey" on table "encounter"',
    });

    expect(isForeignKeyRestriction(classic)).toBe(true);
  });

  it('ST-010 no confunde un único violado con historial: son respuestas distintas', () => {
    // A duplicate cedula is 409 too, and it means something else entirely.
    // Reading it as «has history» would offer deactivating a practitioner who
    // was never created.
    const duplicate = prismaError({
      code: '23505',
      constraint: { index: 'app_user_cedula_key' },
    });

    expect(isForeignKeyRestriction(duplicate)).toBe(false);
  });

  it('ST-010 ignora lo que no es un error de Prisma: un Error corriente sigue su camino', () => {
    expect(isForeignKeyRestriction(new Error('boom'))).toBe(false);
    expect(isForeignKeyRestriction(undefined)).toBe(false);
    expect(isForeignKeyRestriction(null)).toBe(false);
    expect(isForeignKeyRestriction({ code: 'nope' })).toBe(false);
  });

  it('ST-010 reconoce P2025 como fila ausente, que es un 404 y no un conflicto', () => {
    expect(isRecordNotFound({ code: 'P2025' })).toBe(true);
    expect(isRecordNotFound({ code: 'P2002' })).toBe(false);
    expect(isRecordNotFound(null)).toBe(false);
  });
});
