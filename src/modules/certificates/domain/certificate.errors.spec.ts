import { describe, expect, it } from 'vitest';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type DomainError,
} from '../../../shared/domain/errors/domain-error';
import { DOMAIN_ERROR_CODES } from '../../../shared/domain/errors/error-catalogue';
import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import {
  CertificateAlreadyRevokedError,
  CertificateBackdatingReasonRequiredError,
  CertificateEstablishmentIncompleteError,
  CertificateIssuerReasonRequiredError,
  CertificateMaternityBirthMismatchError,
  CertificateMaternityDiagnosisRequiredError,
  CertificateRestOverlapsError,
  CertificateRevokeForbiddenError,
  CertificateDiagnosisRequiredError,
  CertificateEncounterNotFoundError,
  CertificateEncounterNotOpenError,
  CertificateNotFoundError,
  CertificateRestImplausibleError,
  CertificateRestPeriodInvalidError,
  CertificateTypeNotSupportedError,
  CertifierProfileRequiredError,
} from './certificate.errors';

/**
 * The error contract: a stable code, the CATEGORY that decides the HTTP status
 * in `problem-details.filter.ts` (`NotFoundError` 404, `ConflictError` 409,
 * `ForbiddenError` 403, `ValidationError` 422), and a sentence the user can
 * act on.
 */
const CONTRACT: readonly {
  error: DomainError;
  code: string;
  /** The category: its prototype is what `toBeInstanceOf` checks. */
  category: { prototype: DomainError };
  says: string;
}[] = [
  {
    error: new CertificateRestImplausibleError(['restFrom', 'restTo']),
    code: 'CERTIFICATE_REST_IMPLAUSIBLE',
    category: ValidationError,
    says: 'Compruebe las fechas del reposo',
  },
  {
    error: new CertificateRevokeForbiddenError(),
    code: 'CERTIFICATE_REVOKE_FORBIDDEN',
    category: ForbiddenError,
    says: 'Lo anula quien lo emitió o la dirección médica',
  },
  {
    error: new CertificateIssuerReasonRequiredError(),
    code: 'CERTIFICATE_ISSUER_REASON_REQUIRED',
    category: ValidationError,
    says: 'la registró otro profesional',
  },
  {
    error: new CertificateBackdatingReasonRequiredError('LATE'),
    code: 'CERTIFICATE_BACKDATING_REASON_REQUIRED',
    category: ValidationError,
    says: 'se emite después del día de la atención',
  },
  {
    error: new CertificateEncounterNotFoundError(),
    code: 'CERTIFICATE_ENCOUNTER_NOT_FOUND',
    category: NotFoundError,
    says: 'sedes a las que usted tiene acceso',
  },
  {
    error: new CertificateEncounterNotOpenError('COMPLETED'),
    code: 'CERTIFICATE_ENCOUNTER_NOT_OPEN',
    category: ConflictError,
    says: 'no admite certificados nuevos',
  },
  {
    error: new CertifierProfileRequiredError(),
    code: 'CERTIFIER_PROFILE_REQUIRED',
    category: ForbiddenError,
    says: 'ficha profesional activa',
  },
  {
    error: new CertificateTypeNotSupportedError(),
    code: 'CERTIFICATE_TYPE_NOT_SUPPORTED',
    category: ValidationError,
    says: 'asistencia o de reposo',
  },
  {
    error: new CertificateRestPeriodInvalidError([
      { field: 'restTo', problem: 'ENDS_BEFORE_START' },
    ]),
    code: 'CERTIFICATE_REST_PERIOD_INVALID',
    category: ValidationError,
    says: 'período de reposo',
  },
  {
    error: new CertificateDiagnosisRequiredError(),
    code: 'CERTIFICATE_DIAGNOSIS_REQUIRED',
    category: ValidationError,
    says: 'Registre el diagnóstico',
  },
  {
    error: new CertificateNotFoundError(),
    code: 'CERTIFICATE_NOT_FOUND',
    category: NotFoundError,
    says: 'sedes a las que usted tiene acceso',
  },
  {
    error: new CertificateAlreadyRevokedError(),
    code: 'CERTIFICATE_ALREADY_REVOKED',
    category: ConflictError,
    says: 'ya está anulado',
  },
  {
    error: new CertificateBackdatingReasonRequiredError(),
    code: 'CERTIFICATE_BACKDATING_REASON_REQUIRED',
    category: ValidationError,
    says: 'antes del día de la atención',
  },
  {
    error: new CertificateMaternityBirthMismatchError(
      '2026-03-02' as ClinicalDate, // fecha-fija: sólo se comprueba el formato DD/MM/AAAA
    ),
    code: 'CERTIFICATE_MATERNITY_BIRTH_MISMATCH',
    category: ConflictError,
    says: 'mismo parto',
  },
  {
    error: new CertificateRestOverlapsError(),
    code: 'CERTIFICATE_REST_OVERLAPS',
    category: ConflictError,
    says: 'otro reposo',
  },
  {
    error: new CertificateMaternityDiagnosisRequiredError(),
    code: 'CERTIFICATE_MATERNITY_DIAGNOSIS_REQUIRED',
    category: ValidationError,
    says: 'diagnóstico obstétrico',
  },
  {
    error: new CertificateEstablishmentIncompleteError(),
    code: 'CERTIFICATE_ESTABLISHMENT_INCOMPLETE',
    category: ValidationError,
    says: 'parroquia',
  },
];

