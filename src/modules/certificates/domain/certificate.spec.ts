import { describe, expect, it } from 'vitest';

import {
  addDays,
  addMonths,
  atWallClock,
  WallClockTime,
  clinicalDateOf,
  clinicalDaySpan,
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
  assertMaternityCoherent,
  assertRestDoesNotOverlapMaternity,
  assertRestPlausible,
  isObstetricCie10,
  lateIssueDayOf,
  issuerReasonOf,
  latestRestStartOf,
  MATERNITY_CHAIN_NOTICE,
  restDetailsOf,
  missingPatientWork,
  patientWorkNotice,
  restNoticesOf,
  restLimitNoticesOf,
  REST_LIMIT_NOTICE,
  type MaternityDates,
  type RestRequest,
} from './certificate';
import {
  CertificateBackdatingReasonRequiredError,
  CertificateIssuerReasonRequiredError,
  CertificateMaternityBirthMismatchError,
  CertificateMaternityDiagnosisRequiredError,
  CertificateRestOverlapsError,
  CertificateRestImplausibleError,
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

describe('CER-030 el reposo retroactivo o emitido tarde', () => {
  const period = { from: addDays(today, -2), to: today };

  it('CER-030 un reposo que empieza antes del día de la atención exige un motivo de diez caracteres', () => {
    for (const reason of [null, '', 'corto']) {
      expect(() => backdatingReasonOf(period, today, today, reason)).toThrow(
        CertificateBackdatingReasonRequiredError,
      );
    }
    expect(
      backdatingReasonOf(
        period,
        today,
        today,
        '  Acudió tarde por la fiebre  ',
      ),
    ).toBe('Acudió tarde por la fiebre');
  });

  it('CER-030 emitido el día de la atención, desde ese día o después, no guarda motivo', () => {
    expect(
      backdatingReasonOf({ from: today, to: today }, today, today, null),
    ).toBeNull();
    expect(
      backdatingReasonOf(
        { from: addDays(today, 1), to: addDays(today, 1) },
        today,
        today,
        'Motivo que no hace falta',
      ),
    ).toBeNull();
  });

  it('CER-030 emitido un día posterior al de la atención pide motivo aunque empiece ese día (D-105 §3)', () => {
    const attention = addDays(today, -10);
    const fromAttention = { from: attention, to: addDays(attention, 2) };

    let refusal: unknown;
    try {
      backdatingReasonOf(fromAttention, attention, today, null);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(CertificateBackdatingReasonRequiredError);
    expect(
      (refusal as CertificateBackdatingReasonRequiredError).userTitle,
    ).toContain('se emite después del día de la atención');
    expect(
      backdatingReasonOf(
        fromAttention,
        attention,
        today,
        'Volvió por el papel diez días después',
      ),
    ).toBe('Volvió por el papel diez días después');
  });
});

/** A rest checked for its limits, on today's attention, issued today. */
const limitsOf = (
  period: { from: ClinicalDate; to: ClinicalDate },
  {
    attentionDate = today,
    issueDate = today,
    lateIssueDay,
    maternity = null,
  }: {
    attentionDate?: ClinicalDate;
    issueDate?: ClinicalDate;
    lateIssueDay?: ClinicalDate;
    maternity?: MaternityDates | null;
  } = {},
) =>
  restLimitNoticesOf(
    { period, days: clinicalDaySpan(period.from, period.to), maternity },
    { attentionDate, issueDate, lateIssueDay: lateIssueDay ?? issueDate },
  );
const label = (day: ClinicalDate) => day.split('-').reverse().join('/');

describe('CER-055 los límites del reposo avisan y no frenan (D-128.7)', () => {
  it('CER-055 un reposo normal no lleva ningún aviso de límite (control positivo)', () => {
    expect(limitsOf({ from: today, to: addDays(today, 2) })).toEqual([]);
    expect(
      limitsOf({ from: addDays(today, -3), to: addDays(today, 26) }),
    ).toEqual([]);
  });

  it('CER-055 CER-041 desde hoy o desde mañana no avisa; desde pasado mañana avisa con la fecha habitual', () => {
    const tomorrow = addDays(today, 1);
    expect(latestRestStartOf(today)).toBe(tomorrow);
    expect(limitsOf({ from: tomorrow, to: tomorrow })).toEqual([]);
    expect(
      limitsOf({ from: addDays(today, 90), to: addDays(today, 91) }),
    ).toEqual([REST_LIMIT_NOTICE.startsAfterTomorrow(tomorrow)]);
    expect(REST_LIMIT_NOTICE.startsAfterTomorrow(tomorrow)).toContain(
      label(tomorrow),
    );
  });
});

/** CER-056. What the sanity limits refuse, field by field, or nothing. */
const implausibleFields = (
  period: { from: ClinicalDate; to: ClinicalDate },
  attentionDate: ClinicalDate = today,
): string[] => {
  try {
    assertRestPlausible(period, attentionDate);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(CertificateRestImplausibleError);
    return (error as CertificateRestImplausibleError).fieldErrors.map(
      (field) => field.field,
    );
  }
};

describe('CER-056 lo absurdo del reposo se rechaza; lo largo sigue avisando (D-133.3)', () => {
  it('CER-056 365 días se emiten (con el aviso de CER-055); 366 se rechazan en la fecha de fin', () => {
    const year = { from: today, to: addDays(today, 364) };
    expect(clinicalDaySpan(year.from, year.to)).toBe(365);
    expect(implausibleFields(year)).toEqual([]);
    expect(limitsOf(year)).toEqual([REST_LIMIT_NOTICE.tooLong(365)]);

    expect(implausibleFields({ from: today, to: addDays(today, 365) })).toEqual(
      ['restTo'],
    );
    // A typo of 3 000 days, the case of D-133.3.
    expect(
      implausibleFields({ from: today, to: addDays(today, 2999) }),
    ).toEqual(['restTo']);
  });

  it('CER-056 el inicio a un año justo de la atención, antes o después, se emite; un día más allá se rechaza en la fecha de inicio', () => {
    const before = addMonths(today, -12);
    const after = addMonths(today, 12);
    expect(implausibleFields({ from: before, to: addDays(before, 1) })).toEqual(
      [],
    );
    expect(implausibleFields({ from: after, to: addDays(after, 1) })).toEqual(
      [],
    );

    const tooEarly = addDays(before, -1);
    const tooLate = addDays(after, 1);
    expect(
      implausibleFields({ from: tooEarly, to: addDays(tooEarly, 1) }),
    ).toEqual(['restFrom']);
    expect(
      implausibleFields({ from: tooLate, to: addDays(tooLate, 1) }),
    ).toEqual(['restFrom']);
  });

  it('CER-056 el año se cuenta en el calendario, como la base: desde un 29 de febrero, el 28 del año siguiente', () => {
    const leapDay = '2028-02-29' as ClinicalDate; // fecha-fija: bisiesto
    expect(
      implausibleFields({ from: '2029-02-28' as ClinicalDate, to: '2029-02-28' as ClinicalDate }, leapDay), // fecha-fija: bisiesto
    ).toEqual([]); // prettier-ignore
    expect(
      implausibleFields({ from: '2029-03-01' as ClinicalDate, to: '2029-03-01' as ClinicalDate }, leapDay), // fecha-fija: bisiesto
    ).toEqual(['restFrom']); // prettier-ignore
  });

  it('CER-056 las dos cosas a la vez se dicen las dos, cada una en su campo y con su frase', () => {
    const far = addDays(addMonths(today, 12), 10);
    const error = (() => {
      try {
        assertRestPlausible({ from: far, to: addDays(far, 400) }, today);
      } catch (thrown) {
        return thrown as CertificateRestImplausibleError;
      }
      throw new Error('expected a refusal');
    })();

    expect(error.fieldErrors).toEqual([
      {
        field: 'restFrom',
        code: 'CERTIFICATE_REST_IMPLAUSIBLE',
        message:
          'El reposo no puede empezar a más de un año de la atención: compruebe la fecha de inicio',
      },
      {
        field: 'restTo',
        code: 'CERTIFICATE_REST_IMPLAUSIBLE',
        message:
          'Un reposo no puede pasar de 365 días: compruebe la fecha de fin',
      },
    ]);
  });
});

describe('CER-039 el 117 lo emite el profesional de la atención', () => {
  it('CER-039 quien atendió no deja motivo, aunque la petición lo traiga', () => {
    expect(issuerReasonOf('p-1', 'p-1', null)).toBeNull();
    expect(issuerReasonOf('p-1', 'p-1', 'Un motivo que sobra')).toBeNull();
  });

  it('CER-039 un tercero sin motivo de diez caracteres se rechaza en issuedByOtherReason', () => {
    for (const reason of [null, '', '  corto  ']) {
      expect(() => issuerReasonOf('p-2', 'p-1', reason)).toThrow(
        CertificateIssuerReasonRequiredError,
      );
    }
    expect(
      new CertificateIssuerReasonRequiredError().fieldErrors[0]?.field,
    ).toBe('issuedByOtherReason');
    expect(
      issuerReasonOf('p-2', 'p-1', '  Cubre el turno de la doctora  '),
    ).toBe('Cubre el turno de la doctora');
  });
});

describe('CER-031 el tope de 30 días', () => {
  it('CER-031 CER-055 un reposo de 31 días ya no se rechaza: avisa, y 30 no', () => {
    expect(
      restDetailsOf('MEDICAL_REST', aRest({ restTo: addDays(today, 29) }))
        ?.days,
    ).toBe(30);
    expect(
      restDetailsOf('MEDICAL_REST', aRest({ restTo: addDays(today, 30) }))
        ?.days,
    ).toBe(31);
    expect(limitsOf({ from: today, to: addDays(today, 29) })).toEqual([]);
    expect(limitsOf({ from: today, to: addDays(today, 34) })).toEqual([
      REST_LIMIT_NOTICE.tooLong(35),
    ]);
    expect(REST_LIMIT_NOTICE.tooLong(35)).toContain('1 a 30 días');
  });
});

describe('CER-032 el aviso de reposo largo, segun la especialidad del emisor', () => {
  it('CER-032 el umbral es 3 dias para medicina general o sin especialidad, y 7 para cualquier otra', () => {
    expect(restNoticeThresholdOf('medicina-general')).toBe(3);
    expect(restNoticeThresholdOf(null)).toBe(3);
    expect(restNoticeThresholdOf('pediatria')).toBe(7);
  });

  it('CER-032 medicina general avisa a partir de 4 dias, una sola vez', () => {
    expect(restNoticesOf(3, 'medicina-general', 'GENERAL_ILLNESS')).toEqual([]);
    expect(restNoticesOf(4, 'medicina-general', 'GENERAL_ILLNESS')).toEqual([
      'Este reposo es de 4 días. El IESS puede pedir una cita de control o una justificación para validar reposos largos; compruebe que el paciente pueda validarlo.',
    ]);
    expect(restNoticesOf(20, null, 'GENERAL_ILLNESS')).toHaveLength(1);
  });

  it('CER-032 un especialista avisa a partir de 8 dias, con el numero de dias en el texto', () => {
    expect(restNoticesOf(7, 'pediatria', 'GENERAL_ILLNESS')).toEqual([]);
    expect(restNoticesOf(8, 'pediatria', 'GENERAL_ILLNESS')).toEqual([
      longRestNotice(8),
    ]);
    expect(longRestNotice(8)).toContain('Este reposo es de 8 días.');
    expect(longRestNotice(8)).not.toContain('provisional');
  });
});

describe('CER-043 el aviso de encadenar maternidad', () => {
  it('CER-043 todo reposo de maternidad lleva el aviso de confirmar con el IESS, y ningún otro lo lleva', () => {
    expect(restNoticesOf(2, 'medicina-general', 'MATERNITY')).toEqual([
      MATERNITY_CHAIN_NOTICE,
    ]);
    expect(restNoticesOf(30, 'medicina-general', 'MATERNITY')).toEqual([
      longRestNotice(30),
      MATERNITY_CHAIN_NOTICE,
    ]);
    expect(restNoticesOf(2, 'medicina-general', 'WORK_ACCIDENT')).toEqual([]);
    expect(MATERNITY_CHAIN_NOTICE).toContain('confirme con el IESS');
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

describe('CER-038 los datos laborales que faltan no impiden el reposo: se avisan', () => {
  const complete = {
    employerName: 'Florícola del Valle',
    jobTitle: 'Supervisora',
    residenceAddressLine: 'Calle Sucre 4-12',
    phone: '0991234567',
  };

  it('CER-038 un dato en blanco cuenta como que falta', () => {
    expect(missingPatientWork(complete)).toEqual([]);
    expect(
      missingPatientWork({ ...complete, jobTitle: '   ', phone: null }),
    ).toEqual(['jobTitle', 'phone']);
  });

  it('CER-038 el aviso nombra lo que falta y dice lo que puede costar, sin valores del paciente', () => {
    expect(patientWorkNotice([])).toBeNull();
    expect(patientWorkNotice(['phone'])).toBe(
      'Falta en la ficha el teléfono del paciente. El IESS puede devolver el reposo sin estos datos; complételos en la ficha.',
    );
    expect(
      patientWorkNotice(['employerName', 'jobTitle', 'residenceAddressLine']),
    ).toContain('la empresa, el puesto de trabajo y el domicilio');
  });
});

describe('CER-035 las fechas de maternidad van en orden', () => {
  it('CER-035 un parto antes del ingreso y un alta antes del parto se nombran por su campo', () => {
    const day = today;
    const request = (admission: number, birth: number, discharge: number) => ({
      restFrom: day,
      restTo: addDays(day, 5),
      contingencyType: 'MATERNITY' as const,
      maternityAdmissionOn: addDays(day, admission),
      birthOn: addDays(day, birth),
      maternityDischargeOn: addDays(day, discharge),
      includeDiagnosis: true,
    });

    // Control positivo: ingreso, parto y alta en orden.
    expect(
      restDetailsOf('MEDICAL_REST', request(0, 1, 3))?.maternity,
    ).not.toBeNull();

    expect(() => restDetailsOf('MEDICAL_REST', request(2, 1, 0))).toThrow(
      expect.objectContaining({
        fieldErrors: [
          expect.objectContaining({
            field: 'birthOn',
            message: 'El parto no puede ser antes del ingreso',
          }),
          expect.objectContaining({
            field: 'maternityDischargeOn',
            message: 'El alta no puede ser antes del parto',
          }),
        ],
      }),
    );
  });
});

describe('D-106 la ventana del reposo alrededor de la atención', () => {
  it('CER-030 la madrugada, hasta las 06:00 de Ecuador, cuenta como el día anterior (D-106 §5)', () => {
    const next = addDays(today, 1);
    expect(lateIssueDayOf(atWallClock(next, WallClockTime.of(5, 59)))).toBe(
      today,
    );
    expect(lateIssueDayOf(atWallClock(next, WallClockTime.of(6, 0)))).toBe(
      next,
    );
  });

  it('CER-044 CER-055 tres días antes de la atención no avisa; cuatro avisa con la primera fecha habitual', () => {
    expect(limitsOf({ from: addDays(today, -3), to: today })).toEqual([]);
    expect(limitsOf({ from: addDays(today, -4), to: today })).toEqual([
      REST_LIMIT_NOTICE.startsTooEarly(addDays(today, -3), false),
    ]);
    expect(
      REST_LIMIT_NOTICE.startsTooEarly(addDays(today, -3), false),
    ).toContain(label(addDays(today, -3)));
  });

  it('CER-045 CER-055 emitido el octavo día no avisa; el noveno avisa, con la madrugada contada', () => {
    const eighth = addDays(today, 8);
    const ninth = addDays(today, 9);
    expect(
      limitsOf({ from: eighth, to: eighth }, { issueDate: eighth }),
    ).toEqual([]);
    expect(limitsOf({ from: ninth, to: ninth }, { issueDate: ninth })).toEqual([
      REST_LIMIT_NOTICE.issuedTooLate,
    ]);
    // De madrugada del noveno día aún es el octavo (D-108 §2).
    expect(
      limitsOf(
        { from: ninth, to: ninth },
        { issueDate: ninth, lateIssueDay: eighth },
      ),
    ).toEqual([]);
  });

  it('CER-045 CER-055 el aviso da el plazo del IESS tal como es: hasta 8 días después de terminar el reposo, no de la atención', () => {
    // ESPECIFICACION §1.5: «hasta 8 días después de terminado el reposo».
    expect(REST_LIMIT_NOTICE.issuedTooLate).toBe(
      'Han pasado más de ocho días desde la atención: lo habitual es emitir el reposo desde una atención nueva. El IESS lo valida hasta 8 días después de terminar el reposo.',
    );
  });
});

describe('D-108 en el reposo de maternidad no rigen los topes de D-106', () => {
  /** Ingresó dos días antes del parto y salió dos días después. */
  const maternityFrom = (birth: ClinicalDate): MaternityDates => ({
    admissionOn: addDays(birth, -2),
    birthOn: birth,
    dischargeOn: addDays(birth, 2),
  });

  it('CER-044 CER-055 la maternidad desde el día del parto o del ingreso no avisa; la enfermedad general con esa fecha, sí', () => {
    const birth = addDays(today, -5);
    const maternity = maternityFrom(birth);
    expect(limitsOf({ from: birth, to: today }, { maternity })).toEqual([]);
    expect(
      limitsOf({ from: maternity.admissionOn, to: today }, { maternity }),
    ).toEqual([]);
    expect(limitsOf({ from: birth, to: today })).toEqual([
      REST_LIMIT_NOTICE.startsTooEarly(addDays(today, -3), false),
    ]);
  });

  it('CER-044 CER-055 un día que no es ni el ingreso ni el parto avisa, nombrando los dos', () => {
    const maternity = maternityFrom(addDays(today, -5));
    const from = addDays(maternity.admissionOn, 1);
    expect(limitsOf({ from, to: today }, { maternity })).toEqual([
      REST_LIMIT_NOTICE.startsTooEarly(addDays(today, -3), true),
    ]);
    expect(
      REST_LIMIT_NOTICE.startsTooEarly(addDays(today, -3), true),
    ).toContain('ingreso o del parto');
  });

  it('CER-045 CER-055 un reposo de maternidad emitido pasados 8 días no avisa por eso; el general, sí', () => {
    const issueDate = addDays(today, 9);
    const period = { from: issueDate, to: addDays(issueDate, 29) };
    const maternity = maternityFrom(addDays(today, -1));
    expect(limitsOf(period, { issueDate, maternity })).toEqual([]);
    expect(limitsOf(period, { issueDate })).toEqual([
      REST_LIMIT_NOTICE.issuedTooLate,
    ]);
  });
});

describe('D-109 y D-110 lo que acota el reposo de maternidad', () => {
  const OBSTETRIC = ['J02', 'O80'];
  /** Ingresó la víspera del parto y salió dos días después. */
  const maternityFrom = (birth: ClinicalDate): MaternityDates => ({
    admissionOn: addDays(birth, -1),
    birthOn: birth,
    dischargeOn: addDays(birth, 2),
  });
  type Other = { from: ClinicalDate; to: ClinicalDate; maternityBirthOn: ClinicalDate | null }; // prettier-ignore
  /** What still refuses a maternity rest (CER-048 to CER-050). */
  const check =
    (
      period: { from: ClinicalDate; to: ClinicalDate },
      birth: ClinicalDate,
      {
        codes = OBSTETRIC,
        others = [] as Other[],
        maternity = maternityFrom(birth),
      } = {},
    ) =>
    () =>
      assertMaternityCoherent(period, maternity, codes, others);
  /** The notices of a maternity rest on today's attention. */
  const noticesOf = (
    period: { from: ClinicalDate; to: ClinicalDate },
    maternity: MaternityDates,
    lateIssueDay: ClinicalDate = today,
  ) => limitsOf(period, { maternity, issueDate: lateIssueDay, lateIssueDay });
  const refusalOf = (run: () => void): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it('CER-046 CER-055 un parto de hace 83 días no avisa; de hace 85, avisa y se emite', () => {
    const day = { from: today, to: today };
    expect(noticesOf(day, maternityFrom(addDays(today, -83)))).toEqual([]);
    expect(noticesOf(day, maternityFrom(addDays(today, -85)))).toEqual([
      REST_LIMIT_NOTICE.birthTooOld,
      REST_LIMIT_NOTICE.leaveExceeded(addDays(today, -2)),
    ]);
    expect(check(day, addDays(today, -85))).not.toThrow();
  });

  it('CER-046 CER-055 el ingreso no cuenta: el último tramo de una licencia con ingreso antiguo no avisa (D-110 §3)', () => {
    const birth = addDays(today, -80);
    const maternity = { admissionOn: addDays(birth, -10), birthOn: birth, dischargeOn: addDays(birth, 3) }; // prettier-ignore
    expect(noticesOf({ from: today, to: addDays(birth, 83) }, maternity)).toEqual([]); // prettier-ignore
  });

  it('CER-046 CER-055 un parto 28 días después de la atención no avisa; 29, avisa con la fecha habitual (D-110 §1)', () => {
    const day = { from: today, to: today };
    expect(noticesOf(day, maternityFrom(addDays(today, 28)))).toEqual([]);
    expect(noticesOf(day, maternityFrom(addDays(today, 29)))).toEqual([
      REST_LIMIT_NOTICE.birthTooFar(addDays(today, 28)),
    ]);
  });

  it('CER-047 CER-055 el reposo que pasa del parto + 83, o se emite después, avisa nombrando ese día (D-110 §6)', () => {
    const birth = addDays(today, -60);
    const last = addDays(birth, 83);
    const maternity = maternityFrom(birth);
    expect(noticesOf({ from: today, to: last }, maternity)).toEqual([]);
    expect(noticesOf({ from: today, to: addDays(last, 1) }, maternity)).toEqual(
      [REST_LIMIT_NOTICE.leaveExceeded(last)],
    );
    expect(REST_LIMIT_NOTICE.leaveExceeded(last)).toContain(label(last));

    const late = addDays(today, -80);
    const lateLast = addDays(late, 83);
    const period = { from: lateLast, to: lateLast };
    expect(noticesOf(period, maternityFrom(late), lateLast)).toEqual([]);
    expect(
      noticesOf(period, maternityFrom(late), addDays(lateLast, 1)),
    ).toEqual([REST_LIMIT_NOTICE.leaveExceeded(lateLast)]);
  });

  it('CER-051 CER-055 un ingreso 14 días antes del parto no avisa; 15, avisa con la fecha habitual (D-112 §1)', () => {
    const birth = addDays(today, -5);
    const withAdmission = (daysBefore: number) => ({
      admissionOn: addDays(birth, -daysBefore),
      birthOn: birth,
      dischargeOn: addDays(birth, 2),
    });
    const day = { from: today, to: today };
    expect(noticesOf(day, withAdmission(14))).toEqual([]);
    expect(noticesOf(day, withAdmission(15))).toEqual([
      REST_LIMIT_NOTICE.admissionTooEarly(addDays(birth, -14)),
    ]);
    expect(check(day, birth, { maternity: withAdmission(15) })).not.toThrow();
  });

  it('CER-049 la atencion necesita un diagnostico obstetrico', () => {
    const birth = addDays(today, -5);
    const period = { from: birth, to: today };
    expect(check(period, birth, { codes: ['Z390'] })).not.toThrow();
    expect(check(period, birth, { codes: ['J02', 'I10'] })).toThrow(
      CertificateMaternityDiagnosisRequiredError,
    );
    expect(check(period, birth, { codes: [] })).toThrow(
      CertificateMaternityDiagnosisRequiredError,
    );
  });

  it('CER-049 obstetrico es O00 a O99 y Z34 a Z39, con sus subcategorias; no los capitulos', () => {
    for (const code of ['O00', 'O80', 'O994', 'Z34', 'Z349', 'Z39', 'Z392']) {
      expect(isObstetricCie10(code), code).toBe(true);
    }
    for (const code of ['O9A', 'O00-O9A', 'Z33', 'Z40', 'J02', 'N80', '']) {
      expect(isObstetricCie10(code), code).toBe(false);
    }
  });

  it('CER-048 no se solapa con otro reposo no anulado de la paciente; contiguo, si', () => {
    const birth = addDays(today, -5);
    const period = { from: birth, to: addDays(today, 10) };
    const before = { from: addDays(birth, -10), to: addDays(birth, -1), maternityBirthOn: null }; // prettier-ignore
    const touching = { ...before, to: birth };
    expect(check(period, birth, { others: [before] })).not.toThrow();
    expect(check(period, birth, { others: [touching] })).toThrow(
      CertificateRestOverlapsError,
    );
  });

  it('CER-050 otra maternidad de la paciente con otro parto a 9 meses o menos se rechaza nombrando ese parto (D-110 §2)', () => {
    const birth = addDays(today, -5);
    const period = { from: birth, to: today };
    const chained = (otherBirth: ClinicalDate) => [
      { from: addDays(today, -200), to: addDays(today, -190), maternityBirthOn: otherBirth }, // prettier-ignore
    ];
    // Control positivo: el mismo parto, o uno a más de 9 meses.
    expect(check(period, birth, { others: chained(birth) })).not.toThrow();
    const longAgo = addDays(addMonths(birth, -9), -1);
    expect(check(period, birth, { others: chained(longAgo) })).not.toThrow();
    const later = addDays(addMonths(birth, 9), 1);
    expect(check(period, birth, { others: chained(later) })).not.toThrow();
    // Los bordes, en los dos sentidos: a 9 meses justos es el mismo embarazo.
    expect(
      check(period, birth, { others: chained(addMonths(birth, 9)) }),
    ).toThrow(CertificateMaternityBirthMismatchError);
    const close = addMonths(birth, -9);
    const refusal = refusalOf(check(period, birth, { others: chained(close) }));
    expect(refusal).toBeInstanceOf(CertificateMaternityBirthMismatchError);
    expect(
      (refusal as CertificateMaternityBirthMismatchError).fieldErrors[0],
    ).toMatchObject({
      field: 'birthOn',
      message: `Otro reposo de maternidad de la paciente declara el parto el ${label(close)}`,
    });
  });

  it('CER-048 un reposo de otra contingencia no cabe sobre una maternidad vigente; sobre otro general, si (D-110 §5)', () => {
    const period = { from: today, to: addDays(today, 2) };
    const maternity = { from: addDays(today, 2), to: addDays(today, 20), maternityBirthOn: addDays(today, 2) }; // prettier-ignore
    const general = { ...maternity, maternityBirthOn: null };
    expect(() => assertRestDoesNotOverlapMaternity(period, [general])).not.toThrow(); // prettier-ignore
    expect(
      () =>
      assertRestDoesNotOverlapMaternity({ ...period, to: addDays(today, 1) }, [maternity]), // prettier-ignore
    ).not.toThrow();
    expect(() =>
      assertRestDoesNotOverlapMaternity(period, [maternity]),
    ).toThrow(CertificateRestOverlapsError);
  });

  it('CER-050 no depende del orden de emision: el recorte de fin de mes se juzga desde los dos partos', () => {
    // fecha-fija: el caso es el calendario mismo (31 de agosto frente a 30 de
    // noviembre). 31-08 − 9 meses = 30-11 del año anterior, pero 30-11 + 9 meses
    // = 30-08: sólo un sentido los junta.
    const august = '2026-08-31' as ClinicalDate; // fecha-fija: fin de mes
    const november = '2025-11-30' as ClinicalDate; // fecha-fija: fin de mes
    const one = (b: ClinicalDate) => [{ from: b, to: b, maternityBirthOn: b }];
    const at = (b: ClinicalDate) => () =>
      assertMaternityCoherent(
        { from: b, to: b },
        maternityFrom(b),
        OBSTETRIC,
        one(b === august ? november : august),
      );
    expect(at(august)).toThrow(CertificateMaternityBirthMismatchError);
    expect(at(november)).toThrow(CertificateMaternityBirthMismatchError);
  });
});
