import { describe, expect, it } from 'vitest';

import { HolidayDuplicateError } from '../domain/configuration.errors';

import {
  duplicateErrorFrom,
  isRecordNotFound,
} from './configuration-database-errors';

/**
 * The translation table, against the error shapes the PostgreSQL 18 driver
 * adapter actually produces. What the real index REFUSES is proven in
 * `test/integration/configuration-http.spec.ts`; this proves the refusal is
 * recognised for what it is, and that nothing else is mistaken for it.
 *
 * WHY IT MATTERS FOR CF-061 SPECIFICALLY: `holiday_date_scope_unique` covers
 * BOTH scopes with one `NULLS NOT DISTINCT` index, so this one name is the
 * whole mapping. Read it too broadly and an unrelated duplicate elsewhere
 * would answer «ya hay un feriado en esa fecha»; too narrowly and a repeated
 * holiday comes back as a generic 409 the screen cannot explain.
 */

function prismaError(cause: Record<string, unknown>) {
  return {
    code: 'P2010',
    clientVersion: '7.9.1',
    meta: { driverAdapterError: { cause } },
  };
}

describe('la traducción de errores de la base en configuración', () => {
  it('CF-061 reconoce el índice de fecha·alcance cuando llega en `constraint.index`', () => {
    const duplicate = prismaError({
      code: '23505',
      constraint: { index: 'holiday_date_scope_unique' },
    });

    expect(duplicateErrorFrom(duplicate)).toBeInstanceOf(HolidayDuplicateError);
  });

  it('CF-061 lo reconoce también cuando sólo viene en el texto original', () => {
    // Prisma es inconsistente sobre dónde pone el nombre, y de eso depende que
    // el cliente reciba `HOLIDAY_DUPLICATE` o un 409 sin explicación.
    const duplicate = prismaError({
      code: '23505',
      originalMessage:
        'duplicate key value violates unique constraint "holiday_date_scope_unique"',
    });

    expect(duplicateErrorFrom(duplicate)).toBeInstanceOf(HolidayDuplicateError);
  });

  it('CF-061 nombra el campo `date`, que es lo que el formulario tiene que marcar', () => {
    const duplicate = prismaError({
      code: '23505',
      constraint: { index: 'holiday_date_scope_unique' },
    });

    const error = duplicateErrorFrom(duplicate);
    expect(error?.code).toBe('HOLIDAY_DUPLICATE');
    expect(error?.fieldErrors?.[0]?.field).toBe('date');
  });

  it('CF-061 deja pasar el duplicado de OTRO módulo sin tocarlo', () => {
    // Un único de `site` no es asunto de este adaptador: traducirlo aquí haría
    // que un código MSP repetido respondiera «feriado repetido».
    const foreign = prismaError({
      code: '23505',
      constraint: { index: 'site_msp_unicode_key' },
    });

    expect(duplicateErrorFrom(foreign)).toBeUndefined();
  });

  it('CF-065 no confunde un CHECK con un duplicado: son respuestas distintas', () => {
    // Un rango violado es 422 y `PARAM_OUT_OF_RANGE`; leerlo como duplicado lo
    // convertiría en un 409 sobre un feriado que nadie tocó.
    const check = prismaError({
      code: '23514',
      originalMessage:
        'new row for relation "site_parameter" violates check constraint "site_parameter_overbooking_cap_range"',
    });

    expect(duplicateErrorFrom(check)).toBeUndefined();
  });

  it('ignora lo que no es un error de Prisma: un Error corriente sigue su camino', () => {
    expect(duplicateErrorFrom(new Error('boom'))).toBeUndefined();
    expect(duplicateErrorFrom(undefined)).toBeUndefined();
    expect(duplicateErrorFrom(null)).toBeUndefined();
    expect(duplicateErrorFrom({ code: 'nope' })).toBeUndefined();
    expect(duplicateErrorFrom({ code: 'P2002' })).toBeUndefined();
  });

  it('no inventa un duplicado cuando no hay nombre de constraint que leer', () => {
    expect(duplicateErrorFrom(prismaError({ code: '23505' }))).toBeUndefined();
    expect(
      duplicateErrorFrom({
        code: 'P2010',
        clientVersion: '7.9.1',
        meta: {},
      }),
    ).toBeUndefined();
  });

  it('reconoce P2025 como fila ausente, que es un 404 y no un conflicto', () => {
    expect(isRecordNotFound({ code: 'P2025' })).toBe(true);
    expect(isRecordNotFound({ code: 'P2002' })).toBe(false);
    expect(isRecordNotFound(null)).toBe(false);
  });
});