describe('el contrato de errores del certificado', () => {
  for (const { error, code, category, says } of CONTRACT) {
    it(`CER-014 ${code} lleva su codigo, su estado y una frase que dice que hacer`, () => {
      expect(error.code).toBe(code);
      expect(DOMAIN_ERROR_CODES).toContain(code);
      expect(error).toBeInstanceOf(category);
      expect(error.userTitle).toContain(says);
    });
  }

  it('CER-014 ningun mensaje lleva nombre, documento ni codigo CIE-10', () => {
    // Estas frases llegan a un log y a una captura de soporte. No reciben
    // ningún dato del paciente como parámetro, y esto lo comprueba sobre el
    // texto que de verdad sale: ni una cifra larga (un documento), ni un
    // código con forma CIE-10 (letra y dos cifras).
    for (const { error } of CONTRACT) {
      const sentences = [
        error.message,
        error.userTitle ?? '',
        ...(error.fieldErrors ?? []).map((field) => field.message),
        ...Object.values(error.params).map(String),
      ].join(' ');
      expect(sentences, error.code).not.toMatch(/\d{6,}/);
      expect(sentences, error.code).not.toMatch(/\b[A-TV-Z]\d{2}(\.\d+)?\b/);
    }
  });

  it('CER-006 el periodo invalido señala cada campo con su motivo', () => {
    const error = new CertificateRestPeriodInvalidError([
      { field: 'restFrom', problem: 'MISSING' },
      { field: 'restTo', problem: 'MISSING' },
    ]);
    expect(error.fieldErrors?.map((field) => field.field)).toEqual([
      'restFrom',
      'restTo',
    ]);
    expect(error.fieldErrors?.[0]?.message).toContain('inicio');
    expect(error.fieldErrors?.[1]?.message).toContain('fin');

    const attendance = new CertificateRestPeriodInvalidError([
      { field: 'restFrom', problem: 'NOT_ALLOWED' },
    ]);
    expect(attendance.fieldErrors?.[0]?.message).toContain('asistencia');
  });

  it('CER-056 el reposo absurdo señala cada fecha con su frase: 422 por campo', () => {
    const error = new CertificateRestImplausibleError(['restTo']);
    expect(error.code).toBe('CERTIFICATE_REST_IMPLAUSIBLE');
    expect(error).toBeInstanceOf(ValidationError); // 422
    expect(error.userTitle).toBe(
      'Compruebe las fechas del reposo: parecen mal escritas',
    );
    expect(error.fieldErrors).toEqual([
      {
        field: 'restTo',
        code: 'CERTIFICATE_REST_IMPLAUSIBLE',
        message:
          'Un reposo no puede pasar de 365 días: compruebe la fecha de fin',
      },
    ]);
    expect(
      new CertificateRestImplausibleError(['restFrom']).fieldErrors[0]?.message,
    ).toBe(
      'El reposo no puede empezar a más de un año de la atención: compruebe la fecha de inicio',
    );
  });

  it('CER-008 el diagnostico que falta señala la casilla de incluirlo', () => {
    const error = new CertificateDiagnosisRequiredError();
    expect(error.fieldErrors?.[0]?.field).toBe('includeDiagnosis');
  });

  it('CER-030 señala el campo que hay que corregir', () => {
    expect(
      new CertificateBackdatingReasonRequiredError().fieldErrors?.[0]?.field,
    ).toBe('backdatingReason');
  });

  it('CER-055 los límites que pasan a aviso ya no tienen código de error en el catálogo (D-128.7)', () => {
    for (const code of [
      'CERTIFICATE_REST_START_TOO_EARLY',
      'CERTIFICATE_REST_ISSUED_TOO_LATE',
      'CERTIFICATE_REST_START_TOO_LATE',
      'CERTIFICATE_REST_TOO_LONG',
      'CERTIFICATE_MATERNITY_DATES_TOO_OLD',
      'CERTIFICATE_MATERNITY_ADMISSION_TOO_EARLY',
      'CERTIFICATE_MATERNITY_BIRTH_TOO_FAR',
      'CERTIFICATE_MATERNITY_LEAVE_EXCEEDED',
    ]) {
      expect(DOMAIN_ERROR_CODES, code).not.toContain(code);
    }
    // Control positivo: los que se quedan como rechazo siguen.
    for (const code of [
      'CERTIFICATE_REST_OVERLAPS',
      'CERTIFICATE_MATERNITY_BIRTH_MISMATCH',
      'CERTIFICATE_MATERNITY_DIAGNOSIS_REQUIRED',
      'CERTIFICATE_BACKDATING_REASON_REQUIRED',
    ]) {
      expect(DOMAIN_ERROR_CODES, code).toContain(code);
    }
  });

  it('CER-005 el tipo no admitido señala el campo del tipo', () => {
    expect(new CertificateTypeNotSupportedError().fieldErrors?.[0]?.field).toBe(
      'type',
    );
  });
});
