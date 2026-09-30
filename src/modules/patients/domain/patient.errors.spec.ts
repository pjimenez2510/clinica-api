import { describe, expect, it } from 'vitest';

import { DOMAIN_ERROR_CODES } from '../../../shared/domain/errors/error-catalogue';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';

import {
  AccessContextNotFoundError,
  MergeIntoSelfError,
  MergeNotFoundError,
  MergeReasonRequiredError,
  MergeUndoConflictError,
  PatientAlreadyMergedError,
} from './patient.errors';

/**
 * El contrato de los códigos que P4 estrena: `code` estable, el estado HTTP
 * —afirmado por la categoría, que es lo que `problem-details.filter.ts` mira— y
 * la frase que lee quien está en admisión.
 *
 * ⚠️ Y LO QUE NO PUEDE DECIR NINGUNO. Ni un nombre, ni el valor de un
 * documento, ni un dato clínico (PA-025, REQ-116, SC-006). Lo único de un
 * paciente que sale de aquí es el MRN, que es un número interno y no un
 * identificador nacional — el mismo criterio que `PATIENT_MERGED`.
 */
describe('los errores de la fusión de duplicados', () => {
  it('PA-044 answers MERGE_REASON_REQUIRED as an unprocessable field', () => {
    const error = new MergeReasonRequiredError();

    expect(error.code).toBe('MERGE_REASON_REQUIRED');
    expect(error).toBeInstanceOf(ValidationError); // 422
    expect(error.userTitle).toBe('Escriba por qué se unen las dos historias');
    // Por campo: es un input del formulario, y el mensaje tiene que aterrizar
    // en él y no en la cabecera de la pantalla.
    expect(error.fieldErrors).toEqual([
      {
        field: 'reason',
        code: 'MERGE_REASON_REQUIRED',
        message: 'Explique por qué: quedará en el rastro de la fusión',
      },
    ]);
  });

  it('PA-046 answers MERGE_INTO_SELF pointing at the chart selector', () => {
    const error = new MergeIntoSelfError();

    expect(error.code).toBe('MERGE_INTO_SELF');
    expect(error).toBeInstanceOf(ValidationError); // 422
    expect(error.userTitle).toBe(
      'Esa es la misma historia: elija la otra ficha',
    );
    expect(error.fieldErrors?.[0]?.field).toBe('targetPatientId');
  });

  it('PA-046 answers PATIENT_ALREADY_MERGED as a conflict naming where that chart went', () => {
    const error = new PatientAlreadyMergedError(
      'targetPatientId',
      'HC0000000042',
    );

    expect(error.code).toBe('PATIENT_ALREADY_MERGED');
    // 409 y no 422: lo enviado es correcto, y lo que lo impide es el estado del
    // registro. Deshecha la otra fusión, la misma petición se acepta.
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.fieldErrors).toEqual([
      {
        field: 'targetPatientId',
        code: 'PATIENT_ALREADY_MERGED',
        message: 'Esa historia ya se unió a HC0000000042: deshaga esa fusión primero', // prettier-ignore
      },
    ]);
    // El MRN y nada más: ni nombre, ni documento.
    expect(error.params).toEqual({ mrn: 'HC0000000042' });
  });

  it('PA-046 answers PATIENT_ALREADY_MERGED without a number when the chart absorbed others', () => {
    // El otro extremo de la cadena: la ficha que se quiere fusionar ya absorbió
    // a otras, así que no hay «a dónde se movió» que nombrar. El mensaje sigue
    // diciendo qué hacer.
    const error = new PatientAlreadyMergedError('patientId');

    expect(error.fieldErrors?.[0]?.message).toBe(
      'Esa historia ya participó en otra fusión: deshágala primero',
    );
    expect(error.params).toEqual({});
  });

  it('AG-073 answers ACCESS_CONTEXT_NOT_FOUND as a 404 that names the appointment, not the patient', () => {
    const error = new AccessContextNotFoundError();

    expect(error.code).toBe('ACCESS_CONTEXT_NOT_FOUND');
    expect(error).toBeInstanceOf(NotFoundError); // 404
    expect(DOMAIN_ERROR_CODES).toContain(error.code);
    expect(error.userTitle).toBe(
      'No se encontró la cita desde la que se abre esta ficha',
    );
  });

  it('PA-047 answers MERGE_NOT_FOUND when there is no merge to undo', () => {
    const error = new MergeNotFoundError();

    expect(error.code).toBe('MERGE_NOT_FOUND');
    expect(error).toBeInstanceOf(NotFoundError); // 404
    // NO es `PATIENT_NOT_FOUND`: el paciente está en la pantalla, y decir «no se
    // encontró el paciente» mandaría a admisión a buscar la ficha que tiene
    // delante. Lo que no existe es el SUCESO.
    expect(error.userTitle).toBe(
      'Esta historia no tiene ninguna fusión que deshacer',
    );
  });

  it('PA-048 answers MERGE_UNDO_CONFLICT naming the class of document and the chart that holds it', () => {
    const error = new MergeUndoConflictError('CEDULA', 'HC0000000042');

    expect(error.code).toBe('MERGE_UNDO_CONFLICT');
    expect(error).toBeInstanceOf(ConflictError); // 409
    expect(error.userTitle).toBe(
      'No se puede deshacer: otra historia tiene ahora ese documento',
    );
    expect(error.fieldErrors).toEqual([
      {
        field: 'patientId',
        code: 'MERGE_UNDO_CONFLICT',
        message: 'La historia HC0000000042 tiene ahora la cédula de esta ficha: corríjala allí antes de deshacer la fusión', // prettier-ignore
      },
    ]);
  });

  it('PA-048 never puts the value of the document in the message', () => {
    /**
     * La prueba que impide el arreglo evidente y equivocado. «Ya existe un
     * paciente con la cédula 1710034065» es lo que se escribe cuando lo que se
     * quiere es que el mensaje sea útil, y ese texto acaba en una captura de
     * pantalla de soporte y en un registro que no se purga (REQ-116, PA-025).
     */
    const error = new MergeUndoConflictError('CEDULA', 'HC0000000042');
    const everythingEmitted = [
      error.userTitle,
      error.message,
      ...(error.fieldErrors ?? []).map((field) => field.message),
      JSON.stringify(error.params),
    ].join(' ');

    // Una cédula suelta: diez dígitos que no van pegados a un `HC`, que es la
    // única cadena de dígitos que este error puede publicar.
    expect(everythingEmitted).not.toMatch(/\b\d{10}\b/);
    expect(everythingEmitted).not.toMatch(/Guamán|María/);
    // La CLASE de documento sí, que es lo que dice dónde mirar.
    expect(error.identifierType).toBe('CEDULA');
  });

  it('PA-044 registers the five new codes in the frozen catalogue', () => {
    // El `code` es contrato público: renombrarlo rompe clientes, y por eso el
    // catálogo se mantiene a mano y esta prueba existe.
    for (const code of [
      'MERGE_INTO_SELF',
      'MERGE_NOT_FOUND',
      'MERGE_REASON_REQUIRED',
      'MERGE_UNDO_CONFLICT',
      'PATIENT_ALREADY_MERGED',
    ]) {
      expect(DOMAIN_ERROR_CODES).toContain(code);
    }
  });
});
