import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type DomainFieldError,
} from '../../../shared/domain/errors/domain-error';
import type { PrescriptionStatus } from './prescription';

/**
 * What can go wrong when a prescription is written or issued, in business terms.
 *
 * No HTTP here: the CATEGORY decides the status in `problem-details.filter.ts`
 * — which is what lets these same rules run from an import script or a worker,
 * where «409» means nothing.
 *
 * ⚠️ NOT ONE OF THESE MESSAGES NAMES THE PATIENT OR THE MEDICINE (PR-094,
 * SC-036). And the second half is the one that is easy to get wrong: a drug
 * name IS a diagnosis said differently — metformin says diabetes, efavirenz
 * says HIV. These sentences reach logs and support screenshots, so they speak
 * of FIELDS and of LINE NUMBERS.
 *
 * ⚠️ AND SEVERAL OF THEM DELIBERATELY DO NOT REUSE A CODE THAT ALREADY EXISTS.
 * `ENCOUNTER_NOT_FOUND`, `ENCOUNTER_ALREADY_CLOSED`, `CONCEPT_WRONG_CATALOGUE`,
 * `PRACTITIONER_PROFILE_REQUIRED` and `PRACTITIONER_NOT_LICENSED` all live in
 * `encounter` and say something close to what four of these say. They are not
 * reused, and it is not an oversight: no module imports another (CLAUDE.md §3),
 * and `error-catalogue.spec.ts` fails when two classes declare the same `code`
 * — a client branches on the code, so two situations answering one code is two
 * things it cannot tell apart. Each class below states what its own rule is and
 * where it differs from its neighbour.
 */

/** The Spanish label of each state, as the SCREEN names it. */
const STATUS_LABEL: Readonly<Record<PrescriptionStatus, string>> = {
  DRAFT: 'En borrador',
  ACTIVE: 'Emitida',
  COMPLETED: 'Dispensada',
  CANCELLED: 'Anulada',
  DISCARDED: 'Descartada',
};

/**
 * What can still be done from each state, in the words the screen uses.
 *
 * ⚠️ A DRAFT IS NOT ANNULLED — IT IS DISCARDED, and the two are different
 * acts rather than two words for one.
 *
 * Annulling is an act on an EMITTED prescription, which is what art. 70
 * describes: the custodian annuls the receta that was lost, altered or must
 * not be dispensed. There is a paper in somebody's hand. A wrong draft never
 * left the room, so there is no legal act to undo — but it still needs a way
 * out, and until `20260820...prescription_discarded_draft` it had none: the
 * schema demanded an issue instant for every state but `DRAFT`, so a mistyped
 * draft could be neither issued, nor annulled, nor deleted, and stayed in the
 * chart looking like medication the patient takes.
 */
const WHAT_TO_DO: Readonly<Record<PrescriptionStatus, string>> = {
  DRAFT: 'puede emitirse o descartarse',
  ACTIVE: 'puede anularse',
  COMPLETED: 'ya no admite ningún cambio',
  CANCELLED: 'ya no admite ningún cambio',
  DISCARDED: 'ya no admite ningún cambio',
};

/**
 * PR-006. The prescription does not exist — or belongs to a site outside the
 * caller's scope.
 *
 * ONE ANSWER FOR BOTH, and it is the requirement rather than a convenience:
 * telling them apart would confirm prescriptions of other sites to whoever
 * guesses identifiers, one at a time. It is also art. 10 made into a refusal —
 * «en ningún caso pueden ser utilizadas en otros establecimientos de salud».
 */
export class PrescriptionNotFoundError extends NotFoundError {
  readonly code = 'PRESCRIPTION_NOT_FOUND';
  override readonly userTitle =
    'Esa receta no existe en las sedes a las que usted tiene acceso. Actualice la lista';

  constructor() {
    super('Prescription not found within the caller site scope');
  }
}

