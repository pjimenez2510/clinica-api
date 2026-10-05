import { describe, expect, it } from 'vitest';

import { DOMAIN_ERROR_CODES } from '../../../shared/domain/errors/error-catalogue';
import {
  BusinessRuleViolation,
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';

import {
  AllergyAlreadyRefutedError,
  AmendmentReasonRequiredError,
  AppointmentNotAttendableError,
  BmiIsDerivedError,
  ClinicalNoteNotFoundError,
  ConceptWrongCatalogueError,
  DiagnosisCitedByIssuedDocumentError,
  DiagnosisConceptNotInForceError,
  DiagnosisNotFoundError,
  DiagnosisPrimaryTakenError,
  DiagnosisRetractionReasonRequiredError,
  DischargeConditionRequiredError,
  EncounterAlreadyClosedError,
  EncounterAppointmentMismatchError,
  EncounterCloserNotAuthorError,
  EncounterNotFoundError,
  InvalidEncounterTransitionError,
  NoteAlreadySignedError,
  NoteContentIncompleteError,
  NoteNotAmendableError,
  PatientAllergyNotFoundError,
  PatientChartNotOpenError,
  PractitionerNotLicensedError,
  RefutationReasonRequiredError,
  PatientHistoryNotFoundError,
  HistoryAlreadyRefutedError,
  PractitionerProfileRequiredError,
  SubstituteClosureReasonRequiredError,
  UnknownClinicalFormError,
  VitalsRequiredError,
  EncounterHasLiveActsError,
} from './encounter.errors';

/**
 * The error contract: a stable code, the CATEGORY that decides the HTTP status,
 * and a sentence the user can act on.
 *
 * The status is asserted through the category because the mapping lives in
 * `problem-details.filter.ts` — `ValidationError` and `BusinessRuleViolation`
 * are both 422 there, `ConflictError` is 409, `NotFoundError` 404 and
 * `ForbiddenError` 403.
 */

/** Every error this module can throw, instantiated as it would be. */
const EVERY_ERROR: readonly DomainError[] = [
  new EncounterNotFoundError(),
  new PatientChartNotOpenError(),
  new EncounterAppointmentMismatchError(),
  new AppointmentNotAttendableError(),
  new EncounterAlreadyClosedError('DISCHARGED'),
  new DischargeConditionRequiredError(),
  new InvalidEncounterTransitionError('COMPLETED', 'OPEN'),
  new EncounterCloserNotAuthorError(),
  new SubstituteClosureReasonRequiredError(),
  new PractitionerProfileRequiredError(),
  new PractitionerNotLicensedError(),
  new BmiIsDerivedError(),
  new VitalsRequiredError(['heightCm']),
  new ClinicalNoteNotFoundError(),
  new UnknownClinicalFormError(['002@1']),
  new NoteContentIncompleteError(['motivoConsulta']),
  new NoteAlreadySignedError(),
  new AmendmentReasonRequiredError(),
  new NoteNotAmendableError('SUPERSEDED'),
  new ConceptWrongCatalogueError('CIE10'),
  new ConceptWrongCatalogueError('TARIFF'),
  new DiagnosisConceptNotInForceError(),
  new DiagnosisPrimaryTakenError(),
  new DiagnosisNotFoundError(),
  new DiagnosisRetractionReasonRequiredError(),
  new DiagnosisCitedByIssuedDocumentError(),
  // EN-080. La tercera cara de la misma negativa: el concepto es del CNMB o
  // no lo es, y la frase tiene que nombrar la lista que hay que abrir. Con un
  // ternario, «todo lo que no es CIE-10» decía «el tarifario», y una alergia
  // a la penicilina se contestaba con «búsquelo en el catálogo de
  // prestaciones».
  new ConceptWrongCatalogueError('CNMB'),
  new PatientAllergyNotFoundError(),
  new AllergyAlreadyRefutedError(),
  new RefutationReasonRequiredError(),
  // EN-085. Los antecedentes, con el régimen de las alergias.
  new RefutationReasonRequiredError('el antecedente'),
  new PatientHistoryNotFoundError(),
  new HistoryAlreadyRefutedError(),
];

describe('el contrato de errores de la atención', () => {
  it('EN-125 declara todos sus códigos en el catálogo congelado', () => {
    // `error-catalogue.spec.ts` walks the source and asserts the same thing
    // from the other side; this asserts it for the errors this module can
    // actually construct, which is the half a regex cannot see.
    for (const error of EVERY_ERROR) {
      expect(
        DOMAIN_ERROR_CODES,
        `${error.code} no está en el catálogo`,
      ).toContain(error.code);
    }
  });

  it('EN-124 no nombra al paciente en ningún mensaje ni parámetro', () => {
    /**
     * SC-016, and it is stricter here than anywhere else in the system: in the
     * agenda the datum that could leak is an hour, here it is a diagnosis.
     * Every one of these sentences reaches a log or a support screenshot.
     *
     * ⚠️ WHAT IS FORBIDDEN IS A CIE-10 *CODE*, NOT THE NAME OF THE CATALOGUE.
     * `\b[A-TV-Z]\d{2}\d?\b` is the shape of one — `J020`, `E11`, `Z34` —
     * and telling a doctor «búsquelo en el catálogo CIE-10» discloses nothing
     * about anybody. The rule the trigger of EN-042 wrote down is the same
     * one: it stopped interpolating the concept id, and kept the sentence.
     */
    const forbidden =
      /paciente-|patient-\w|\d{10}|cedula|cédula|\b[A-TV-Z]\d{2}\d?\b|diagn[oó]stico de/i;

    for (const error of EVERY_ERROR) {
      const serialised = JSON.stringify({
        message: error.message,
        title: error.userTitle,
        params: error.params,
        errors: error.fieldErrors,
      });
      expect(serialised, `${error.code} filtra datos`).not.toMatch(forbidden);
      // And no `undefined` leaking through a template that lost its value.
      expect(error.message).not.toMatch(/undefined/);
    }
  });

  it('EN-125 escribe en español, para quien lo lee, lo que hay que hacer', () => {
    for (const error of EVERY_ERROR) {
      expect(error.userTitle, `${error.code} no tiene frase`).toBeTruthy();
      // ADR-005: a complete sentence, capitalised, no trailing period.
      expect(error.userTitle?.[0]).toBe(error.userTitle?.[0]?.toUpperCase());
      expect(error.userTitle?.endsWith('.')).toBe(false);
    }
  });

  it('EN-121 responde 404 con el mismo mensaje para «no existe» y «es de otra sede»', () => {
    const error = new EncounterNotFoundError();

    expect(error.code).toBe('ENCOUNTER_NOT_FOUND');
    expect(error).toBeInstanceOf(NotFoundError); // 404
    expect(error.userTitle).toBe(
      'Esa atención no existe en las sedes a las que usted tiene acceso. Actualice la lista',
    );
  });

  it('EN-180 EN-181 EN-182 quitar un diagnóstico: 404 sin distinguir, 422 que pide el motivo, 409 que manda a anular el documento', () => {
    const missing = new DiagnosisNotFoundError();
    expect(missing.code).toBe('DIAGNOSIS_NOT_FOUND');
    expect(missing).toBeInstanceOf(NotFoundError);

    const reason = new DiagnosisRetractionReasonRequiredError();
    expect(reason.code).toBe('DIAGNOSIS_RETRACTION_REASON_REQUIRED');
    expect(reason).toBeInstanceOf(ValidationError);
    expect(reason.fieldErrors?.[0]?.field).toBe('reason');

    const cited = new DiagnosisCitedByIssuedDocumentError();
    expect(cited.code).toBe('DIAGNOSIS_CITED_BY_ISSUED_DOCUMENT');
    expect(cited).toBeInstanceOf(ConflictError);
    expect(cited.userTitle).toContain('Anule primero los exámenes');
  });

  it('EN-001 responde 409 y manda a registrar la ficha, no a corregir un campo', () => {
    const error = new PatientChartNotOpenError();

    expect(error.code).toBe('PATIENT_CHART_NOT_OPEN');
    expect(error).toBeInstanceOf(ConflictError); // 409
    expect(error.fieldErrors?.[0]?.field).toBe('patientId');
    expect(error.userTitle).toContain('Regístrelo en el fichero');
  });

  it('EN-004 responde 422 señalando la cita, sin decir de quién es', () => {
    const error = new EncounterAppointmentMismatchError();

    expect(error.code).toBe('ENCOUNTER_APPOINTMENT_MISMATCH');
    expect(error).toBeInstanceOf(BusinessRuleViolation); // 422
    expect(error.fieldErrors?.[0]?.field).toBe('agendaEntryId');
  });

  it('EN-005 responde 409 y ofrece abrir la atención sin cita', () => {
    const error = new AppointmentNotAttendableError();

    expect(error.code).toBe('APPOINTMENT_NOT_ATTENDABLE');
    expect(error).toBeInstanceOf(ConflictError); // 409
    expect(error.userTitle).toContain('Abra la atención sin cita');
  });

  it('EN-009 responde 422 nombrando los cuatro valores admitidos', () => {
    const error = new DischargeConditionRequiredError();

    expect(error.code).toBe('DISCHARGE_CONDITION_REQUIRED');
    expect(error).toBeInstanceOf(ValidationError); // 422
    expect(error.fieldErrors?.[0]?.message).toBe(
      'Valores admitidos: ALIVE, REFERRED, DECEASED, ABANDONED',
    );
  });

  it('EN-132 responde 409 con UN SOLO código para toda transición no admitida', () => {
    // Reopening a closed attention, skipping the discharge and suspending one
    // already discharged are the same fact — «desde donde está, eso no» — and
    // three codes would ask every client to enumerate a table it does not own.
    const codes = new Set(
      (
        [
          ['COMPLETED', 'OPEN'],
          ['OPEN', 'COMPLETED'],
          ['DISCHARGED', 'ON_HOLD'],
        ] as const
      ).map(([from, to]) => new InvalidEncounterTransitionError(from, to).code),
    );

    expect([...codes]).toEqual(['ENCOUNTER_STATE_TRANSITION_INVALID']);
  });

  it('EN-130 dice en qué estado está la atención al rechazar contenido nuevo', () => {
    const error = new EncounterAlreadyClosedError('COMPLETED');

    expect(error.code).toBe('ENCOUNTER_ALREADY_CLOSED');
    expect(error).toBeInstanceOf(ConflictError); // 409
    expect(error.userTitle).toContain('Cerrada');
    expect(error.userTitle).toContain('enmiende la nota');
  });

  it('EN-144 responde 403 y manda a pedírselo a quien firma, no a corregir un campo', () => {
    const error = new EncounterCloserNotAuthorError();

    expect(error.code).toBe('ENCOUNTER_CLOSER_NOT_AUTHOR');
    expect(error).toBeInstanceOf(ForbiddenError); // 403
    expect(error.fieldErrors).toBeUndefined();
  });

  it('EN-147 responde 422 por campo, porque lo que falta es una casilla', () => {
    const error = new SubstituteClosureReasonRequiredError();

    expect(error.code).toBe('SUBSTITUTE_CLOSURE_REASON_REQUIRED');
    expect(error).toBeInstanceOf(ValidationError); // 422
    expect(error.fieldErrors?.[0]?.field).toBe('substituteReason');
  });

  it('EN-029 responde 403 sin nombrar la fecha ni el número de registro', () => {
    const error = new PractitionerNotLicensedError();

    expect(error.code).toBe('PRACTITIONER_NOT_LICENSED');
    expect(error).toBeInstanceOf(ForbiddenError); // 403
    expect(error.params).toEqual({});
  });

  it('EN-061 responde 422 señalando el campo que sobra', () => {
    const error = new BmiIsDerivedError();

    expect(error.code).toBe('BMI_IS_DERIVED');
    expect(error).toBeInstanceOf(ValidationError); // 422
    expect(error.fieldErrors?.[0]?.field).toBe('bmi');
  });

  it('EN-063 responde 422 nombrando cada medida que falta', () => {
    const error = new VitalsRequiredError(['weightKg', 'heightCm']);

    expect(error.code).toBe('VITALS_REQUIRED');
    expect(error.fieldErrors?.map((field) => field.field)).toEqual([
      'weightKg',
      'heightCm',
    ]);
  });

  it('EN-021 responde 422 enumerando los formularios que sí existen', () => {
    const error = new UnknownClinicalFormError(['002@1', '005@1']);

    expect(error.code).toBe('UNKNOWN_CLINICAL_FORM');
    expect(error).toBeInstanceOf(ValidationError); // 422
    expect(error.params.admitted).toBe('002@1,005@1');
  });

  it('EN-020 responde 422 con la ruta de cada sección que falta', () => {
    const error = new NoteContentIncompleteError(['motivoConsulta']);

    expect(error.code).toBe('NOTE_CONTENT_INCOMPLETE');
    expect(error.fieldErrors?.[0]?.field).toBe('content.motivoConsulta');
  });

  it('EN-023 responde 409 diciendo que la nota está firmada, no que falten permisos', () => {
    /**
     * ⚠️ ES EL MOTIVO DE QUE ESTE ERROR EXISTA. El disparador levanta
     * `insufficient_privilege`, que a secas saldría como 403 y le diría al
     * médico que no tiene permisos cuando lo que pasa es que la nota está
     * firmada.
     */
    const error = new NoteAlreadySignedError();

    expect(error.code).toBe('NOTE_ALREADY_SIGNED');
    expect(error).toBeInstanceOf(ConflictError); // 409, nunca 403
    expect(error.userTitle).toContain('enmiéndela indicando el motivo');
  });

  it('EN-025 y EN-026 responden distinto a un borrador y a una versión sustituida', () => {
    // One code, two sentences: what to do about a draft is different from what
    // to do about a version somebody superseded.
    expect(new NoteNotAmendableError('DRAFT').userTitle).toContain('borrador');
    expect(new NoteNotAmendableError('SUPERSEDED').userTitle).toContain(
      'versión actual',
    );
    expect(new NoteNotAmendableError('ENTERED_IN_ERROR')).toBeInstanceOf(
      ConflictError,
    ); // 409
  });

  it('EN-022 responde 404 cuando la nota no está en esa atención', () => {
    const error = new ClinicalNoteNotFoundError();

    expect(error.code).toBe('CLINICAL_NOTE_NOT_FOUND');
    expect(error).toBeInstanceOf(NotFoundError); // 404
  });

  it('EN-040 y EN-050 responden 422 cuando el concepto es de otro catálogo', () => {
    /**
     * ⚠️ ES EL AGUJERO QUE LA CLAVE FORÁNEA DEJA ABIERTO. `concept_id` apunta
     * a `catalog_concept`, que guarda TODOS los catálogos, así que la clave
     * demuestra que la fila existe y nada sobre qué clase de cosa es: nada en
     * el esquema impide archivar una parroquia del DPA como enfermedad, y
     * `trg_diagnosis_snapshot` la aceptaría, porque el código congelado
     * coincide con el concepto perfectamente.
     */
    const asDiagnosis = new ConceptWrongCatalogueError('CIE10');
    const asProcedure = new ConceptWrongCatalogueError('TARIFF');

    expect(asDiagnosis.code).toBe('CONCEPT_WRONG_CATALOGUE');
    expect(asDiagnosis).toBeInstanceOf(ValidationError); // 422
    // Un solo código y dos frases: lo que hay que hacer es lo mismo —elegir de
    // la lista correcta— y dos códigos obligarían a cada cliente a modelar la
    // diferencia.
    expect(asDiagnosis.code).toBe(asProcedure.code);
    expect(asDiagnosis.userTitle).toContain('catálogo de diagnósticos');
    expect(asProcedure.userTitle).toContain('catálogo de prestaciones');
    expect(asDiagnosis.fieldErrors?.[0]?.field).toBe('conceptId');
  });

  it('EN-042 responde 422 sin nombrar el concepto que falló', () => {
    /**
     * El comentario de la migración lo dejó escrito: los mensajes de
     * disparador salen por el mapeo de errores, y un valor bajo control del
     * cliente ahí le permitía elegir qué error reportaba la API. La frase dice
     * qué hacer, nunca qué fila falló.
     */
    const error = new DiagnosisConceptNotInForceError();

    expect(error.code).toBe('DIAGNOSIS_CONCEPT_NOT_IN_FORCE');
    expect(error).toBeInstanceOf(ValidationError); // 422, no 409
    expect(error.params).toEqual({});
    expect(error.fieldErrors?.[0]?.field).toBe('conceptId');
  });

  it('EN-043 responde 409 al segundo diagnóstico principal, no 422', () => {
    /**
     * Nada de lo enviado está mal: ya hay un principal, y lo que toca decidir
     * es cuál de los dos lo es. Dos principales hacen que el reporte cuente la
     * misma consulta dos veces en dos causas de morbilidad distintas.
     */
    const error = new DiagnosisPrimaryTakenError();

    expect(error.code).toBe('DIAGNOSIS_PRIMARY_TAKEN');
    expect(error).toBeInstanceOf(ConflictError); // 409
    expect(error.fieldErrors?.[0]?.field).toBe('rank');
  });

  it('EN-011 responde 403 sin decir nada de la cuenta de quien pregunta', () => {
    const error = new PractitionerProfileRequiredError();

    expect(error.code).toBe('PRACTITIONER_PROFILE_REQUIRED');
    expect(error).toBeInstanceOf(ForbiddenError); // 403
    expect(error.params).toEqual({});
  });
});

describe('EN-166 la atención con actos vivos no se anula', () => {
  it('EN-166 nombra el certificado con la palabra de su pantalla, «sin anular», y es un 409', () => {
    const error = new EncounterHasLiveActsError({
      prescriptions: 0,
      orders: 0,
      signedNotes: 0,
      certificates: 1,
      referrals: 0,
      interconsultations: 0,
    });

    expect(error.code).toBe('ENCOUNTER_HAS_LIVE_ACTS');
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.userTitle).toContain('1 certificado(s) sin anular');
    expect(error.userTitle).not.toContain('revocar');
  });
});
