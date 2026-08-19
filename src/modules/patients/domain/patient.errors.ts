import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../shared/domain/errors/domain-error';

/**
 * What can go wrong with a patient record, in business terms.
 *
 * No HTTP here. The mapping to a status lives in `shared/http/problem-details`,
 * which is what lets these same rules run from a queue worker or a CLI import
 * where "404" means nothing.
 */

export class PatientNotFoundError extends NotFoundError {
  readonly code = 'PATIENT_NOT_FOUND';
  /**
   * The same message whether the record does not exist or the caller may not
   * see it.
   *
   * Distinguishing them turns the endpoint into an oracle: try identifiers
   * until one answers differently, and you have learned who is a patient here.
   * That is exactly the kind of leak the LOPDP exists to prevent.
   */
  override readonly userTitle = 'No se encontró el paciente';

  /**
   * `field` names the request field that carried the id, when there is one.
   *
   * PA-009 needs it: `motherPatientId` points at a chart that has to exist,
   * and answering «no se encontró el paciente» with no field on a form that
   * also names the patient being corrected leaves the desk unable to tell
   * WHICH of the two is missing. Absent for `GET /patients/:id`, where the id
   * came from the URL and there is no field to blame.
   */
  constructor(field?: string) {
    super(
      'Patient does not exist or is not visible to the caller',
      {},
      field === undefined
        ? undefined
        : [
            {
              field,
              code: 'PATIENT_NOT_FOUND',
              message: 'No se encontró esa historia: búsquela otra vez',
            },
          ],
    );
  }
}

/**
 * The record was merged into another after a duplicate was resolved.
 *
 * DECLARED IN `shared/domain/errors/patient-merged.error.ts` and re-exported
 * here, so this module keeps naming it where the rest of its errors live. It
 * moved because the agenda has to refuse a booking for a merged chart (AG-027)
 * and no module may import another; two classes declaring `PATIENT_MERGED`
 * would be two situations a client cannot tell apart, which the error
 * catalogue refuses outright.
 */
export { PatientMergedError } from '../../../shared/domain/errors/patient-merged.error';

/**
 * PA-027. The chart declares a nationality or indigenous people and does not
 * identify as «Indígena».
 *
 * ENFORCED IN THE SERVICE AND NOT ONLY IN THE DTO, for the same reason
 * `CANCELLATION_REASON_REQUIRED` and `MERGE_REASON_REQUIRED` are: a `DEBERÁ`
 * enforced only by the transport layer stops being enforced the day another use
 * case calls from inside. The database CANNOT repeat it as a `CHECK` — which
 * ethnicity is «Indígena» lives in another table — so this is the whole
 * guarantee; see `indigenous-nationality.ts`.
 *
 * ⚠️ THE MESSAGE NAMES NO DATUM OF THE PATIENT. It says what to do — pick the
 * ethnicity or clear the field — and never which people or which category was
 * sent: an error text ends up in support screenshots and in logs.
 */
export class NationalityRequiresIndigenousEthnicityError extends ValidationError {
  readonly code = 'NATIONALITY_REQUIRES_INDIGENOUS_ETHNICITY';
  override readonly userTitle =
    'La nacionalidad o pueblo indígena sólo se registra si la autoidentificación étnica es «Indígena»';
  /**
   * IT POINTS AT `nationalityConceptId` AND NOT AT THE ETHNICITY, on purpose.
   *
   * Two fields are involved and only one can be blamed. The nationality is the
   * one the RDACAA treats as conditional — it is the field that gets enabled —
   * so it is the one whose value has to give way, and the message offers both
   * ways out of the contradiction.
   */
  constructor() {
    super(
      'Nationality or indigenous people requires an indigenous ethnic self-identification',
      {},
      [
        {
          field: 'nationalityConceptId',
          code: 'NATIONALITY_REQUIRES_INDIGENOUS_ETHNICITY',
          message: 'Elija «Indígena» en la autoidentificación étnica, o deje vacía la nacionalidad', // prettier-ignore
        },
      ],
    );
  }
}