/**
 * PR-001. The attention the prescription would hang off does not exist, or is
 * of another site.
 *
 * ⚠️ A CODE OF ITS OWN AND NOT `ENCOUNTER_NOT_FOUND`. That class belongs to
 * `encounter`, no module imports another, and two classes may not share a code.
 * The sentence differs too: there the caller was trying to read an attention,
 * here they were trying to prescribe on one, and what they do next is open it.
 */
export class PrescriptionEncounterNotFoundError extends NotFoundError {
  readonly code = 'PRESCRIPTION_ENCOUNTER_NOT_FOUND';
  override readonly userTitle =
    'No hay una atención suya con ese identificador. Abra la atención antes de recetar';

  constructor() {
    super('Encounter not found within the caller site scope');
  }
}

/**
 * PR-002. The attention no longer admits new clinical content.
 *
 * 409 AND NOT 403: nobody lacks a permission — the act finished. The way out is
 * a NEW attention, which is not a workaround: «tantas consultas como atenciones
 * médicas recibidas» is the ministry's own rule (EN-006).
 *
 * ⚠️ A CODE OF ITS OWN AND NOT `ENCOUNTER_ALREADY_CLOSED`, for the reason at
 * the top of this file, and the sentences differ: there the way out is to amend
 * the note, here there is nothing to amend — a prescription is not a note.
 */
export class PrescriptionEncounterNotOpenError extends ConflictError {
  readonly code = 'PRESCRIPTION_ENCOUNTER_NOT_OPEN';
  override readonly userTitle =
    'Esa atención ya terminó y no admite recetas nuevas. Abra otra atención para recetar';

  constructor(status: string) {
    // The state only: no patient, no medicine, no hour reaches a log.
    super(`Encounter is ${status} and admits no new prescription`, { status });
  }
}

/**
 * PR-005, PR-010. The state refuses what was asked of it.
 *
 * ONE CODE FOR EVERY REFUSED PAIR: issuing an already-issued prescription,
 * issuing an annulled one, annulling a draft. What the caller does next is the
 * same in all of them — look at the state the screen no longer knows — and
 * three codes would ask every client to model a lifecycle it does not own. The
 * MESSAGE is what differs, and it names the state and what can be done from it.
 *
 * 409: the request is well formed and it is the CURRENT STATE that refuses it,
 * usually because a colleague moved it first.
 */
export class PrescriptionNotEditableError extends ConflictError {
  readonly code = 'PRESCRIPTION_NOT_EDITABLE';
  override readonly userTitle: string;

  constructor(status: PrescriptionStatus) {
    // The state only: no patient, no medicine, no hour reaches a log.
    super(`A prescription in status ${status} does not admit that`, { status });
    this.userTitle = `La receta está en estado «${STATUS_LABEL[status]}» y ${WHAT_TO_DO[status]}. Actualice la pantalla`;
  }
}

/**
 * PR-032. Issuing a prescription with no lines at all.
 *
 * A SEPARATE CODE FROM THE INCOMPLETE LINE, because what the caller does is
 * different: there they fill in a box, here they add a medicine. A single code
 * would make the client read the Spanish text to find out which.
 */
export class PrescriptionEmptyError extends ValidationError {
  readonly code = 'PRESCRIPTION_EMPTY';
  override readonly userTitle =
    'Una receta sin ningún medicamento no se puede emitir. Añada al menos uno';

  constructor() {
    super('A prescription with no items cannot be issued');
  }
}

/**
 * PR-032. A line is missing something art. 5.c makes obligatory.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DEMANDED AT THE ISSUE AND NOT AT THE COMPOSITION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The same reasoning EN-020 gives for the clinical note: a form that refuses to
 * save until it is complete is a form nobody saves, and the doctor writes the
 * prescription in two minutes with the patient in front of them. At the moment
 * of ISSUE the document exists, and it is the document the ACESS inspects.
 *
 * ⚠️ THE FIELDS ARE NAMED ONE BY ONE AND THE MEDICINE IS NEVER NAMED. «Faltan
 * la concentración y la vía en la línea 2» sends the doctor to one box;
 * «faltan datos» sends them round the whole form. And the line NUMBER is the
 * address precisely so the drug name does not have to be (PR-094).
 */
