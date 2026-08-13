import { describe, expect, it } from 'vitest';

import {
  ServiceTypeDuplicateError,
  SpecialtyDuplicateError,
} from '../domain/specialties.errors';
import {
  duplicateErrorFrom,
  isForeignKeyRestriction,
  isRecordNotFound,
} from './specialties-database-errors';

/**
 * The translation table, against the error shapes the PostgreSQL 18 driver
 * adapter actually produces — the same shapes `database-problem.spec.ts`
 * re-verifies against the live database. What the real indexes REFUSE is
 * proven in `test/integration/specialties-http.spec.ts`; this proves the
 * refusal is translated to the code the SPEC fixes and nothing else is.
 */

function prismaError(cause: Record<string, unknown>) {
  return {
    code: 'P2010',
    clientVersion: '7.0.0',
    meta: { driverAdapterError: { cause } },
  };
}

function uniqueViolation(constraint: string, via: 'index' | 'message') {
  return prismaError({
    code: '23505',
    ...(via === 'index'
      ? { constraint: { index: constraint } }
      : {
          originalMessage: `duplicate key value violates unique constraint "${constraint}"`,
        }),
  });
}

describe('specialties database error translation', () => {
  it('SP-006 traduce specialty_code_unique y specialty_name_unique a SPECIALTY_DUPLICATE señalando el campo', () => {
    const byCode = duplicateErrorFrom(uniqueViolation('specialty_code_unique', 'index')); // prettier-ignore
    const byName = duplicateErrorFrom(uniqueViolation('specialty_name_unique', 'message')); // prettier-ignore

    expect(byCode).toBeInstanceOf(SpecialtyDuplicateError);
    expect(byCode?.fieldErrors?.[0]?.field).toBe('code');
    expect(byName).toBeInstanceOf(SpecialtyDuplicateError);
    expect(byName?.fieldErrors?.[0]?.field).toBe('name');
  });

  it('SP-026 traduce service_type_name_unique_per_specialty a SERVICE_TYPE_DUPLICATE', () => {
    const error = duplicateErrorFrom(
      uniqueViolation('service_type_name_unique_per_specialty', 'index'),
    );

    expect(error).toBeInstanceOf(ServiceTypeDuplicateError);
  });

  it('SP-006 deja pasar intacto un único ajeno: traducirlo mentiría sobre su causa', () => {
    expect(
      duplicateErrorFrom(uniqueViolation('patient_identifier_active', 'index')),
    ).toBeUndefined();
  });

  it('SP-003/SP-025 reconoce el rechazo de una clave foránea RESTRICT tal como llega de Prisma 7', () => {
    // The REAL shape, captured against PostgreSQL 18 through the driver
    // adapter: `P2039`, an empty `meta`, and the SQLSTATE only in the text.
    const restricted = {
      code: 'P2039',
      clientVersion: '7.9.1',
      meta: {},
      message:
        'Database error. Code: `23001`. Message: `update or delete on table "specialty" violates RESTRICT setting of foreign key constraint "service_type_specialty_id_fkey" on table "service_type"`',
    };

    expect(isForeignKeyRestriction(restricted)).toBe(true);
    expect(isForeignKeyRestriction(uniqueViolation('x', 'index'))).toBe(false);
    expect(isForeignKeyRestriction(new Error('plain'))).toBe(false);
  });

  it('SP-003 reconoce también el 23503 clásico por si el adaptador vuelve a informarlo', () => {
    const classic = prismaError({
      code: '23503',
      originalMessage:
        'update or delete on table "specialty" violates foreign key constraint "service_type_specialty_id_fkey" on table "service_type"',
    });

    expect(isForeignKeyRestriction(classic)).toBe(true);
  });

  it('SP-004 reconoce P2025 como fila ausente sin confundirlo con otra cosa', () => {
    expect(isRecordNotFound({ code: 'P2025' })).toBe(true);
    expect(isRecordNotFound({ code: 'P2002' })).toBe(false);
    expect(isRecordNotFound(null)).toBe(false);
  });

  it('SP-006 ignora lo que no es un error de Prisma: un Error corriente sigue su camino', () => {
    expect(duplicateErrorFrom(new Error('boom'))).toBeUndefined();
    expect(duplicateErrorFrom(undefined)).toBeUndefined();
    expect(duplicateErrorFrom({ code: 'nope' })).toBeUndefined();
  });
});
