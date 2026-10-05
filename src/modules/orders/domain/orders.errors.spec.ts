import { describe, expect, it } from 'vitest';

import { DOMAIN_ERROR_CODES } from '../../../shared/domain/errors/error-catalogue';
import {
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';

import {
  CriticalNoticeTimeInvalidError,
  CriticalReadBackRequiredError,
  ExamCategoryMismatchError,
  ExamNotOrderableError,
  OrderEncounterNotFoundError,
  OrderDraftOfAnotherPractitionerError,
  OrderNotDraftError,
  OrderNotIssuedError,
  OrderEncounterNotOpenError,
  OrderItemNotMatchableError,
  OrderItemNotPendingError,
  OrderNotFoundError,
  ReportAlreadyCorrectedError,
  ReportNotCorrectableError,
  ReportNotFoundError,
  ResultAlreadyMatchedError,
  ResultAnalyteUnknownError,
  ResultChartUnmatchedError,
  ResultFlagIsDerivedError,
  ResultNotCriticalError,
  ReportCorrectionIncompleteError,
  ReportIssuedInFutureError,
  ResultNotFoundError,
  ResultSupersededError,
  ResultValueNotAllowedError,
  ResultValueTypeMismatchError,
} from './orders.errors';

/**
 * The error contract: a stable code, the CATEGORY that decides the HTTP status,
 * and a sentence the user can act on.
 *
 * The status is asserted through the category because the mapping lives in
 * `problem-details.filter.ts` — `ValidationError` is 422 there, `ConflictError`
 * 409 and `NotFoundError` 404.
 */
const EVERY_ERROR: readonly DomainError[] = [
  new OrderNotFoundError(),
  new OrderEncounterNotFoundError(),
  new ReportNotFoundError(),
  new ExamNotOrderableError(),
  new OrderEncounterNotOpenError('COMPLETED'),
  new OrderItemNotPendingError(),
  new OrderNotDraftError(),
  new OrderNotIssuedError(),
  new OrderDraftOfAnotherPractitionerError(),
  new ExamCategoryMismatchError(),
  new ReportAlreadyCorrectedError(),
  new ReportNotCorrectableError('PARTIAL'),
  new ResultAnalyteUnknownError(),
  new ResultValueTypeMismatchError('HB', 'NUMERIC'),
  new ResultValueTypeMismatchError('EMO-NITRITOS', 'CODED'),
  new ResultValueTypeMismatchError('CULTIVO', 'TEXT'),
  new ResultValueNotAllowedError('EMO-NITRITOS', ['Negativo', 'Positivo']),
  new ResultFlagIsDerivedError(),
  new ResultChartUnmatchedError(),
  new ResultNotFoundError(),
  new ResultAlreadyMatchedError(),
  new OrderItemNotMatchableError(),
  new ResultNotCriticalError(),
  new CriticalNoticeTimeInvalidError(),
  new ResultSupersededError(),
  new CriticalReadBackRequiredError(),
  new ReportIssuedInFutureError(),
  new ReportCorrectionIncompleteError(['Glucosa en ayunas']),
];

describe('el contrato de errores de las órdenes', () => {
  it('ORD-090 declara todos sus códigos en el catálogo congelado', () => {
    for (const error of EVERY_ERROR) {
      expect(
        DOMAIN_ERROR_CODES,
        `${error.code} no está en el catálogo`,
      ).toContain(error.code);
    }
  });

  it('ORD-024 no deja viajar ningún valor de laboratorio ni dato del paciente', () => {
    /**
     * Estas frases llegan a un log y a una captura de soporte. Lo que aquí se
     * filtraría es un resultado de laboratorio, que es lo que querrían leer un
     * empleador o una aseguradora.
     *
     * ⚠️ EL CÓDIGO DEL ANALITO SÍ PUEDE APARECER en `params` —`HB`, `GLU`— y no
     * es dato del paciente: es metadato de catálogo. Lo prohibido es un
     * NÚMERO, que es la lectura.
     */
    for (const error of EVERY_ERROR) {
      const sentences = [error.userTitle ?? '', ...(error.fieldErrors ?? []).map((f) => f.message)].join(' '); // prettier-ignore
      expect(sentences, error.code).not.toMatch(/\d+[,.]\d+/);
      expect(Object.values(error.params).join(' '), error.code).not.toMatch(
        /\d+[,.]\d+/,
      );
    }
  });

  it('ORD-009 responde lo mismo para «no existe» y para «es de otra sede»', () => {
    // Distinguirlas confirmaría órdenes ajenas a quien prueba identificadores
    // de uno en uno. Es la línea de `ENCOUNTER_NOT_FOUND`.
    const order = new OrderNotFoundError();
    expect(order).toBeInstanceOf(NotFoundError);
    expect(order.userTitle).toContain('sedes a las que usted tiene acceso');
  });

  it('ORD-003 rechaza la orden entera y señala el campo de los exámenes', () => {
    const error = new ExamNotOrderableError();
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.fieldErrors?.[0]?.field).toBe('items');
  });

  it('ORD-097 rechaza la orden entera y señala el campo de los exámenes', () => {
    const error = new ExamCategoryMismatchError();
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.fieldErrors?.[0]?.field).toBe('items');
    expect(error.userTitle).toContain('tipo de la orden');
  });

  it('ORD-096 y ORD-100 son conflictos de estado: borrador y emitida', () => {
    expect(new OrderNotDraftError()).toBeInstanceOf(ConflictError);
    expect(new OrderNotIssuedError()).toBeInstanceOf(ConflictError);
  });

  it('ORD-005 y ORD-008 son conflictos de estado, no de contenido', () => {
    // 409 y no 422: lo enviado es correcto, y lo que lo impide es el estado.
    expect(new OrderEncounterNotOpenError('COMPLETED')).toBeInstanceOf(
      ConflictError,
    );
    expect(new OrderItemNotPendingError()).toBeInstanceOf(ConflictError);
    expect(new ReportAlreadyCorrectedError()).toBeInstanceOf(ConflictError);
    expect(new ReportNotCorrectableError('PARTIAL')).toBeInstanceOf(
      ConflictError,
    );
  });

  it('ORD-035 dice que la marca la calcula el sistema y señala el campo enviado', () => {
    const error = new ResultFlagIsDerivedError();
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.fieldErrors?.[0]?.field).toBe('results.abnormalFlag');
    expect(error.userTitle).toContain('la calcula el sistema');
  });

  it('ORD-032 dice qué hacer según el tipo que declara la determinación', () => {
    // Quien lo lee está transcribiendo un informe impreso: «el valor no
    // corresponde al tipo» no le dice qué corregir.
    expect(new ResultValueTypeMismatchError('HB', 'NUMERIC').userTitle).toContain('número'); // prettier-ignore
    expect(new ResultValueTypeMismatchError('EMO-NITRITOS', 'CODED').userTitle).toContain('opciones'); // prettier-ignore
    expect(new ResultValueTypeMismatchError('CULTIVO', 'TEXT').userTitle).toContain('texto'); // prettier-ignore
    // Un tipo que el catálogo aún no conoce no puede dejar al usuario sin frase.
    expect(
      new ResultValueTypeMismatchError('X', 'RATIO').userTitle,
    ).toBeTruthy();
  });

  it('ORD-043 dice qué hacer al que trabaja la cola de resultados sin orden', () => {
    // 404 y 409 y 422, y cada uno por su razón: no está, alguien se te
    // adelantó, o la línea que elegiste no es de esta orden.
    expect(new ResultNotFoundError()).toBeInstanceOf(NotFoundError);
    expect(new ResultNotFoundError().userTitle).toContain(
      'sedes a las que usted tiene acceso',
    );

    expect(new ResultAlreadyMatchedError()).toBeInstanceOf(ConflictError);
    expect(new ResultAlreadyMatchedError().userTitle).toContain('ya está emparejado'); // prettier-ignore

    const line = new OrderItemNotMatchableError();
    expect(line).toBeInstanceOf(ValidationError);
    expect(line.fieldErrors?.[0]?.field).toBe('orderItemId');
    expect(line.userTitle).toContain('Elija una línea de esta orden');
  });

  it('ORD-062 rechaza el aviso de un valor que no es crítico y el de un instante imposible', () => {
    // 422 los dos: la petición se entiende, lo que afirma no puede ser.
    const notCritical = new ResultNotCriticalError();
    expect(notCritical).toBeInstanceOf(ValidationError);
    expect(notCritical.code).toBe('RESULT_NOT_CRITICAL');
    expect(notCritical.userTitle).toContain('no es un valor crítico');

    const time = new CriticalNoticeTimeInvalidError();
    expect(time).toBeInstanceOf(ValidationError);
    expect(time.code).toBe('CRITICAL_NOTICE_TIME_INVALID');
    expect(time.fieldErrors?.[0]?.field).toBe('notifiedAt');
    expect(time.userTitle).toContain('no puede ser futura');
  });

  it('ORD-066 pide el read-back y dice qué hacer si nadie contestó', () => {
    const error = new CriticalReadBackRequiredError();
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.fieldErrors?.[0]?.field).toBe('readBack');
    expect(error.userTitle).toContain('llamada sin respuesta');
  });

  it('ORD-062 un valor ya corregido manda a trabajar el vigente', () => {
    const error = new ResultSupersededError();
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('RESULT_SUPERSEDED');
    expect(error.userTitle).toContain('informe vigente');
  });

  it('ORD-055 pide que la corrección traiga también lo que no cambia', () => {
    const error = new ReportCorrectionIncompleteError(['Glucosa en ayunas']);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('REPORT_CORRECTION_INCOMPLETE');
    expect(error.userTitle).toContain('Escriba también las que no cambian');
    // Dice CUÁL falta: en un panel largo, la cuenta sola no sirve.
    expect(error.fieldErrors).toEqual([
      expect.objectContaining({
        field: 'results',
        message: 'Falta: Glucosa en ayunas',
      }),
    ]);
  });

  it('ORD-080 manda buscar a la persona antes de registrarla, nunca dice que se creará sola', () => {
    const error = new ResultChartUnmatchedError();
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.userTitle).toContain('Busque a la persona en Pacientes');
    expect(error.userTitle).toContain('antes de registrarla');
  });
});