export class PrescriptionItemIncompleteError extends ValidationError {
  readonly code = 'PRESCRIPTION_ITEM_INCOMPLETE';
  override readonly userTitle =
    'Faltan datos obligatorios de la receta. Complete los campos señalados antes de emitirla';
  override readonly fieldErrors: readonly DomainFieldError[];

  /**
   * `line: null` is a field of the prescription itself — the warning signs and
   * the advice of art. 5.e (PR-038, PR-039) — and its path is the bare field.
   * The code stays `PRESCRIPTION_ITEM_INCOMPLETE`: it is public contract, and
   * splitting it would make a client branch twice for one form.
   */
  constructor(missing: readonly { line: number | null; field: string }[]) {
    super(
      `Prescription is missing mandatory fields: ${missing
        .map(({ line, field }) => (line === null ? field : `${line}.${field}`))
        .join(', ')}`,
      { missing: missing.length },
    );
    this.fieldErrors = missing.map(({ line, field }) =>
      line === null
        ? {
            field,
            code: 'PRESCRIPTION_ITEM_INCOMPLETE',
            message: 'Obligatorio por la norma de receta médica',
          }
        : {
            // 0-based in the path because that is how the request carried
            // them, and a client highlights the box it sent.
            field: `items.${line - 1}.${field}`,
            code: 'PRESCRIPTION_ITEM_INCOMPLETE',
            message: `Obligatorio por la norma de receta médica (línea ${line})`,
          },
    );
  }
}

/**
 * PR-009. A line that names no CNMB concept and gives no written reason.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PRESCRIBING OUTSIDE THE CUADRO IS ALLOWED. NOT SAYING WHY IS NOT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `prescription_item_off_formulary` says the same thing in the database —
 * `concept_id IS NOT NULL OR off_formulary_justification IS NOT NULL` — and it
 * is what also stops an import and a `psql`. This class is what turns that
 * `CHECK_FAILED` into a sentence a doctor can act on.
 *
 * FREE TEXT AND NEVER A DROPDOWN, like the amendment reason of EN-025: a
 * dropdown gets filled in on autopilot, a text box does not.
 */
export class OffFormularyJustificationRequiredError extends ValidationError {
  readonly code = 'OFF_FORMULARY_JUSTIFICATION_REQUIRED';
  override readonly userTitle =
    'Puede recetar fuera del CNMB, pero tiene que escribir por qué. Indique la justificación en esa línea';
  override readonly fieldErrors: readonly DomainFieldError[];

  constructor(line: number) {
    super('An item outside the CNMB needs a written justification', { line });
    this.fieldErrors = [
      {
        field: `items.${line - 1}.offFormularyJustification`,
        code: 'OFF_FORMULARY_JUSTIFICATION_REQUIRED',
        message: `Escriba por qué se receta fuera del CNMB (línea ${line})`,
      },
    ];
  }
}

/**
 * PR-007. The concept named is from another catalogue, or was not in force on
 * the clinical date of the attention.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HOLE THE FOREIGN KEY DOES NOT COVER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `prescription_item.concept_id` is a foreign key to `catalog_concept`, and
 * that table holds EVERY catalogue: CIE-10, the tariff, the DPA, the
 * ethnicities. The key proves the row exists and proves nothing about what kind
 * of thing it is, so nothing in the database stops a parish being prescribed as
 * a medicine — and once prescribed it is a medicine for ever.
 *
 * ONE CODE FOR BOTH HALVES — wrong catalogue and out of force — because what
 * the caller does next is identical: pick from the CNMB as it stood that day.
 *
 * ⚠️ AND NOT `CONCEPT_WRONG_CATALOGUE`, which `encounter` declares for block K:
 * no module imports another and no code may be declared twice.
 */
export class ConceptNotPrescribableError extends ValidationError {
  readonly code = 'CONCEPT_NOT_PRESCRIBABLE';
  override readonly userTitle =
    'Ese medicamento no está en el CNMB vigente el día de la atención. Elíjalo del cuadro nacional, o recete fuera de él justificándolo';
  override readonly fieldErrors: readonly DomainFieldError[];

