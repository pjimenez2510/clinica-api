import { describe, expect, it } from 'vitest';

import {
  addDays,
  atWallClock,
  clinicalDateOf,
  WallClockTime,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';

import { dateInNumbersAndWords } from './date-in-words';
import { composeForm117, NA, type Form117Source } from './form-117';

/**
 * CER-020 to CER-029. The content of the five blocks of form 117, composed by
 * a pure function.
 *
 * Every instant derives from today's date in Ecuador at a wall-clock hour
 * chosen to exercise the zone: an attention at 21:00 in Guayaquil is 02:00 UTC
 * of the next day, and printing the UTC date would put it on the wrong day.
 */
const today: ClinicalDate = clinicalDateOf(new Date());
const at = (hour: number, minute = 0, date: ClinicalDate = today): Date =>
  atWallClock(date, WallClockTime.of(hour, minute));

const aSource = (
  overrides: {
    certificate?: Partial<Form117Source['certificate']>;
    patient?: Partial<Form117Source['patient']>;
    encounter?: Partial<Form117Source['encounter']>;
    practitioner?: Partial<Form117Source['practitioner']>;
    diagnoses?: Form117Source['diagnoses'];
  } = {},
): Form117Source => ({
  certificate: {
    id: 'certificate-1',
    number: 7,
    verificationCode: 'ABCDEF0123456789',
    type: 'ATTENDANCE',
    issuedAt: at(10, 40),
    restFrom: null,
    restTo: null,
    includeDiagnosis: false,
    revokedAt: null,
    revocationReason: null,
    ...overrides.certificate,
  },
  site: { name: 'Clínica Central', mspUnicode: '000123' },
  patient: {
    familyName: 'Guamán',
    secondFamilyName: 'Andrade',
    givenName: 'María',
    secondGivenName: 'José',
    sex: 'FEMALE',
    mrn: 'HC000042',
    // Cédula sintética con dígito verificador calculado.
    identifiers: [
      { type: 'PASSPORT', value: 'PA1234567' },
      { type: 'CEDULA', value: '1710034065' },
    ],
    ...overrides.patient,
  },
  encounter: {
    startedAt: at(10, 5),
    endedAt: null,
    ageYears: 34,
    ageMonths: 2,
    ageDays: 9,
    ...overrides.encounter,
  },
  diagnoses: overrides.diagnoses ?? [
    { code: 'J00', display: 'Rinofaringitis aguda' },
    { code: 'R50.9', display: 'Fiebre, no especificada' },
  ],
  practitioner: {
    givenNames: 'Ana Lucía',
    familyNames: 'Villacís Mora',
    cedula: '1104637283',
    primarySpecialty: 'Medicina familiar',
    hasSeal: true,
    ...overrides.practitioner,
  },
});

describe('CER-020 bloque A: el establecimiento y el paciente', () => {
  it('CER-020 sirve unicodigo, establecimiento, la cedula como historia clinica unica y el mrn como archivo', () => {
    expect(composeForm117(aSource()).establishment).toEqual({
      institution: NA,
      mspUnicode: '000123',
      name: 'Clínica Central',
      clinicalRecordNumber: '1710034065',
      archiveNumber: 'HC000042',
    });
  });

  it('CER-020 sin cedula sirve el pasaporte, y sin ningun documento «NA»', () => {
    expect(
      composeForm117(
        aSource({
          patient: { identifiers: [{ type: 'PASSPORT', value: 'PA1234567' }] },
        }),
      ).establishment.clinicalRecordNumber,
    ).toBe('PA1234567');
    expect(
      composeForm117(aSource({ patient: { identifiers: [] } })).establishment
        .clinicalRecordNumber,
    ).toBe(NA);
  });
});

describe('CER-021 bloque B: la persona y su edad', () => {
  it('CER-021 sirve los dos apellidos y los dos nombres por separado, y «NA» el que falta', () => {
    expect(composeForm117(aSource()).patient).toMatchObject({
      firstFamilyName: 'Guamán',
      secondFamilyName: 'Andrade',
      firstGivenName: 'María',
      secondGivenName: 'José',
    });
    expect(
      composeForm117(
        aSource({ patient: { secondFamilyName: null, secondGivenName: null } }),
      ).patient,
    ).toMatchObject({ secondFamilyName: NA, secondGivenName: NA });
  });

  it('CER-021 sirve el sexo como Hombre o Mujer, y «NA» lo que el formulario no recoge', () => {
    expect(composeForm117(aSource()).patient.sex).toBe('Mujer');
    expect(
      composeForm117(aSource({ patient: { sex: 'MALE' } })).patient.sex,
    ).toBe('Hombre');
    expect(
      composeForm117(aSource({ patient: { sex: 'UNKNOWN' } })).patient.sex,
    ).toBe(NA);
  });

  it('CER-021 un adulto: la edad en años, condicion A', () => {
    expect(composeForm117(aSource()).patient.age).toEqual({
      value: '34',
      condition: 'A',
    });
  });

  it('CER-021 un lactante de cuatro meses: «4» con la condicion M', () => {
    expect(
      composeForm117(
        aSource({ encounter: { ageYears: 0, ageMonths: 4, ageDays: 3 } }),
      ).patient.age,
    ).toEqual({ value: '4', condition: 'M' });
  });

  it('CER-021 un neonato de menos de un mes: la edad en dias, condicion D', () => {
    expect(
      composeForm117(
        aSource({ encounter: { ageYears: 0, ageMonths: 0, ageDays: 12 } }),
      ).patient.age,
    ).toEqual({ value: '12', condition: 'D' });
  });

  it('CER-021 sin edad congelada sirve «NA», no un cero que nadie registro', () => {
    expect(
      composeForm117(
        aSource({
          encounter: { ageYears: null, ageMonths: null, ageDays: null },
        }),
      ).patient.age,
    ).toEqual({ value: NA, condition: NA });
  });
});

describe('CER-022 a CER-024 bloque B: la atencion', () => {
  it('CER-022 sirve el servicio de consulta externa y la especialidad principal, o «NA»', () => {
    expect(composeForm117(aSource()).attention).toMatchObject({
      service: 'Consulta externa',
      specialty: 'Medicina familiar',
    });
    expect(
      composeForm117(aSource({ practitioner: { primarySpecialty: null } }))
        .attention.specialty,
    ).toBe(NA);
  });

  it('CER-023 sirve la fecha de la atencion en numeros y en letras, y las horas en 24 horas', () => {
    const attention = composeForm117(
      aSource({ encounter: { startedAt: at(9, 5), endedAt: at(9, 35) } }),
    ).attention;

    expect(attention.date).toEqual(dateInNumbersAndWords(today));
    expect(attention.from).toBe('09:05');
    expect(attention.to).toBe('09:35');
  });

  it('CER-023 una atencion a las 21:00 en Guayaquil es de ese dia, no del siguiente en UTC', () => {
    const attention = composeForm117(
      aSource({
        certificate: { issuedAt: at(21, 50) },
        encounter: { startedAt: at(21, 0), endedAt: at(21, 40) },
      }),
    ).attention;

    expect(attention.date.iso).toBe(today);
    expect(attention.from).toBe('21:00');
    expect(attention.to).toBe('21:40');
  });

  it('CER-023 si la atencion seguia abierta al emitir, la hora hasta es la de emision', () => {
    // Abierta: sin fin.
    expect(composeForm117(aSource()).attention.to).toBe('10:40');
    // Cerrada DESPUÉS de emitir: al emitir seguía abierta.
    expect(
      composeForm117(aSource({ encounter: { endedAt: at(11, 30) } })).attention
        .to,
    ).toBe('10:40');
  });

  it('CER-024 los campos de hospitalizacion se sirven «NA»', () => {
    expect(composeForm117(aSource()).attention).toMatchObject({
      admissionDate: NA,
      dischargeDate: NA,
    });
  });
});

describe('CER-025 y CER-026 bloque C: el reposo', () => {
  it('CER-025 un certificado de asistencia dice reposo NO, y CER-026 el resto «NA»', () => {
    expect(composeForm117(aSource()).rest).toEqual({
      rest: 'NO',
      hours: NA,
      hoursInWords: NA,
      from: NA,
      to: NA,
    });
  });

  it('CER-026 tres dias de reposo son «72 (setenta y dos)» horas, con las fechas en letras', () => {
    const from = today;
    const to = addDays(today, 2);
    const rest = composeForm117(
      aSource({
        certificate: { type: 'MEDICAL_REST', restFrom: from, restTo: to },
      }),
    ).rest;

    expect(rest).toEqual({
      rest: 'SÍ',
      hours: '72',
      hoursInWords: 'setenta y dos',
      from: dateInNumbersAndWords(from),
      to: dateInNumbersAndWords(to),
    });
  });

  it('CER-026 un dia de reposo, con inicio y fin iguales, son 24 horas: ambos extremos cuentan', () => {
    const rest = composeForm117(
      aSource({
        certificate: { type: 'MEDICAL_REST', restFrom: today, restTo: today },
      }),
    ).rest;
    expect([rest.hours, rest.hoursInWords]).toEqual(['24', 'veinticuatro']);
  });
});

describe('CER-027 bloque D: el diagnostico', () => {
  it('CER-027 donde se incluye, sirve todos los diagnosticos con su codigo, el principal primero', () => {
    expect(
      composeForm117(aSource({ certificate: { includeDiagnosis: true } }))
        .diagnoses,
    ).toEqual([
      { code: 'J00', display: 'Rinofaringitis aguda' },
      { code: 'R50.9', display: 'Fiebre, no especificada' },
    ]);
  });

  it('CER-027 donde no se incluye, el bloque es «NA» y ningun codigo viaja', () => {
    const form = composeForm117(aSource());
    expect(form.diagnoses).toBe(NA);
    expect(JSON.stringify(form)).not.toContain('J00');
  });
});

describe('CER-028 bloque E: el profesional responsable', () => {
  it('CER-028 sirve fecha y hora de emision en Guayaquil, nombres, apellidos, cedula y sello', () => {
    expect(composeForm117(aSource()).professional).toEqual({
      date: today,
      time: '10:40',
      givenNames: 'Ana Lucía',
      familyNames: 'Villacís Mora',
      identification: '1104637283',
      hasSeal: true,
      signature: 'CREDENTIAL',
    });
  });

  it('CER-028 la firma es la credencial y nunca un trazo dibujado; sin cedula, «NA»', () => {
    const professional = composeForm117(
      aSource({ practitioner: { cedula: null, hasSeal: false } }),
    ).professional;
    expect(professional.signature).toBe('CREDENTIAL');
    expect(professional.identification).toBe(NA);
    expect(professional.hasSeal).toBe(false);
    expect(Object.keys(professional)).not.toContain('signatureImage');
  });
});

describe('CER-029 numero, codigo de verificacion y anulacion', () => {
  it('CER-029 sirve el numero y el codigo de verificacion, y ninguna anulacion mientras vale', () => {
    expect(composeForm117(aSource())).toMatchObject({
      number: 7,
      verificationCode: 'ABCDEF0123456789',
      revocation: null,
    });
  });

  it('CER-029 un certificado anulado sirve la anulacion con su fecha ecuatoriana', () => {
    const revokedAt = at(22, 30, addDays(today, 1));
    const form = composeForm117(
      aSource({
        certificate: {
          revokedAt,
          revocationReason: 'Se emitió a la persona equivocada',
        },
      }),
    );
    expect(form.revocation).toEqual({
      revokedAt,
      revokedOn: addDays(today, 1),
      reason: 'Se emitió a la persona equivocada',
    });
  });
});