/**
 * PA-056. The chart declares a people and its indigenous nationality is not
 * «Kichwa».
 *
 * THE SAME SHAPE AS `NationalityRequiresIndigenousEthnicityError` ONE STEP
 * FURTHER ALONG THE CHAIN, and deliberately so: ethnicity → indigenous
 * nationality → people is one rule written three times over three columns of
 * the same form. Enforced in the service and not only in the DTO, and NOT a
 * `CHECK` — which nationality is «Kichwa» lives in another table; see
 * `indigenous-people.ts`.
 *
 * ⚠️ THE MESSAGE NAMES NO DATUM OF THE PATIENT. It says what to do — pick the
 * Kichwa nationality or clear the field — and never which people or which
 * nationality was sent: an error text ends up in support screenshots and logs.
 */
export class PeopleRequiresKichwaNationalityError extends ValidationError {
  readonly code = 'PEOPLE_REQUIRES_KICHWA_NATIONALITY';
  override readonly userTitle =
    'El pueblo sólo se registra si la nacionalidad indígena es «Kichwa»';
  /**
   * IT POINTS AT `peopleConceptId` AND NOT AT THE NATIONALITY, on purpose.
   *
   * Two fields are involved and only one can be blamed. The people is the one
   * the RDACAA treats as conditional — it is the field that gets enabled — so
   * it is the one whose value has to give way, and the message offers both ways
   * out of the contradiction. Same reasoning as PA-027 one step up.
   */
  constructor() {
    super(
      'An indigenous people requires the Kichwa indigenous nationality',
      {},
      [
        {
          field: 'peopleConceptId',
          code: 'PEOPLE_REQUIRES_KICHWA_NATIONALITY',
          message: 'Elija «Kichwa» en la nacionalidad indígena, o deje vacío el pueblo', // prettier-ignore
        },
      ],
    );
  }
}

/**
 * PA-059. The chart declares an ethnic self-identification and a country of
 * nationality other than Ecuador.
 *
 * ⚠️ THE ONE OF THE THREE THAT GETS TYPED BY ACCIDENT, AND THAT IS WHY THE
 * MESSAGE MATTERS MORE HERE. PA-027's contradiction is unreachable from a
 * well-built form — choosing «Mestizo/a» switches the nationality selector off
 * in front of the person typing. This one is not: the country is chosen among
 * the identity fields and the ethnicity among the RDACAA ones, half a form
 * apart, so the desk reaches it without noticing. The text therefore says WHAT
 * TO DO and offers BOTH ways out, rather than describing what failed.
 *
 * Enforced in the service and not only in the DTO, for the same reason as its
 * two siblings. Not a `CHECK` either, and there the reason differs — see
 * `ecuadorian-ethnicity.ts`.
 */
export class EthnicityRequiresEcuadorianNationalityError extends ValidationError {
  readonly code = 'ETHNICITY_REQUIRES_ECUADORIAN_NATIONALITY';
  override readonly userTitle =
    'La autoidentificación étnica sólo se registra si la nacionalidad es ecuatoriana';
  /**
   * IT POINTS AT `ethnicityConceptId` AND NOT AT THE COUNTRY.
   *
   * The ethnicity is the conditional one — the instructivo says to leave
   * columns 12 to 14 blank for a foreign patient, never to change the country —
   * so it is its value that has to give way. The message still names the other
   * way out, because on this pairing the country is quite often the field that
   * is actually wrong.
   */
  constructor() {
    super('An ethnic self-identification requires Ecuadorian nationality', {}, [
      {
        field: 'ethnicityConceptId',
        code: 'ETHNICITY_REQUIRES_ECUADORIAN_NATIONALITY',
        message: 'Deje vacía la autoidentificación étnica, o corrija el país de nacionalidad a Ecuador', // prettier-ignore
      },
    ]);
  }
}

/**
 * PA-057. The chart declares a sexual orientation and the patient is under the
 * age from which the ministry's form asks the question.
 *
 * ⚠️ THE MESSAGE SAYS THE AGE AND NOTHING ABOUT THE PATIENT. «Diez años» is
 * the ministry's threshold and is public; the patient's own birth date is not,
 * and an error text ends up in support screenshots and logs (PA-025).
 *
 * ⚠️ AND IT DOES NOT NAME THE VALUE THAT WAS SENT — which on this field is
 * special category data under the LOPDP. An error that echoed «Bisexual» back
 * would put it in every log line and every screenshot, defeating the whole
 * point of PA-058's separate door.
 */