  constructor(line: number) {
    super('Concept is not a CNMB medicine in force on the encounter date', {
      line,
    });
    this.fieldErrors = [
      {
        field: `items.${line - 1}.conceptId`,
        code: 'CONCEPT_NOT_PRESCRIBABLE',
        message: `Elija un medicamento del CNMB vigente (línea ${line})`,
      },
    ];
  }
}

/**
 * PR-060. A line prescribes the very substance the chart flags an allergy to.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THERE IS NO «EMITIR DE TODAS FORMAS», AND THE SENTENCE SAYS WHAT THERE IS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An override with a mandatory reason is what anybody would build, and in this
 * schema it would be TEXT THAT IS LOST: there is no column to keep it in, so
 * the justification would live in the memory of a process and nowhere else. A
 * reason that is not stored is worse than not asking for one, because it makes
 * everybody believe there is a record.
 *
 * And there is a better way out, already built: if the allergy is not real it
 * is REFUTED (`patient_allergy.refuted_at`, EN-082), which leaves a row, an
 * author and notes, and fixes the chart for the next prescription and the next
 * doctor. The alert is not skipped — it is resolved. The message says so.
 *
 * 409 AND NOT 422: nothing sent is wrong. What refuses it is a fact of the
 * chart, and the way out is an act on the chart.
 *
 * ⚠️ NEITHER THE MEDICINE NOR THE ALLERGEN IS NAMED (PR-094): the line number
 * is the address, and the allergy travels by identifier in `params` so the
 * screen can open it.
 */
export class AllergyContraindicationError extends ConflictError {
  readonly code = 'ALLERGY_CONTRAINDICATION';
  override readonly userTitle =
    'La ficha registra una alergia al principio activo de esta receta. Si la alergia no es real, refútela en la ficha y vuelva a emitir';
  override readonly fieldErrors: readonly DomainFieldError[];

  constructor(lines: readonly number[]) {
    super('Prescribed substance matches an active allergy of the chart', {
      lines: lines.join(','),
    });
    this.fieldErrors = lines.map((line) => ({
      field: `items.${line - 1}.conceptId`,
      code: 'ALLERGY_CONTRAINDICATION',
      message: `La ficha registra alergia a este principio activo (línea ${line})`,
    }));
  }
}

/**
 * PR-004. The caller has an account but no clinical profile.
 *
 * `prescription.prescriber_id` is a foreign key to `practitioner`, not to
 * `app_user`, and that is the schema saying that a prescription has a clinical
 * author. Without this refusal a receptionist who somehow held
 * `prescription:write` would be stopped by a foreign key with a
 * `RELATED_RECORD_MISSING` on a form where nothing is wrong.
 *
 * NOTHING ABOUT THE ACCOUNT IS NAMED: the answer is the same for an account
 * with no profile and one whose profile was deactivated, so the endpoint does
 * not become a directory of who prescribes here.
 *
 * ⚠️ NOT `PRACTITIONER_PROFILE_REQUIRED`: same reason as the others, and the
 * sentence differs — there the act was signing the record, here it is issuing a
 * prescription.
 */
export class PrescriberProfileRequiredError extends ForbiddenError {
  readonly code = 'PRESCRIBER_PROFILE_REQUIRED';
  override readonly userTitle =
    'Su cuenta no tiene ficha profesional activa, y una receta la firma un profesional. Pida que se la creen';

  constructor() {
    super('Caller has no active practitioner profile');
  }
}

