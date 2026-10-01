import { describe, expect, it } from 'vitest';

import {
  addDays,
  clinicalDateOf,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';

import {
  admitsNewCertificates,
  assertIssuableType,
  iessValidationOf,
  IESS_NOT_APPLICABLE_NOTICE,
  restPeriodOf,
} from './certificate';
import {
  CertificateRestPeriodInvalidError,
  CertificateTypeNotSupportedError,
} from './certificate.errors';

/**
 * The rules of the certificate that need no storage: which types are a form
 * 117, what a rest period has to be, which attentions admit one, and what the
 * IESS answer carries.
 *
 * Every date here is derived from one instant taken at the start of the run,
 * never written by hand.
 */
const today: ClinicalDate = clinicalDateOf(new Date());

describe('CER-005 sólo asistencia y reposo son un formulario 117', () => {
  it('CER-005 admite ATTENDANCE y MEDICAL_REST', () => {
    expect(() => assertIssuableType('ATTENDANCE')).not.toThrow();
    expect(() => assertIssuableType('MEDICAL_REST')).not.toThrow();
  });

  it('CER-005 rechaza FITNESS y DISABILITY_SUPPORT con CERTIFICATE_TYPE_NOT_SUPPORTED', () => {
    for (const type of ['FITNESS', 'DISABILITY_SUPPORT'] as const) {
      expect(() => assertIssuableType(type)).toThrow(
        CertificateTypeNotSupportedError,
      );
    }
  });
});

describe('CER-006 el período de reposo', () => {
  it('CER-006 un reposo lleva inicio y fin, y el fin puede ser el mismo día', () => {
    expect(restPeriodOf('MEDICAL_REST', today, today)).toEqual({
      from: today,
      to: today,
    });
    expect(restPeriodOf('MEDICAL_REST', today, addDays(today, 2))).toEqual({
      from: today,
      to: addDays(today, 2),
    });
  });

  it('CER-006 un reposo sin fechas se rechaza nombrando los dos campos', () => {
    const error = captured(() => restPeriodOf('MEDICAL_REST', null, null));
    expect(error).toBeInstanceOf(CertificateRestPeriodInvalidError);
    expect(error.fieldErrors?.map((field) => field.field)).toEqual([
      'restFrom',
      'restTo',
    ]);
  });

  it('CER-006 un reposo que termina antes de empezar se rechaza en el fin', () => {
    const error = captured(() =>
      restPeriodOf('MEDICAL_REST', today, addDays(today, -1)),
    );
    expect(error.code).toBe('CERTIFICATE_REST_PERIOD_INVALID');
    expect(error.fieldErrors).toEqual([
      expect.objectContaining({ field: 'restTo' }),
    ]);
  });

  it('CER-006 un certificado de asistencia no admite período', () => {
    expect(restPeriodOf('ATTENDANCE', null, null)).toBeNull();

    const error = captured(() => restPeriodOf('ATTENDANCE', today, null));
    expect(error).toBeInstanceOf(CertificateRestPeriodInvalidError);
    expect(error.fieldErrors?.[0]?.field).toBe('restFrom');
  });

  it('CER-006 NO rechaza un reposo retroactivo ni uno de más de 30 días (D-075 abierta)', () => {
    // Las dos son política clínica y legal pendiente de decisión: hoy no se
    // rechazan, y esta prueba falla el día que alguien las rechace sin que
    // D-075 se haya decidido.
    expect(
      restPeriodOf('MEDICAL_REST', addDays(today, -10), addDays(today, 40)),
    ).not.toBeNull();
  });
});

describe('CER-003 qué atenciones admiten un certificado', () => {
  it('CER-003 OPEN, ON_HOLD y DISCHARGED lo admiten', () => {
    expect(admitsNewCertificates('OPEN')).toBe(true);
    expect(admitsNewCertificates('ON_HOLD')).toBe(true);
    expect(admitsNewCertificates('DISCHARGED')).toBe(true);
  });

  it('CER-003 COMPLETED, DISCONTINUED y ENTERED_IN_ERROR no', () => {
    expect(admitsNewCertificates('COMPLETED')).toBe(false);
    expect(admitsNewCertificates('DISCONTINUED')).toBe(false);
    expect(admitsNewCertificates('ENTERED_IN_ERROR')).toBe(false);
  });
});

describe('CER-013 lo que el IESS necesita saber de un reposo', () => {
  it('CER-013 el último día para validarlo es ocho días después del fin del reposo', () => {
    const restTo = addDays(today, 3);
    expect(iessValidationOf(restTo).lastValidationDay).toBe(addDays(restTo, 8));
  });

  it('CER-013 cruza el fin de mes y de año sobre el calendario, sin huso', () => {
    // El 31 de diciembre de cualquier año, derivado y no escrito: el reposo
    // que termina ahí se valida hasta el 8 de enero siguiente.
    const year = Number(today.slice(0, 4));
    const newYear = addDays(`${year + 1}-01-01` as ClinicalDate, 0);
    const lastDayOfYear = addDays(newYear, -1);
    expect(iessValidationOf(lastDayOfYear).lastValidationDay).toBe(
      addDays(newYear, 7),
    );
  });

  it('CER-013 avisa que no aplica a afiliados voluntarios, jubilados ni Seguro Social Campesino', () => {
    const { notice } = iessValidationOf(today);
    expect(notice).toBe(IESS_NOT_APPLICABLE_NOTICE);
    expect(notice).toContain('voluntarios');
    expect(notice).toContain('jubilados');
    expect(notice).toContain('Seguro Social Campesino');
  });
});

/** Runs a function that must throw, and hands back what it threw. */
function captured(run: () => unknown): CertificateRestPeriodInvalidError {
  try {
    run();
  } catch (error) {
    return error as CertificateRestPeriodInvalidError;
  }
  throw new Error('expected a refusal and nothing was thrown');
}