export class SexualOrientationBelowMinimumAgeError extends ValidationError {
  readonly code = 'SEXUAL_ORIENTATION_BELOW_MINIMUM_AGE';
  override readonly userTitle =
    'La orientación sexual sólo se registra desde los 10 años de edad';
  constructor() {
    super(
      'Sexual orientation applies from the ministry minimum age onwards',
      {},
      [
        {
          field: 'sexualOrientationConceptId',
          code: 'SEXUAL_ORIENTATION_BELOW_MINIMUM_AGE',
          message: 'Deje vacía la orientación sexual, o revise la fecha de nacimiento', // prettier-ignore
        },
      ],
    );
  }
}

export class DuplicateIdentifierError extends ConflictError {
  readonly code = 'PATIENT_IDENTIFIER_TAKEN';
  override readonly userTitle =
    'Ya existe un paciente registrado con ese documento';
  constructor() {
    super('Another patient already holds this identifier');
  }
}

// ---------------------------------------------------------------------------
// Duplicate resolution (P4: PA-043 to PA-049, REQ-010)
// ---------------------------------------------------------------------------

/**
 * PA-044, PA-047. Merging and undoing a merge both demand a reason.
 *
 * ENFORCED IN THE SERVICE AND NOT ONLY IN THE DTO, for the same reason
 * `CANCELLATION_REASON_REQUIRED` is: a `DEBERÁ` enforced only by the transport
 * layer stops being enforced the day another use case calls from inside. The
 * database repeats it as `patient_merge_reason_not_blank`, which is what also
 * stops an import — but that CHECK answers with a generic 422, and this is the
 * message that lands on the field somebody has to fill in.
 *
 * BLANK IS NOT A REASON. `NOT NULL` refuses the absence, never `'   '`, and a
 * mandatory reason is the whole of what tells this apart from a click.
 */
export class MergeReasonRequiredError extends ValidationError {
  readonly code = 'MERGE_REASON_REQUIRED';
  override readonly userTitle = 'Escriba por qué se unen las dos historias';
  constructor() {
    super('A merge and an undo both require a non-blank reason', {}, [
      {
        field: 'reason',
        code: 'MERGE_REASON_REQUIRED',
        message: 'Explique por qué: quedará en el rastro de la fusión', // prettier-ignore
      },
    ]);
  }
}

/**
 * PA-046. The chart being absorbed and the surviving one are the same.
 *
 * A chart merged into itself is, for PA-045, a chart that refuses every
 * operation and points at itself: nobody could open it or undo it from the
 * application. `patient_merged_into_not_self` refuses the row as well — which
 * is what stops an import — and this is what a form gets told.
 */
export class MergeIntoSelfError extends ValidationError {
  readonly code = 'MERGE_INTO_SELF';
  override readonly userTitle = 'Esa es la misma historia: elija la otra ficha';
  constructor() {
    super('A chart cannot be merged into itself', {}, [
      {
        field: 'targetPatientId',
        code: 'MERGE_INTO_SELF',
        message: 'Elija la historia que debe quedar vigente, que no es ésta',
      },
    ]);
  }
}

/**
 * PA-046. The merge would build a chain, in either direction.
 *
 * TWO SITUATIONS AND ONE CODE, because what the desk has to do is the same in
 * both — undo the other merge first — and the `errors[]` entry names which
 * chart is the problem:
 *
 *   - the TARGET is itself merged: A→B when B→C, so the survivor is not the
 *     one being chosen;
 *   - the SOURCE has already absorbed other charts: B→C when A→B, which is the
 *     same chain from the other end.
 *
 * «Se resuelve prohibiéndola, no siguiéndola»: a chain forces every reader in
 * every module to walk it, and the first one that does not will show the wrong
 * chart. It is 409 and not 422 because what was sent is correct — it is the
 * state of the register that refuses it, and undoing the other merge makes the
 * very same request work.
 *
 * ⚠️ THE GUARANTEE IS `trg_patient_merge_not_chained`, NOT THIS CLASS. The
 * trigger locks the target row, so two simultaneous merges cannot build a chain
 * between them; this is the translation of its rejection into something a
 * person can act on. The surviving MRN is looked up only on that path.
 */
