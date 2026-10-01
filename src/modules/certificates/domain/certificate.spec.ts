import { describe, expect, it } from 'vitest';

import {
  addDays,
  addMonths,
  atWallClock,
  WallClockTime,
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
  assertRestStartsInTime,
  assertRestWithinAttention,
  assertMaternityWithinLeave,
  assertRestDoesNotOverlapMaternity,
  isObstetricCie10,
  lateIssueDayOf,
  issuerReasonOf,
  latestRestStartOf,
  MATERNITY_CHAIN_NOTICE,
  restDetailsOf,
  missingPatientWork,
  patientWorkNotice,
  restNoticesOf,
  type RestRequest,
} from './certificate';
import {
  CertificateBackdatingReasonRequiredError,
  CertificateIssuerReasonRequiredError,
  CertificateMaternityBirthMismatchError,
  CertificateMaternityBirthTooFarError,
  CertificateMaternityDatesTooOldError,
  CertificateMaternityDiagnosisRequiredError,
  CertificateMaternityLeaveExceededError,
  CertificateRestOverlapsError,
  CertificateRestIssuedTooLateError,
  CertificateRestPeriodInvalidError,
  CertificateRestStartTooEarlyError,
  CertificateRestStartTooLateError,
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

describe('CER-041 el reposo empieza, como tarde, el día siguiente a la emisión', () => {
  it('CER-041 desde hoy o desde mañana pasa; desde pasado mañana se rechaza nombrando restFrom y la fecha tope', () => {
    const tomorrow = addDays(today, 1);
    expect(latestRestStartOf(today)).toBe(tomorrow);
    expect(() =>
      assertRestStartsInTime({ from: today, to: today }, today),
    ).not.toThrow();
    expect(() =>
      assertRestStartsInTime({ from: tomorrow, to: tomorrow }, today),
    ).not.toThrow();

    let refusal: unknown;
    try {
      assertRestStartsInTime({ from: addDays(today, 90), to: addDays(today, 91) }, today); // prettier-ignore
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(CertificateRestStartTooLateError);
    expect((refusal as CertificateRestStartTooLateError).fieldErrors).toEqual([
      {
        field: 'restFrom',
        code: 'CERTIFICATE_REST_START_TOO_LATE',
        message: `El reposo debe empezar, como muy tarde, el ${tomorrow.split('-').reverse().join('/')}`,
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

  it('CER-044 con motivo, el reposo empieza como mucho 3 días antes de la atención; 4 se rechaza nombrando restFrom', () => {
    expect(() =>
      assertRestWithinAttention(
        { from: addDays(today, -3), to: today },
        today,
        today,
        null,
      ),
    ).not.toThrow();
    let refusal: unknown;
    try {
      assertRestWithinAttention(
        { from: addDays(today, -4), to: today },
        today,
        today,
        null,
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(CertificateRestStartTooEarlyError);
    expect(
      (refusal as CertificateRestStartTooEarlyError).fieldErrors[0],
    ).toMatchObject({
      field: 'restFrom',
      message: `El reposo debe empezar, como muy pronto, el ${addDays(today, -3).split('-').reverse().join('/')}`,
    });
  });

  it('CER-045 un reposo se emite hasta el octavo día de la atención; el noveno se rechaza', () => {
    const period = { from: addDays(today, 8), to: addDays(today, 8) };
    expect(() =>
      assertRestWithinAttention(period, today, addDays(today, 8), null),
    ).not.toThrow();
    expect(() =>
      assertRestWithinAttention(
        { from: addDays(today, 9), to: addDays(today, 9) },
        today,
        addDays(today, 9),
        null,
      ),
    ).toThrow(CertificateRestIssuedTooLateError);
  });
});

describe('D-108 en el reposo de maternidad no rigen los topes de D-106', () => {
  /** Ingresó dos días antes del parto y salió dos días después. */
  const maternityFrom = (birth: ClinicalDate) => ({
    admissionOn: addDays(birth, -2),
    birthOn: birth,
    dischargeOn: addDays(birth, 2),
  });
  /** A rest from `from` to today, issued today on today's attention. */
  const startingOn =
    (from: ClinicalDate, maternity: ReturnType<typeof maternityFrom> | null) =>
    () =>
      assertRestWithinAttention({ from, to: today }, today, today, maternity);

  it('CER-044 la maternidad empieza el dia del parto o del ingreso aunque la atencion sea cinco dias despues', () => {
    const birth = addDays(today, -5);
    const maternity = maternityFrom(birth);
    expect(startingOn(birth, maternity)).not.toThrow();
    expect(startingOn(maternity.admissionOn, maternity)).not.toThrow();
    // Control: la enfermedad general con la misma fecha sigue rechazada.
    expect(startingOn(birth, null)).toThrow(CertificateRestStartTooEarlyError);
  });

  it('CER-044 un dia que no es ni el ingreso ni el parto se rechaza, nombrando los dos', () => {
    const maternity = maternityFrom(addDays(today, -5));
    const label = (day: ClinicalDate) => day.split('-').reverse().join('/');
    for (const from of [
      addDays(maternity.admissionOn, 1),
      addDays(maternity.admissionOn, -1),
    ]) {
      let refusal: unknown;
      try {
        startingOn(from, maternity)();
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(CertificateRestStartTooEarlyError);
      const error = refusal as CertificateRestStartTooEarlyError;
      expect(error.userTitle).toContain('ingreso o del parto');
      expect(error.fieldErrors[0]).toMatchObject({
        field: 'restFrom',
        message: `El reposo de maternidad empieza el día del ingreso (${label(maternity.admissionOn)}) o del parto (${label(maternity.birthOn)}), o como muy pronto el ${label(addDays(today, -3))}`,
      });
    }
  });

  it('CER-044 la maternidad conserva los 3 dias antes de la atencion: la prenatal, como estaba, sin proponer dias futuros (D-106 §2)', () => {
    const prenatal = maternityFrom(addDays(today, 20));
    expect(startingOn(addDays(today, -3), prenatal)).not.toThrow();
    let refusal: unknown;
    try {
      startingOn(addDays(today, -4), prenatal)();
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(CertificateRestStartTooEarlyError);
    expect(
      (refusal as CertificateRestStartTooEarlyError).fieldErrors[0]?.message,
    ).toBe(
      `El reposo debe empezar, como muy pronto, el ${addDays(today, -3).split('-').reverse().join('/')}`,
    );
  });

  it('CER-045 un reposo de maternidad se emite pasados 8 dias de la atencion; el general no', () => {
    const issueDay = addDays(today, 9);
    const period = { from: issueDay, to: addDays(issueDay, 29) };
    const maternity = maternityFrom(addDays(today, -1));
    expect(() =>
      assertRestWithinAttention(period, today, issueDay, maternity),
    ).not.toThrow();
    expect(() =>
      assertRestWithinAttention(period, today, issueDay, null),
    ).toThrow(CertificateRestIssuedTooLateError);
  });
});

describe('D-109 y D-110 lo que acota el reposo de maternidad', () => {
  const OBSTETRIC = ['J02', 'O80'];
  /** Ingresó la víspera del parto y salió dos días después. */
  const maternityFrom = (birth: ClinicalDate) => ({
    admissionOn: addDays(birth, -1),
    birthOn: birth,
    dischargeOn: addDays(birth, 2),
  });
  type Other = { from: ClinicalDate; to: ClinicalDate; maternityBirthOn: ClinicalDate | null }; // prettier-ignore
  /** A maternity rest checked against today's attention, issued today. */
  const check =
    (
      period: { from: ClinicalDate; to: ClinicalDate },
      birth: ClinicalDate,
      {
        issueDay = today,
        codes = OBSTETRIC,
        others = [] as Other[],
        maternity = maternityFrom(birth),
      } = {},
    ) =>
    () =>
      assertMaternityWithinLeave(period, maternity, today, issueDay, codes, others); // prettier-ignore
  const label = (day: ClinicalDate) => day.split('-').reverse().join('/');
  const refusalOf = (run: () => void): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it('CER-046 el parto como mucho 84 dias antes de la atencion; 85 se rechaza nombrando el campo', () => {
    // Control positivo a 83 días: a 84, la licencia (parto + 83) ya acabó la
    // víspera y lo rechaza CER-047; CER-046 da el motivo claro desde el 85.
    expect(
      check({ from: today, to: today }, addDays(today, -83)),
    ).not.toThrow();
    expect(check({ from: today, to: today }, addDays(today, -84))).toThrow(
      CertificateMaternityLeaveExceededError,
    );
    const refusal = refusalOf(
      check({ from: today, to: today }, addDays(today, -85)),
    );
    expect(refusal).toBeInstanceOf(CertificateMaternityDatesTooOldError);
    // Nombra el primer parto que de verdad sirve: el de hace 84 días ya no
    // deja emitir nada (CER-047).
    expect(
      (refusal as CertificateMaternityDatesTooOldError).fieldErrors[0],
    ).toMatchObject({
      field: 'birthOn',
      message: `La fecha del parto debe ser, como muy pronto, el ${label(addDays(today, -83))}`,
    });
  });

  it('CER-046 el ingreso no cuenta: el ultimo tramo de una licencia con ingreso antiguo se emite (D-110 §3)', () => {
    const birth = addDays(today, -80);
    const maternity = { admissionOn: addDays(birth, -10), birthOn: birth, dischargeOn: addDays(birth, 3) }; // prettier-ignore
    expect(check({ from: today, to: addDays(birth, 83) }, birth, { maternity })).not.toThrow(); // prettier-ignore
  });

  it('CER-046 el parto como mucho 28 dias despues de la atencion; 29 se rechaza (D-110 §1)', () => {
    expect(check({ from: today, to: today }, addDays(today, 28))).not.toThrow();
    const refusal = refusalOf(
      check({ from: today, to: today }, addDays(today, 29)),
    );
    expect(refusal).toBeInstanceOf(CertificateMaternityBirthTooFarError);
    expect(
      (refusal as CertificateMaternityBirthTooFarError).fieldErrors[0],
    ).toMatchObject({
      field: 'birthOn',
      message: `La fecha del parto debe ser, como muy tarde, el ${label(addDays(today, 28))}`,
    });
  });

  it('CER-047 el reposo termina como tarde en parto + 83 dias, nombrando ese dia (D-110 §6)', () => {
    const birth = addDays(today, -60);
    const last = addDays(birth, 83);
    expect(check({ from: today, to: last }, birth)).not.toThrow();
    const refusal = refusalOf(
      check({ from: today, to: addDays(last, 1) }, birth),
    );
    expect(refusal).toBeInstanceOf(CertificateMaternityLeaveExceededError);
    expect(
      (refusal as CertificateMaternityLeaveExceededError).fieldErrors[0],
    ).toMatchObject({
      field: 'restTo',
      message: `La licencia de maternidad termina el ${label(last)}`,
    });
  });

  it('CER-047 no se emite pasado el ultimo dia de la licencia', () => {
    const birth = addDays(today, -80);
    const last = addDays(birth, 83);
    const period = { from: last, to: last };
    expect(check(period, birth, { issueDay: last })).not.toThrow();
    expect(check(period, birth, { issueDay: addDays(last, 1) })).toThrow(
      CertificateMaternityLeaveExceededError,
    );
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
    expect(check(period, birth, { others: chained(addMonths(birth, 9)) })).toThrow(
      CertificateMaternityBirthMismatchError,
    );
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
      assertMaternityWithinLeave(
        { from: b, to: b },
        maternityFrom(b),
        b,
        b,
        OBSTETRIC,
        one(b === august ? november : august),
      );
    expect(at(august)).toThrow(CertificateMaternityBirthMismatchError);
    expect(at(november)).toThrow(CertificateMaternityBirthMismatchError);
  });
});