/**
 * PR-034. The prescriber has no ACESS registration, or it has expired.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A STRICTER RULE THAN EN-029, WHICH IS WHY IT IS A DIFFERENT CODE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PRACTITIONER_NOT_LICENSED` refuses a SIGNATURE when the registration has a
 * date and the date has passed, and deliberately does NOT refuse a practitioner
 * with no registration on file — «whether they must have one» is `staff`'s
 * question (ST-002, ST-005). Here it is not: art. 5.d.ii puts the registration
 * NUMBER inside the document, so without a number there is no prescription to
 * issue. Two different rules, two codes, and a client that has to tell them
 * apart can.
 *
 * CHECKED AT THE INSTANT OF ISSUE, never when the practitioner was registered:
 * a registration that lapses on Tuesday stops enabling on Wednesday without
 * anybody touching a row.
 *
 * NO DATE AND NO REGISTRATION NUMBER in the message: it reaches the logs, and
 * neither is the caller's to be told by this endpoint.
 */
export class PrescriberNotLicensedError extends ForbiddenError {
  readonly code = 'PRESCRIBER_NOT_LICENSED';
  override readonly userTitle =
    'La receta lleva impreso su número de registro ACESS vigente, y el suyo no lo está. Actualícelo con administración';

  constructor() {
    super('Prescriber holds no ACESS registration in force');
  }
}

/**
 * PR-070. The line names a narcotic or psychotropic of the CNMB.
 *
 * Not a refusal of the medicine: a refusal of THIS document. That receta is the
 * ACESS's pre-printed pad (Res. ACESS-2022-0046), with its own numbering and
 * custody, and the message says where it is written instead. It names the
 * line, never the medicine (PR-094).
 */
export class ControlledSubstanceNotPrescribableError extends ValidationError {
  readonly code = 'CONTROLLED_SUBSTANCE_NOT_PRESCRIBABLE';
  override readonly userTitle =
    'Un estupefaciente o psicotrópico no se receta en este sistema: se escribe en el recetario especial de la ACESS';
  override readonly fieldErrors: readonly DomainFieldError[];

  constructor(line: number) {
    super('Concept is a controlled substance; its receta is the ACESS pad', {
      line,
    });
    this.fieldErrors = [
      {
        field: `items.${line - 1}.conceptId`,
        code: 'CONTROLLED_SUBSTANCE_NOT_PRESCRIBABLE',
        message: `Se receta en el recetario especial de la ACESS (línea ${line})`,
      },
    ];
  }
}

/**
 * PR-040. The prescriber has no permanent contact number to print.
 *
 * Art. 5.e.vi puts it beside the warning signs: what the patient has to do at
 * three in the morning is call somebody. A receta that says «llame ante estos
 * signos» with no number is worse than no receta, so it is not issued. 422 and
 * not 403: nothing is forbidden, a datum of the profile is missing, and the
 * message says who adds it and where.
 *
 * NO PHONE IN THE MESSAGE: it reaches the logs.
 */
export class PrescriberContactRequiredError extends ValidationError {
  readonly code = 'PRESCRIBER_CONTACT_REQUIRED';
  override readonly userTitle =
    'La receta lleva impreso su teléfono de contacto permanente, y su ficha profesional no lo tiene. Pídalo a administración';

  constructor() {
    super('Prescriber has no permanent contact number on the clinical profile');
  }
}

/**
 * PR-021. The site has no parish configured, so there is no city to print.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * REFUSING IS THE ONLY ALTERNATIVE TO AN INVALID DOCUMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Art. 5.a.ii puts «ciudad y fecha de prescripción» in the minimum content, and
 * `site` has no city column: the canton is the PARENT of the site's DPA parish,
 * and `parish_concept_id` is nullable (⚠️ **Falta esquema**, PR-021). Printing
 * a prescription with the city blank produces a document an inspection rejects,
 * and doing it silently produces a drawer full of them.
 *
 * 422 AND NOT 500: nothing is broken. A datum of the installation is missing,
 * and the sentence says who fixes it and where.
 */
export class PrescriptionEstablishmentIncompleteError extends ValidationError {
  readonly code = 'PRESCRIPTION_ESTABLISHMENT_INCOMPLETE';
  override readonly userTitle =
    'La sede no tiene parroquia configurada, así que la receta no puede indicar la ciudad de prescripción. Complete los datos de la sede en configuración';

  constructor() {
    super('Site has no parish, so the city of prescription cannot be resolved');
  }
}
