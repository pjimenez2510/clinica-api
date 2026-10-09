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
  ProgramBlockNotApplicableError,
  ProtectedSectionRequiredError,
  AllergyAlreadyRefutedError,
  AllergyNotRefutedError,
  AllergyRefutedAloneError,
  AmendmentReasonRequiredError,
  AnthropometryPendingError,
  ScreeningLockedAfterDischargeError,
  ScreeningPendingError,
  ReferralAlreadyCancelledError,
  ReferralNotFoundError,
  ReferralRequiredOnDischargeError,
  AppointmentNotAttendableError,
  BmiIsDerivedError,
  ChartHasAllergiesError,
  ClinicalNoteAlreadyOpenError,
  ClinicalNoteNotFoundError,
  ConceptWrongCatalogueError,
  DentalIndexNotApplicableError,
  DiagnosisConceptNotInForceError,
  DiagnosisCorrectionRequiresSignatureError,
  DiagnosisEditReasonRequiredError,
  DiagnosisLastAfterDischargeError,
  DiagnosisNotFoundError,
  DiagnosisNotRestorableError,
  ProcedureNotFoundError,
  ProcedureNotRestorableError,
  ProcedureRetractionReasonRequiredError,
  DiagnosisPrimaryRequiredAfterDischargeError,
  DiagnosisPrimaryTakenError,
  DiagnosisPrincipalUseInvalidError,
  DiagnosisRetractionReasonRequiredError,
  DiagnosisSupportsMaternityRestError,
  DischargeConditionRequiredError,
  EncounterAlreadyClosedError,
  EncounterAlreadyReportedError,
  EncounterAppointmentMismatchError,
  EncounterCloserNotAuthorError,
  EncounterHasLiveActsError,
  EncounterHasOthersDraftsError,
  EncounterNotFoundError,
  HistoryAlreadyRefutedError,
  HistoryNotRefutedError,
  InvalidEncounterTransitionError,
  NoKnownAllergiesNotStandingError,
  NoteAlreadySignedError,
  NoteContentIncompleteError,
  NoteNotAmendableError,
  NoteTemplateInvalidError,
  NoteTemplateStaleError,
  PatientAllergyNotFoundError,
  PatientChartNotOpenError,
  PatientHistoryNotFoundError,
  PractitionerNotLicensedError,
  PractitionerProfileRequiredError,
  RefutationReasonRequiredError,
  SubstituteClosureReasonRequiredError,
  UnknownClinicalFormError,
  VitalsCorrectionRequiresSignatureError,
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
  new AnthropometryPendingError(['heightCm']),
  new ScreeningPendingError(),
  new ScreeningLockedAfterDischargeError(),
  new ClinicalNoteNotFoundError(),
  new UnknownClinicalFormError(['002@1']),
  new NoteContentIncompleteError(['motivoConsulta']),
  new NoteAlreadySignedError(),
  new ClinicalNoteAlreadyOpenError(),
  new AmendmentReasonRequiredError(),
  new NoteNotAmendableError('SUPERSEDED'),
  new ConceptWrongCatalogueError('CIE10'),
  new ConceptWrongCatalogueError('TARIFF'),
  new DiagnosisConceptNotInForceError(),
  new DiagnosisPrimaryTakenError(),
  new DiagnosisNotFoundError(),
  new DiagnosisRetractionReasonRequiredError(),
  new DiagnosisEditReasonRequiredError(),
  new DiagnosisCorrectionRequiresSignatureError(),
  new DiagnosisSupportsMaternityRestError(),
  new EncounterAlreadyReportedError(),
  new DiagnosisNotRestorableError(),
  new ProcedureNotFoundError(),
  new ProcedureRetractionReasonRequiredError(),
  new ProcedureNotRestorableError(),
  // EN-080. La tercera cara de la misma negativa: el concepto es del CNMB o
  // no lo es, y la frase tiene que nombrar la lista que hay que abrir. Con un
  // ternario, «todo lo que no es CIE-10» decía «el tarifario», y una alergia
  // a la penicilina se contestaba con «búsquelo en el catálogo de
  // prestaciones».
  new ConceptWrongCatalogueError('CNMB'),
  new PatientAllergyNotFoundError(),
  new AllergyAlreadyRefutedError(),
  // EN-085. Los antecedentes, con el régimen de las alergias.
  new PatientHistoryNotFoundError(),
  new HistoryAlreadyRefutedError(),
  // EN-224, EN-226. Reactivar lo vigente y retirar lo que ya no está.
  new AllergyNotRefutedError(),
  new HistoryNotRefutedError(),
  new NoKnownAllergiesNotStandingError(),
  // D-140.1 y D-140.3. La de criticidad alta se descarta con motivo, y una a una.
  new RefutationReasonRequiredError(),
  new AllergyRefutedAloneError(),
  // EN-228. Tras el alta corrige la toma quien firma historia en la sede.
  new VitalsCorrectionRequiresSignatureError(),
  new ChartHasAllergiesError(),
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

  it('EN-188 tras el alta no se quita el último diagnóstico: 409 que dice por qué', () => {
    const last = new DiagnosisLastAfterDischargeError();
    expect(last.code).toBe('DIAGNOSIS_LAST_AFTER_DISCHARGE');
    expect(last).toBeInstanceOf(ConflictError);
    expect(last.userTitle).toContain('único diagnóstico');
  });

  it('EN-224 EN-225 lo descartado se reactiva antes de editarlo, y reactivar lo vigente responde 409', () => {
    const refuted = new AllergyAlreadyRefutedError();
    expect(refuted.code).toBe('ALLERGY_ALREADY_REFUTED');
    expect(refuted).toBeInstanceOf(ConflictError);
    expect(refuted.userTitle).toContain('reactívela');
    expect(new HistoryAlreadyRefutedError().userTitle).toContain('reactívelo');

    for (const [error, code] of [
      [new AllergyNotRefutedError(), 'ALLERGY_NOT_REFUTED'],
      [new HistoryNotRefutedError(), 'HISTORY_NOT_REFUTED'],
    ] as const) {
      expect(error.code).toBe(code);
      expect(error).toBeInstanceOf(ConflictError);
      expect(error.userTitle).toContain('Actualice la lista');
    }
  });

  it('EN-224 descartar una alergia de criticidad alta sin motivo responde 422 con el campo notes (D-140.1)', () => {
    const error = new RefutationReasonRequiredError();
    expect(error.code).toBe('REFUTATION_REASON_REQUIRED');
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.userTitle).toContain('criticidad alta');
    expect(error.fieldErrors).toEqual([
      expect.objectContaining({
        field: 'notes',
        code: 'REFUTATION_REASON_REQUIRED',
      }),
    ]);
  });

  it('EN-226 una alergia de criticidad alta no entra en el descarte en bloque: 409 que dice que se descarta sola (D-140.3)', () => {
    const error = new AllergyRefutedAloneError();
    expect(error.code).toBe('ALLERGY_REFUTED_ALONE');
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.userTitle).toContain('una a una');
  });

  it('EN-226 retirar lo que ya no está vigente responde 409, y afirmar con alergias activas sigue frenado', () => {
    const notStanding = new NoKnownAllergiesNotStandingError();
    expect(notStanding.code).toBe('NO_KNOWN_ALLERGIES_NOT_STANDING');
    expect(notStanding).toBeInstanceOf(ConflictError);
    expect(notStanding.userTitle).toContain('Actualice la ficha');

    const active = new ChartHasAllergiesError();
    expect(active.code).toBe('CHART_HAS_ALLERGIES');
    expect(active).toBeInstanceOf(ConflictError);
    expect(active.userTitle).toContain('Descártelas');
  });

  it('EN-228 corregir los signos tras el alta sin record:sign en la sede responde 403 que dice quién corrige', () => {
    const error = new VitalsCorrectionRequiresSignatureError();
    expect(error.code).toBe('VITALS_CORRECTION_REQUIRES_SIGNATURE');
    expect(error).toBeInstanceOf(ForbiddenError); // 403
    expect(error.userTitle).toBe(
      'La atención ya tiene el alta: corrige sus signos vitales quien firma historia clínica en esta sede',
    );
  });

  it('EN-244 EN-245 EN-246 el procedimiento ajeno es 404, quitar sin motivo 422 por campo y restaurar dos veces 409', () => {
    const missing = new ProcedureNotFoundError();
    expect(missing.code).toBe('PROCEDURE_NOT_FOUND');
    expect(missing).toBeInstanceOf(NotFoundError);
    const reason = new ProcedureRetractionReasonRequiredError();
    expect(reason.code).toBe('PROCEDURE_RETRACTION_REASON_REQUIRED');
    expect(reason).toBeInstanceOf(ValidationError);
    expect(reason.fieldErrors[0]?.field).toBe('reason');
    expect(reason.userTitle).toBe('Indique por qué quita el procedimiento');
    const twice = new ProcedureNotRestorableError();
    expect(twice.code).toBe('PROCEDURE_NOT_RESTORABLE');
    expect(twice).toBeInstanceOf(ConflictError);
    expect(twice.userTitle).toContain('Actualice la lista');
  });

  it('EN-213 «Deshacer» lo que ya se deshizo, o lo que ya volvió a registrarse: 409 que manda a actualizar', () => {
    const error = new DiagnosisNotRestorableError();
    expect(error.code).toBe('DIAGNOSIS_NOT_RESTORABLE');
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.userTitle).toContain('Actualice la lista');
  });

  it('EN-212 editar un diagnóstico: 422 que pide el motivo por campo, 403 a quien no firma tras el alta, 409 por el reposo o el reporte', () => {
    const reason = new DiagnosisEditReasonRequiredError();
    expect(reason.code).toBe('DIAGNOSIS_EDIT_REASON_REQUIRED');
    expect(reason).toBeInstanceOf(ValidationError);
    expect(reason.fieldErrors?.[0]?.field).toBe('reason');
    expect(reason.userTitle).toBe(
      'Indique por qué cambia el código: un certificado, una receta o una orden ya entregados lo imprimieron',
    );

    const signature = new DiagnosisCorrectionRequiresSignatureError();
    expect(signature.code).toBe('DIAGNOSIS_CORRECTION_REQUIRES_SIGNATURE');
    expect(signature).toBeInstanceOf(ForbiddenError);
    expect(signature.userTitle).toContain('quien firma historia clínica');

    const maternity = new DiagnosisSupportsMaternityRestError();
    expect(maternity.code).toBe('DIAGNOSIS_SUPPORTS_MATERNITY_REST');
    expect(maternity).toBeInstanceOf(ConflictError);
    expect(maternity.userTitle).toContain('anule primero el reposo');

    const reported = new EncounterAlreadyReportedError();
    expect(reported.code).toBe('ENCOUNTER_ALREADY_REPORTED');
    expect(reported).toBeInstanceOf(ConflictError);
    expect(reported.userTitle).toContain('RDACAA');
  });

  it('EN-180 EN-181 EN-214 quitar un diagnóstico: 404 sin distinguir, y 422 que pide el motivo cuando un papel entregado lo imprimió', () => {
    const missing = new DiagnosisNotFoundError();
    expect(missing.code).toBe('DIAGNOSIS_NOT_FOUND');
    expect(missing).toBeInstanceOf(NotFoundError);

    const reason = new DiagnosisRetractionReasonRequiredError();
    expect(reason.code).toBe('DIAGNOSIS_RETRACTION_REASON_REQUIRED');
    expect(reason).toBeInstanceOf(ValidationError);
    expect(reason.fieldErrors?.[0]?.field).toBe('reason');
    // EN-214: sólo un papel en manos de un tercero lo debe ya (D-126.3).
    expect(reason.userTitle).toBe(
      'Indique por qué quita el diagnóstico: un certificado, una receta o una orden ya entregados lo imprimieron',
    );
  });

  it('EN-240 dice que falta responder el tamizaje, con 422, y no dice nada del paciente', () => {
    const error = new ScreeningPendingError();

    expect(error.code).toBe('SCREENING_PENDING');
    expect(error).toBeInstanceOf(ValidationError); // 422
    expect(error.userTitle).toBe(
      'Falta responder el tamizaje de la atención: obligatorio para firmar el alta',
    );
    expect(error.fieldErrors).toEqual([
      {
        field: 'screening',
        code: 'SCREENING_PENDING',
        message: 'Responda el tamizaje: sin signos, no se aplicó o con signos',
      },
    ]);
  });

  it('EN-242 tras el alta sólo se completa la notificación: 409, sin repetir nada del tamizaje', () => {
    const error = new ScreeningLockedAfterDischargeError();

    expect(error.code).toBe('SCREENING_LOCKED_AFTER_DISCHARGE');
    expect(error).toBeInstanceOf(ConflictError); // 409
    expect(error.userTitle).toBe(
      'La atención ya tiene el alta: del tamizaje sólo se completa la notificación a la autoridad de un tamizaje con signos',
    );
  });

  it('EN-217 al firmar nombra cada medida que falta, porque la pantalla une los mensajes en una línea', () => {
    const error = new AnthropometryPendingError(['weightKg', 'heightCm']);

    expect(error.code).toBe('ANTHROPOMETRY_PENDING');
    expect(error).toBeInstanceOf(ValidationError); // 422
    expect(error.userTitle).toBe(
      'Falta peso/talla: obligatorio para firmar la nota',
    );
    expect(error.fieldErrors?.map((field) => field.message)).toEqual([
      'Peso: obligatorio para firmar la nota',
      'Talla: obligatorio para firmar la nota',
    ]);
  });

  it('EN-217 D-134.3 tras el alta dice que la corrección no puede quitar la medida, no que falta para firmar', () => {
    const error = new AnthropometryPendingError(
      ['weightKg'],
      'correctionAfterDischarge',
    );

    expect(error.code).toBe('ANTHROPOMETRY_PENDING');
    expect(error).toBeInstanceOf(ValidationError); // 422
    expect(error.userTitle).toBe(
      'La atención ya tiene el alta: la corrección no puede dejar sin peso/talla obligatorios',
    );
    expect(error.fieldErrors).toEqual([
      {
        field: 'weightKg',
        code: 'ANTHROPOMETRY_PENDING',
        message: 'Peso: obligatorio tras el alta, no se puede quitar',
      },
    ]);
  });

  it('EN-167 EN-218 un borrador ajeno responde 409 con la frase de cada acto: interrumpir y anular', () => {
    const interruption = new EncounterHasOthersDraftsError();
    const annulment = new EncounterHasOthersDraftsError('annulment');

    expect(interruption.code).toBe('ENCOUNTER_HAS_OTHERS_DRAFTS');
    expect(annulment.code).toBe('ENCOUNTER_HAS_OTHERS_DRAFTS');
    expect(annulment).toBeInstanceOf(ConflictError); // 409
    expect(interruption.userTitle).toBe(
      'La atención tiene una nota en borrador de otra persona. Que la firme o la descarte antes de interrumpir',
    );
    expect(annulment.userTitle).toBe(
      'La atención tiene una receta u orden en borrador de otro profesional. Que la emita o la descarte antes de anular',
    );
  });

  it('EN-183 EN-188 tras el alta, desmarcar o quitar el principal responde 409 y manda a marcar otro', () => {
    const error = new DiagnosisPrimaryRequiredAfterDischargeError();

    expect(error.code).toBe('DIAGNOSIS_PRIMARY_REQUIRED_AFTER_DISCHARGE');
    expect(error).toBeInstanceOf(ConflictError); // 409
    expect(error.userTitle).toBe(
      'La atención ya tiene el alta y necesita un diagnóstico principal: marque otro como principal antes de quitar o desmarcar éste',
    );
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

  it('EN-217 responde 422 nombrando cada medida que falta', () => {
    const error = new AnthropometryPendingError(['weightKg', 'heightCm']);

    expect(error.code).toBe('ANTHROPOMETRY_PENDING');
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

  it('EN-201 responde 422 nombrando la sección de la plantilla que no se puede publicar', () => {
    const error = new NoteTemplateInvalidError(
      'sections.2.required',
      '«Examen físico regional» es parte del contenido mínimo',
    );

    expect(error.code).toBe('NOTE_TEMPLATE_INVALID');
    expect(error).toBeInstanceOf(ValidationError); // 422
    expect(error.fieldErrors?.[0]?.field).toBe('sections.2.required');
  });

  it('EN-200 responde 409 cuando otra persona publicó la plantilla mientras se editaba', () => {
    const error = new NoteTemplateStaleError(3, 4);

    expect(error.code).toBe('NOTE_TEMPLATE_STALE');
    expect(error).toBeInstanceOf(ConflictError); // 409
    expect(error.params).toMatchObject({ expected: '3', current: '4' });
  });

  it('EN-205 responde 422 diciendo que se elija una opción de la lista', () => {
    const error = new NoteContentIncompleteError([], ['extra1']);

    expect(error.fieldErrors?.[0]).toMatchObject({
      field: 'content.extra1',
      message: 'Elija una de las opciones de la lista',
    });
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

  it('EN-229 abrir una segunda nota de consulta es un 409 que dice qué hacer', () => {
    const error = new ClinicalNoteAlreadyOpenError();

    expect(error.code).toBe('CLINICAL_NOTE_ALREADY_OPEN');
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.userTitle).toBe(
      'Esta atención ya tiene su nota de consulta. Ábrala para seguir escribiendo o enmendarla',
    );
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
  it('EN-166 EN-218 nombra cada papel emitido con su número y lo que hay que hacer, y es un 409', () => {
    const error = new EncounterHasLiveActsError([
      { kind: 'certificates', id: 'c-1', number: 7 },
      { kind: 'prescriptions', id: 'p-1', number: 12 },
      { kind: 'signedNotes', id: 'n-1', number: null },
    ]);

    expect(error.code).toBe('ENCOUNTER_HAS_LIVE_ACTS');
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.userTitle).toContain('el certificado N.º 7');
    expect(error.userTitle).toContain('la receta N.º 12');
    expect(error.userTitle).not.toContain('revocar');
    // Each paper travels by itself, so the screen offers its own «Anular».
    expect(error.fieldErrors).toEqual([
      { field: 'acts.certificates.c-1', code: 'ENCOUNTER_HAS_LIVE_ACTS', message: 'Certificado N.º 7 sin anular' }, // prettier-ignore
      { field: 'acts.prescriptions.p-1', code: 'ENCOUNTER_HAS_LIVE_ACTS', message: 'Receta N.º 12 emitida' }, // prettier-ignore
      { field: 'acts.signedNotes.n-1', code: 'ENCOUNTER_HAS_LIVE_ACTS', message: 'Nota firmada' }, // prettier-ignore
    ]);
    // Counts only in the params: no patient, no drug reaches a log.
    expect(error.params).toMatchObject({ certificates: 1, prescriptions: 1 });
  });

  it('EN-052 responde 422 con su código, en el catálogo, y dice qué índice lleva cada edad', () => {
    const error = new DentalIndexNotApplicableError();

    expect(error.code).toBe('DENTAL_INDEX_NOT_APPLICABLE');
    expect(error).toBeInstanceOf(BusinessRuleViolation); // 422
    expect(DOMAIN_ERROR_CODES).toContain(error.code);
    expect(error.userTitle).toBe(
      'Esta atención no lleva ese índice odontológico: sólo en odontología, el CEO-D con más de 6 meses y menos de 11 años, y el CPO-D desde los 12 años',
    );
  });

  it('EN-235 responde 422, en el catálogo, con la frase en conceptId', () => {
    const error = new DiagnosisPrincipalUseInvalidError();

    expect(error.code).toBe('DIAGNOSIS_PRINCIPAL_USE_INVALID');
    expect(error).toBeInstanceOf(ValidationError); // 422
    expect(DOMAIN_ERROR_CODES).toContain(error.code);
    expect(error.fieldErrors).toEqual([
      {
        field: 'conceptId',
        code: 'DIAGNOSIS_PRINCIPAL_USE_INVALID',
        message: 'Registre primero la enfermedad o la lesión',
      },
    ]);
  });
});

describe('los errores de la referencia (EN-105, EN-107)', () => {
  it('EN-105 el alta «Referido» sin referencia: 422 sobre la condición de egreso, diciendo dónde emitirla', () => {
    const error = new ReferralRequiredOnDischargeError();

    expect(error.code).toBe('REFERRAL_REQUIRED_ON_DISCHARGE');
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.userTitle).toBe(
      'Para dar el alta como «Referido» emita antes la referencia en la pestaña Referencia',
    );
    expect(error.fieldErrors).toEqual([
      {
        field: 'dischargeCondition',
        code: 'REFERRAL_REQUIRED_ON_DISCHARGE',
        message:
          'Emita la referencia, la derivación o la referencia inversa antes de firmar con «Referido»',
      },
    ]);
  });

  it('EN-107 la referencia de otra atención es 404 y anular lo anulado es 409', () => {
    const missing = new ReferralNotFoundError();
    expect(missing.code).toBe('REFERRAL_NOT_FOUND');
    expect(missing).toBeInstanceOf(NotFoundError);
    expect(missing.userTitle).toBe(
      'Esa referencia o interconsulta no existe en esta atención. Actualice la pantalla',
    );

    const twice = new ReferralAlreadyCancelledError();
    expect(twice.code).toBe('REFERRAL_ALREADY_CANCELLED');
    expect(twice).toBeInstanceOf(ConflictError);
    expect(twice.userTitle).toBe('Ya estaba anulada. Actualice la pantalla');
  });
});

describe('los bloques de programa (EN-090, EN-092, EN-093)', () => {
  it('EN-090 EN-092 responde 422 con su código, en el catálogo, y dice por qué no corresponde cada bloque', () => {
    const obstetric = new ProgramBlockNotApplicableError('OBSTETRIC');
    const nutrition = new ProgramBlockNotApplicableError('NUTRITION');

    expect(obstetric.code).toBe('PROGRAM_BLOCK_NOT_APPLICABLE');
    expect(obstetric).toBeInstanceOf(BusinessRuleViolation); // 422
    expect(DOMAIN_ERROR_CODES).toContain(obstetric.code);
    expect(obstetric.userTitle).toBe(
      'Esta atención no lleva datos obstétricos: la ficha no registra el embarazo en la fecha de la atención',
    );
    expect(nutrition.userTitle).toBe(
      'Esta atención no lleva datos de lactancia: sólo se registran hasta los 8 meses de edad, con la pregunta de su edad',
    );
  });

  it('EN-093 responde 403 con su código, en el catálogo, y nombra la sección y no el dato', () => {
    const error = new ProtectedSectionRequiredError();

    expect(error.code).toBe('PROTECTED_SECTION_REQUIRED');
    expect(error).toBeInstanceOf(ForbiddenError); // 403
    expect(DOMAIN_ERROR_CODES).toContain(error.code);
    expect(error.userTitle).toBe(
      'Registrar el grupo de riesgo de esta vacuna requiere el permiso de la sección de acceso restringido',
    );
    expect(error.userTitle).not.toMatch(/VIH|sexual/i);
  });
});