export class PatientAlreadyMergedError extends ConflictError {
  readonly code = 'PATIENT_ALREADY_MERGED';
  override readonly userTitle =
    'Esa historia ya está unida a otra. Deshaga esa fusión antes de hacer ésta';

  /**
   * @param field which chart of the request is the one already merged.
   * @param survivingMrn where that chart's history is now, when it is known.
   *   Only an MRN travels: an internal number, never a name or a document.
   */
  constructor(
    field: 'patientId' | 'targetPatientId',
    readonly survivingMrn: string | null = null,
  ) {
    super(
      'Merging these charts would chain one merge onto another',
      survivingMrn === null ? {} : { mrn: survivingMrn },
      [
        {
          field,
          code: 'PATIENT_ALREADY_MERGED',
          message:
            survivingMrn === null
              ? 'Esa historia ya participó en otra fusión: deshágala primero'
              : `Esa historia ya se unió a ${survivingMrn}: deshaga esa fusión primero`,
        },
      ],
    );
  }
}

/**
 * PA-047. There is no merge to undo on this chart.
 *
 * NOT `PATIENT_NOT_FOUND`, and the difference matters at the desk: the patient
 * exists and is on the screen. What does not exist is the EVENT — the chart was
 * never merged, or its merge was already undone, which the unique link
 * `patient_merge_undone_once` makes a lookup rather than a guess. Same shape as
 * `AGENDA_ENTRY_NOT_FOUND`.
 */
export class MergeNotFoundError extends NotFoundError {
  readonly code = 'MERGE_NOT_FOUND';
  override readonly userTitle = 'Esta historia no tiene ninguna fusión que deshacer'; // prettier-ignore
  constructor() {
    super('No merge of this chart is open to be undone');
  }
}

/**
 * How each kind of document is called in the sentence a person reads.
 *
 * THE CLASS OF DOCUMENT, NEVER ITS VALUE. «Cédula» says which field to look at;
 * the number itself is exactly what must not appear in an error, a log or a
 * support screenshot (PA-025, REQ-116, SC-006).
 *
 * `PROVISIONAL` is here for completeness and cannot actually reach the message:
 * `patient_identifier_active_unique` excludes it from the index, so a
 * placeholder never conflicts with anything.
 */
const IDENTIFIER_LABEL: Readonly<Record<string, string>> = {
  CEDULA: 'la cédula',
  PASSPORT: 'el pasaporte',
  REFUGEE_CARD: 'el carné de refugiado',
  FOREIGN_ID: 'el documento de identidad extranjero',
  PROVISIONAL: 'el documento provisional',
};

/**
 * PA-048. Undoing would give the chart back a document another live chart has
 * taken in the meantime.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS CANNOT COME OUT OF THE CONSTRAINT MAP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PostgreSQL refuses through `patient_identifier_active_unique` — the SAME
 * partial index a duplicate registration hits — because undoing puts the
 * absorbed chart's documents back into it. `patients.constraints.ts` maps that
 * index to `DUPLICATE_IDENTIFIER`, which is right for a registration and wrong
 * here: it tells whoever pressed «deshacer» that the document they just typed
 * is taken, and they typed none. The map cannot tell the two apart, because
 * only the caller knows the operation was an undo — so the merge service is
 * what translates it.
 *
 * IT IS NOT A DEFECT THAT IT FAILS. This is the technical consequence of
 * PA-014: two live charts cannot hold one document, and SC-008 says that number
 * is zero without exception. What PA-048 also demands is that nothing be left
 * half-undone, and that is the transaction's job — the chart stays merged, whole
 * or not at all.
 *
 * ⚠️ WHAT THE MESSAGE MAY SAY. The CLASS of document and the MRN that holds it
 * now — an internal number, the same one `PATIENT_MERGED` publishes. Never the
 * document's value, never a name.
 */
export class MergeUndoConflictError extends ConflictError {
  readonly code = 'MERGE_UNDO_CONFLICT';
  override readonly userTitle =
    'No se puede deshacer: otra historia tiene ahora ese documento';

