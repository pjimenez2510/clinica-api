import { describe, expect, it } from 'vitest';

import {
  BusinessRuleViolation,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';
import { DOMAIN_ERROR_CODES } from '../../../shared/domain/errors/error-catalogue';

import {
  AcessExpiredError,
  AcessMissingError,
  InactiveSpecialtyAssignmentError,
  InvalidScheduleRuleError,
  PractitionerInUseError,
  PractitionerNotFoundError,
  PractitionerNotInSiteError,
  PractitionerNotSchedulableError,
  PrimarySpecialtyRequiredError,
  ScheduleRuleNotFoundError,
} from './staff.errors';

/**
 * The error contract of the staff module: stable code, category (the category
 * IS the HTTP status), and a user sentence with nothing sensitive in it. The
 * SPEC fixes the public codes in its error table.
 */
describe('los errores del módulo staff', () => {
  it('ST-004 responde ACESS_EXPIRED nombrando la fecha de caducidad', () => {
    const error = new AcessExpiredError('2026-08-12');

    // 422 and not 403: the person is who they say they are, their paperwork
    // is out of date.
    expect(error).toBeInstanceOf(BusinessRuleViolation);
    expect(error.code).toBe('ACESS_EXPIRED');
    // The requirement says to name the date, and «renew it» with no date is
    // advice nobody can act on.
    expect(error.userTitle).toContain('2026-08-12');
    expect(error.fieldErrors?.[0]?.field).toBe('acessExpiresOn');
  });

  it('ST-002 distingue ACESS_MISSING de ACESS_EXPIRED: son arreglos distintos', () => {
    // Typing the registration in versus renewing it at the ACESS. One code for
    // both would force the client to read Spanish prose to tell which.
    const error = new AcessMissingError();

    expect(error).toBeInstanceOf(BusinessRuleViolation);
    expect(error.code).toBe('ACESS_MISSING');
    expect(error.code).not.toBe(new AcessExpiredError('2026-01-01').code);
  });

  it('ST-010 responde PRACTITIONER_IN_USE como conflicto y ofrece desactivar', () => {
    const error = new PractitionerInUseError();

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe('PRACTITIONER_IN_USE');
    expect(error.userTitle).toContain('esactív');
  });

  it('ST-007 responde PRACTITIONER_NOT_IN_SITE señalando la sede, no negando acceso', () => {
    // 422 and not 403: the data sent is incoherent, and «access denied» would
    // say something about the site to somebody who is not being denied.
    const error = new PractitionerNotInSiteError();

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('PRACTITIONER_NOT_IN_SITE');
    expect(error.fieldErrors?.[0]?.field).toBe('siteId');
  });

  it('ST-006 responde PRACTITIONER_NOT_SCHEDULABLE como regla de negocio', () => {
    const error = new PractitionerNotSchedulableError();

    expect(error).toBeInstanceOf(BusinessRuleViolation);
    expect(error.code).toBe('PRACTITIONER_NOT_SCHEDULABLE');
  });

  it('ST-008 responde PRIMARY_SPECIALTY_REQUIRED distinguiendo ninguna de varias', () => {
    const none = new PrimarySpecialtyRequiredError(0);
    const two = new PrimarySpecialtyRequiredError(2);

    expect(none).toBeInstanceOf(ValidationError);
    expect(none.code).toBe('PRIMARY_SPECIALTY_REQUIRED');
    expect(none.fieldErrors?.[0]?.message).toContain('Ninguna');
    expect(two.fieldErrors?.[0]?.message).toContain('más de una');
    expect(two.params.primaryCount).toBe(2);
  });

  it('ST-008 responde SPECIALTY_INACTIVE como regla de negocio, no como 404', () => {
    // The specialty EXISTS — answering not-found would send the admin hunting
    // a ghost. What is wrong is the state, and the fix is reactivating it.
    const error = new InactiveSpecialtyAssignmentError();

    expect(error).toBeInstanceOf(BusinessRuleViolation);
    expect(error.code).toBe('SPECIALTY_INACTIVE');
  });

  it('ST-045 responde INVALID_SCHEDULE_RULE con un error por cada campo que falla', () => {
    const error = new InvalidScheduleRuleError([
      { field: 'endTime', message: 'La hora de fin debe ser posterior' },
      { field: 'slotMinutes', message: 'Los turnos no caben' },
    ]);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.fieldErrors?.map((problem) => problem.field)).toEqual([
      'endTime',
      'slotMinutes',
    ]);
  });

  it('ST-010/ST-040 los que no existen responden 404 sin decir si existieron', () => {
    for (const error of [
      new PractitionerNotFoundError(),
      new ScheduleRuleNotFoundError(),
    ]) {
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error.message).not.toMatch(/existed|deleted/i);
    }
  });

  it('ST-001 registra cada código de este módulo en el catálogo público congelado', () => {
    for (const code of [
      'ACESS_EXPIRED',
      'ACESS_MISSING',
      'INVALID_SCHEDULE_RULE',
      'PRACTITIONER_IN_USE',
      'PRACTITIONER_NOT_FOUND',
      'PRACTITIONER_NOT_IN_SITE',
      'PRACTITIONER_NOT_SCHEDULABLE',
      'PRIMARY_SPECIALTY_REQUIRED',
      'SCHEDULE_RULE_NOT_FOUND',
      'SPECIALTY_INACTIVE',
    ] as const) {
      expect(DOMAIN_ERROR_CODES).toContain(code);
    }
  });

  it('ST-042 NO tiene clase de error: la garantía es la base, no el servicio', () => {
    // `SCHEDULE_RULE_OVERLAP` is produced by the EXCLUDE constraint and
    // registered in `staff.constraints.ts`. A class here would suggest the
    // service can decide it — and it cannot: two administrators editing the
    // same Monday both read «no overlap».
    expect(DOMAIN_ERROR_CODES).not.toContain('SCHEDULE_RULE_OVERLAP');
  });
});
