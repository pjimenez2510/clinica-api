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
  longRestNotice,
  restNoticeThresholdOf,
  backdatingReasonOf,
  restDetailsOf,
  restNoticesOf,
  type RestRequest,
} from './certificate';
import {
  CertificateBackdatingReasonRequiredError,
  CertificateRestPeriodInvalidError,
  CertificateRestTooLongError,
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

/** A rest request with every datum the IESS needs, overridable. */
const aRest = (overrides: Partial<RestRequest> = {}): RestRequest => ({
  restFrom: today,
  restTo: addDays(today, 2),
  contingencyType: 'GENERAL_ILLNESS',
  maternityAdmissionOn: null,
  birthOn: null,
  maternityDischargeOn: null,
  includeDiagnosis: true,
  ...overrides,
});

/** The same request for an attendance certificate: nothing of the rest. */
const NO_REST: RestRequest = {
  restFrom: null,
  restTo: null,
  contingencyType: null,
  maternityAdmissionOn: null,
  birthOn: null,
  maternityDischargeOn: null,
  includeDiagnosis: false,
};

const fieldsOf = (run: () => unknown): string[] =>
  captured(run).fieldErrors?.map((field) => field.field) ?? [];

describe('CER-006 el período de reposo', () => {
  it('CER-006 un reposo lleva inicio y fin, y el fin puede ser el mismo día', () => {
    expect(
      restDetailsOf('MEDICAL_REST', aRest({ restTo: today }))?.period,
    ).toEqual({ from: today, to: today });
    expect(restDetailsOf('MEDICAL_REST', aRest())?.period).toEqual({
      from: today,
      to: addDays(today, 2),
    });
  });

  it('CER-006 un reposo sin fechas se rechaza nombrando los dos campos', () => {
    const error = captured(() =>
      restDetailsOf('MEDICAL_REST', aRest({ restFrom: null, restTo: null })),
    );
    expect(error).toBeInstanceOf(CertificateRestPeriodInvalidError);
    expect(error.fieldErrors?.map((field) => field.field)).toEqual([
      'restFrom',
      'restTo',
    ]);
  });

  it('CER-006 un reposo que termina antes de empezar se rechaza en el fin', () => {
    const error = captured(() =>
      restDetailsOf('MEDICAL_REST', aRest({ restTo: addDays(today, -1) })),
    );
    expect(error.code).toBe('CERTIFICATE_REST_PERIOD_INVALID');
    expect(error.fieldErrors).toEqual([
      expect.objectContaining({ field: 'restTo' }),
    ]);
  });

  it('CER-006 un certificado de asistencia no admite nada del reposo', () => {
    expect(restDetailsOf('ATTENDANCE', NO_REST)).toBeNull();
    expect(
      fieldsOf(() =>
        restDetailsOf('ATTENDANCE', { ...NO_REST, restFrom: today }),
      ),
    ).toEqual(['restFrom']);
  });
});

describe('CER-007 el diagnóstico en el reposo', () => {
  it('CER-007 un reposo que pide no llevar diagnóstico se rechaza en ese campo', () => {
    expect(
      fieldsOf(() =>
        restDetailsOf('MEDICAL_REST', aRest({ includeDiagnosis: false })),
      ),
    ).toEqual(['includeDiagnosis']);
  });

  it('CER-007 el de asistencia admite las dos respuestas del paciente', () => {
    expect(restDetailsOf('ATTENDANCE', NO_REST)).toBeNull();
    expect(
      restDetailsOf('ATTENDANCE', { ...NO_REST, includeDiagnosis: true }),
    ).toBeNull();
  });
});

describe('CER-030 el reposo retroactivo', () => {
  const period = { from: addDays(today, -2), to: today };

  it('CER-030 un reposo que empieza antes del día de la atención exige un motivo de diez caracteres', () => {
    for (const reason of [null, '', 'corto']) {
      expect(() => backdatingReasonOf(period, today, reason)).toThrow(
        CertificateBackdatingReasonRequiredError,
      );
    }
    expect(
      backdatingReasonOf(period, today, '  Acudió tarde por la fiebre  '),
    ).toBe('Acudió tarde por la fiebre');
  });

  it('CER-030 el día de la atención y después no es retroactivo, y no guarda motivo', () => {
    expect(
      backdatingReasonOf({ from: today, to: today }, today, null),
    ).toBeNull();
    expect(
      backdatingReasonOf(
        { from: addDays(today, 1), to: addDays(today, 1) },
        today,
        'Motivo que no hace falta',
      ),
    ).toBeNull();
  });
});

describe('CER-031 el tope de 30 días', () => {
  it('CER-031 admite 30 días, ambos extremos incluidos, y rechaza 31', () => {
    expect(
      restDetailsOf('MEDICAL_REST', aRest({ restTo: addDays(today, 29) }))
        ?.days,
    ).toBe(30);
    expect(() =>
      restDetailsOf('MEDICAL_REST', aRest({ restTo: addDays(today, 30) })),
    ).toThrow(CertificateRestTooLongError);
  });
});

describe('CER-032 el aviso de reposo largo, segun la especialidad del emisor', () => {
  it('CER-032 el umbral es 3 dias para medicina general o sin especialidad, y 7 para cualquier otra', () => {
    expect(restNoticeThresholdOf('medicina-general')).toBe(3);
    expect(restNoticeThresholdOf(null)).toBe(3);
    expect(restNoticeThresholdOf('pediatria')).toBe(7);
  });

  it('CER-032 medicina general avisa a partir de 4 dias, una sola vez', () => {
    expect(restNoticesOf(3, 'medicina-general')).toEqual([]);
    expect(restNoticesOf(4, 'medicina-general')).toEqual([
      'Este reposo es de 4 días. El IESS puede pedir una cita de control o una justificación para validar reposos largos; compruebe que el paciente pueda validarlo.',
    ]);
    expect(restNoticesOf(20, null)).toHaveLength(1);
  });

  it('CER-032 un especialista avisa a partir de 8 dias, con el numero de dias en el texto', () => {
    expect(restNoticesOf(7, 'pediatria')).toEqual([]);
    expect(restNoticesOf(8, 'pediatria')).toEqual([longRestNotice(8)]);
    expect(longRestNotice(8)).toContain('Este reposo es de 8 días.');
    expect(longRestNotice(8)).not.toContain('provisional');
  });
});

describe('CER-034 y CER-035 la contingencia y la maternidad', () => {
  it('CER-034 un reposo sin contingencia se rechaza en ese campo', () => {
    expect(
      fieldsOf(() =>
        restDetailsOf('MEDICAL_REST', aRest({ contingencyType: null })),
      ),
    ).toEqual(['contingencyType']);
  });

  it('CER-034 un certificado de asistencia no admite contingencia', () => {
    expect(
      fieldsOf(() =>
        restDetailsOf('ATTENDANCE', {
          ...NO_REST,
          contingencyType: 'GENERAL_ILLNESS',
        }),
      ),
    ).toEqual(['contingencyType']);
  });

  it('CER-035 la maternidad exige ingreso, parto y alta, nombrando el que falta', () => {
    expect(
      fieldsOf(() =>
        restDetailsOf(
          'MEDICAL_REST',
          aRest({ contingencyType: 'MATERNITY', birthOn: today }),
        ),
      ),
    ).toEqual(['maternityAdmissionOn', 'maternityDischargeOn']);

    // Control positivo: con las tres, pasa y las devuelve.
    expect(
      restDetailsOf(
        'MEDICAL_REST',
        aRest({
          contingencyType: 'MATERNITY',
          maternityAdmissionOn: addDays(today, -3),
          birthOn: addDays(today, -2),
          maternityDischargeOn: today,
        }),
      )?.maternity,
    ).toEqual({
      admissionOn: addDays(today, -3),
      birthOn: addDays(today, -2),
      dischargeOn: today,
    });
  });

  it('CER-035 las fechas de maternidad no se admiten con otra contingencia', () => {
    expect(
      fieldsOf(() => restDetailsOf('MEDICAL_REST', aRest({ birthOn: today }))),
    ).toEqual(['birthOn']);
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

  it('CER-013 avisa que no aplica a afiliados voluntarios, menores de edad, jubilados ni Seguro Social Campesino', () => {
    const { notice } = iessValidationOf(today);
    expect(notice).toBe(IESS_NOT_APPLICABLE_NOTICE);
    expect(notice).toContain('voluntarios');
    expect(notice).toContain('menores de edad');
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