  constructor(
    readonly identifierType: string,
    readonly holderMrn: string,
  ) {
    const label = IDENTIFIER_LABEL[identifierType] ?? 'ese documento';
    super(
      `Undoing the merge would return an identifier already held by ${holderMrn}`,
      { identifierType, mrn: holderMrn },
      [
        {
          // The chart being un-merged: it is the one whose document cannot come
          // back, and the URL is where it was named.
          field: 'patientId',
          code: 'MERGE_UNDO_CONFLICT',
          message: `La historia ${holderMrn} tiene ahora ${label} de esta ficha: corríjala allí antes de deshacer la fusión`,
        },
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Priority groups (P3, REQ-024, D-026, D-027)
// ---------------------------------------------------------------------------

/**
 * PA-035. Somebody tried to store a group that is derived from the birth date.
 *
 * Refused in the DOMAIN and not only in the DTO, for the same reason
 * `CANCELLATION_REASON_REQUIRED` is: a `DEBERÁ` enforced only by the transport
 * layer stops being enforced the day another use case calls from inside. The
 * database repeats it as a CHECK, which is what also stops an import.
 */
export class PriorityGroupNotRecordableError extends ValidationError {
  readonly code = 'PRIORITY_GROUP_NOT_RECORDABLE';
  override readonly userTitle =
    'La edad no se registra: el sistema la calcula de la fecha de nacimiento';
  constructor(group: string) {
    super(`Priority group ${group} is derived from the birth date`, { group }, [
      {
        field: 'group',
        code: 'PRIORITY_GROUP_NOT_RECORDABLE',
        message:
          'Ese grupo se deduce de la fecha de nacimiento y no se registra a mano',
      },
    ]);
  }
}

/**
 * PA-036. The period does not hold up: it ends before it starts, or it is a
 * pregnancy with no expected date of delivery and no end date.
 *
 * A pregnancy without an end is the boolean column this design exists to
 * avoid — it would keep ordering the waiting list for ever.
 */
export class PriorityGroupPeriodInvalidError extends ValidationError {
  readonly code = 'PRIORITY_GROUP_PERIOD_INVALID';
  override readonly userTitle = 'Revise las fechas de vigencia del grupo';
  constructor(field: 'endsOn' | 'startsOn', message: string) {
    super('Priority group period is not coherent', {}, [
      { field, code: 'PRIORITY_GROUP_PERIOD_INVALID', message },
    ]);
  }
}

/** PA-038. Declared «acreditado» without saying with which document. */
export class PriorityGroupEvidenceRequiredError extends ValidationError {
  readonly code = 'PRIORITY_GROUP_EVIDENCE_REQUIRED';
  override readonly userTitle = 'Indique con qué documento se acredita';
  constructor() {
    super('An accredited priority group must name its document', {}, [
      {
        field: 'evidenceDocument',
        code: 'PRIORITY_GROUP_EVIDENCE_REQUIRED',
        message: 'Escriba el documento que lo acredita, o márquelo como declarado por el paciente', // prettier-ignore
      },
    ]);
  }
}

/**
 * D-027. Writing one of the second-sentence groups without
 * `patient:priority:protected`.
 *
 * ⚠️ ONLY ON WRITING. Reading OMITS those rows instead of refusing, and the
 * difference is deliberate: a refusal on a read would itself confirm that such
 * a row exists for this person, which is the oracle PA-024 refuses to be for
 * the register as a whole. Here the caller named the group themselves, so
 * saying no reveals nothing they did not already type.
 */
export class RestrictedPriorityGroupError extends ForbiddenError {
  readonly code = 'PRIORITY_GROUP_RESTRICTED';
  override readonly userTitle =
    'No tiene permiso para registrar este grupo. Pídalo a quien administra el sistema';
  constructor(group: string) {
    super(`Priority group ${group} needs patient:priority:protected`, {
      group,
    });
  }
}

/**
 * The record does not exist, belongs to another patient, or is one the caller
 * may not see.
 *
 * THE SAME ANSWER FOR THE THREE, like `PATIENT_NOT_FOUND`. Distinguishing
 * «existe pero no puede verlo» from «no existe» would let anybody with
 * `patient:priority` learn that a restricted row exists by trying identifiers.
 */
export class PriorityGroupNotFoundError extends NotFoundError {
  readonly code = 'PRIORITY_GROUP_NOT_FOUND';
  override readonly userTitle = 'No se encontró ese registro de grupo prioritario'; // prettier-ignore
  constructor() {
    super('Priority group record does not exist or is not visible');
  }
}
