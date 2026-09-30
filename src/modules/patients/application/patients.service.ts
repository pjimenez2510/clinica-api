import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  CatalogConceptNotFoundError,
  CatalogConceptNotInForceError,
} from '../../../shared/domain/errors/catalog-reference.errors';
import {
  type ClinicalDate,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import { ethnicityContradictsCountry } from '../domain/ecuadorian-ethnicity';
import { nationalityContradictsEthnicity } from '../domain/indigenous-nationality';
import { peopleContradictsNationality } from '../domain/indigenous-people';
import { sexualOrientationBelowMinimumAge } from '../domain/sexual-orientation';
import {
  AccessContextNotFoundError,
  DuplicateIdentifierError,
  EthnicityRequiresEcuadorianNationalityError,
  NationalityRequiresIndigenousEthnicityError,
  PatientMergedError,
  PatientNotFoundError,
  PeopleRequiresKichwaNationalityError,
  SexualOrientationBelowMinimumAgeError,
} from '../domain/patient.errors';
import type { PatientCorrectionRequest } from '../domain/patient-corrections';
import {
  type CatalogReference,
  type NewPatient,
  PATIENT_REPOSITORY,
  type PatientDetail,
  type PatientIdentifier,
  type PatientPage,
  type PatientRepository,
  type PatientSearchCriteria,
  type SexualOrientationRead,
} from '../domain/patient.repository';
import { clinicalDateToday } from '../domain/priority-groups';

/** Who is asking, so the trail can say so. */
export interface Requester {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/**
 * AG-073. The appointment a chart is being opened from, and whether the caller
 * may read the agenda at a given site — asked as a function so this service
 * does not have to know what a `Principal` is.
 */
export interface OpenedFromAgenda {
  agendaEntryId: string;
  mayReadAgendaAt(siteId: string): boolean;
}

/**
 * The chart as the four conditional rules of the RDACAA form see it.
 *
 * ONE SHAPE FOR THE FOUR, and it is the same shape whether the chart is being
 * created or corrected: the rules are about the row that WOULD RESULT, so the
 * caller resolves «absent means do not touch» first and hands over a plain
 * chart. Two shapes would be two places for a field to go missing, and the
 * symptom would be a rule that holds on registration and not on correction.
 */
interface ConditionalChart {
  countryOfNationalityCode: string | null;
  ethnicityConceptId: string | null;
  nationalityConceptId: string | null;
  peopleConceptId: string | null;
  sexualOrientationConceptId: string | null;
  /** Never null: `patient.birth_date` is `NOT NULL`. See `resultingBirthDate`. */
  birthDate: ClinicalDate;
}

/**
 * Which catalogue each reference of the chart must come from (PA-026 to
 * PA-029, PA-056, PA-057).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIELD NAME IS THE KEY, AND THAT IS WHAT MAKES THE ERROR ACTIONABLE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Six catalogue selectors sit on one form, and three of them look alike enough
 * to be swapped by accident — nationality, sexual orientation and gender
 * identity. An error that says only «no se encontró el código» sends the desk
 * to re-check all six; named by field, the message lands on the input that is
 * wrong.
 */
const EXPECTED_SYSTEM = {
  ethnicityConceptId: 'ETHNICITY',
  nationalityConceptId: 'NATIONALITY',
  peopleConceptId: 'PEOPLE',
  sexualOrientationConceptId: 'SEXUAL_ORIENTATION',
  residenceParishConceptId: 'DPA',
  genderIdentityConceptId: 'GENDER_IDENTITY',
} as const;

/** One of the six catalogue references of the form, named as the request names it. */
type ConceptField = keyof typeof EXPECTED_SYSTEM;

/**
 * El catálogo del que sale el país de nacionalidad (PA-053).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO ESTÁ EN `EXPECTED_SYSTEM`, Y NO ES UN OLVIDO: SE BUSCA POR CÓDIGO.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Los cuatro de arriba llegan como el `uuid` de una fila del catálogo. El país
 * llega como `VEN`, porque es lo que la ficha guarda —igual que
 * `patient_identifier.issuing_country`—, así que la comprobación es otra
 * consulta y no cabe en el mismo bucle.
 *
 * El campo se nombra igual en el error para que el mensaje aterrice en el
 * selector que está mal, que es lo mismo que hacen los otros cuatro.
 */
const COUNTRY_SYSTEM_CODE = 'COUNTRY';
const COUNTRY_FIELD = 'countryOfNationalityCode';

/**
 * PA-058. The resource type the trail uses for the sexual orientation.
 *
 * DISTINCT FROM `'patient'` ON PURPOSE, exactly as `patient_priority_group` is.
 * «¿Quién abrió la ficha de esta persona?» and «¿quién leyó su orientación
 * sexual?» are two questions, and answering the second by filtering `'patient'`
 * rows by hand is how an investigation gets the wrong answer.
 * `access_audit.resource_type` is a `varchar(64)` with no CHECK, so this is the
 * whole change.
 */
const SEXUAL_ORIENTATION_RESOURCE_TYPE = 'patient_sexual_orientation';

/**
 * Reading, creating and correcting patient records.
 *
 * The authorisation decision is NOT here — the guard settled it before this
 * ran, from the route's `@RequirePermission`. What is here is everything that
 * must happen regardless of which endpoint asked: the access trail, the
 * duplicate check, the catalogue references, and the fact that a merged record
 * is not a missing one.
 */
@Injectable()
export class PatientsService {
  constructor(
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PatientsService.name);
  }

  /**
   * Searches the register.
   *
   * NOT AUDITED PER ROW, deliberately. A search is typed letter by letter and
   * auditing each keystroke would write thousands of rows a day and bury the
   * accesses that matter — which is the opposite of what the trail is for.
   * Opening a record is the accountable act, and that is audited below.
   */
  async search(criteria: PatientSearchCriteria): Promise<PatientPage> {
    return this.patients.search(criteria);
  }

  /**
   * Opens one record.
   *
   * THIS is the accountable act, and the audit entry is written whether or not
   * anything else succeeds afterwards. Recording after a successful render
   * would miss exactly the case worth investigating: somebody opening charts
   * and closing them again.
   *
   * A record that does not exist is NOT audited: there is no data subject to
   * account to, and writing a row per guessed identifier would let anybody
   * fill the trail with noise.
   */
  async getById(
    id: string,
    requester: Requester,
    openedFrom?: OpenedFromAgenda,
  ): Promise<PatientDetail> {
    const patient = await this.patients.findById(id);
    if (!patient) throw new PatientNotFoundError();

    /**
     * PA-045. AN ABSORBED CHART DOES NOT OPEN — it says where it went.
     *
     * ═══════════════════════════════════════════════════════════════════════
     * THIS IS THE READ, AND IT IS THE CASE THE ERROR WAS WRITTEN FOR.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * «Toda operación que la nombre» includes opening it, and this is the
     * operation that hurts: `PatientMergedError` exists so that a receptionist
     * stops «opening the old chart and wondering why the notes stop». Serving
     * it with a `mergedIntoMrn` field somewhere in the body is a pointer every
     * screen has to remember to read; a 409 naming the surviving MRN is one
     * the client cannot miss.
     *
     * NOT A 404, and not silence: the history existed and printed documents
     * still quote this number. Merged charts are still FINDABLE —
     * `GET /patients?includeMerged=true` lists them — so what changes is that
     * following one leads to the live chart instead of to a dead end.
     *
     * ⚠️ AND IT IS NOT AUDITED. Nothing of the chart was disclosed, so there
     * is no access to account for — same criterion as the 404 of PA-024, and
     * the reason the audit entry below comes after this line and not before.
     */
    if (patient.mergedIntoMrn !== null) {
      throw new PatientMergedError(patient.mergedIntoMrn);
    }

    /**
     * AG-073. «Desde dónde» includes the appointment the chart was reached
     * from, and it is CHECKED BEFORE it is written: the row is evidence, and a
     * context the client merely asserted would make it say whatever the client
     * wanted. After the 404 and the 409 above, so a missing or merged chart
     * answers the same with or without an appointment behind it.
     */
    if (openedFrom) await this.assertOpenedFrom(patient.id, openedFrom);

    await this.audit.record({
      userId: requester.userId,
      resourceType: 'patient',
      resourceId: patient.id,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
      context: openedFrom && {
        resourceType: 'agenda_entry',
        resourceId: openedFrom.agendaEntryId,
      },
    });

    return patient;
  }

  /**
   * AG-073. The appointment must exist, be THIS patient's and sit at a site
   * where the caller reads the agenda — and the three failures answer alike,
   * so the route does not tell «es de otra persona» from «no existe» (AG-071).
   */
  private async assertOpenedFrom(
    patientId: string,
    openedFrom: OpenedFromAgenda,
  ): Promise<void> {
    const entry = await this.patients.findAgendaEntryContext(
      openedFrom.agendaEntryId,
    );
    if (
      !entry ||
      entry.patientId !== patientId ||
      !openedFrom.mayReadAgendaAt(entry.siteId)
    ) {
      throw new AccessContextNotFoundError();
    }
  }

  /**
   * PA-057, PA-058. Reads the chart's sexual orientation, behind its own door.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * A SEPARATE READ BECAUSE IT IS SPECIAL CATEGORY DATA (LOPDP).
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The route demands `patient:sexual-orientation`, which `patient:read` does
   * not imply and which `MEDICO` and `ADMIN` carry from the seed since
   * 19-08-2026 (D-039, and see `default-roles.ts` for what that means for an
   * administrator). The split is the same one
   * PA-040 and PA-042 make for the reason behind a priority: reception and
   * billing hold `patient:read` and keep working, and this datum is simply not
   * part of what they receive.
   *
   * ⚠️ AUDITED, AND WITH ITS OWN `resourceType`. «¿Quién abrió la ficha de esta
   * persona?» and «¿quién leyó su orientación sexual?» are two questions, and
   * answering the second by filtering `'patient'` rows by hand is how an
   * investigation gets the wrong answer. Same reasoning, and same shape, as
   * `patient_priority_group`.
   *
   * ⚠️ AND THE ENTRY IS WRITTEN WHATEVER THE ANSWER IS — including `null`.
   * «Nobody has recorded it» is itself information about the patient, and a
   * trail that only recorded the successful reads would leave the cheapest way
   * of probing charts invisible. What is NOT audited is a chart that does not
   * exist (PA-024) or one that was merged: nothing was disclosed.
   */
  async getSexualOrientation(
    id: string,
    requester: Requester,
  ): Promise<SexualOrientationRead> {
    const found = await this.patients.findSexualOrientation(id);
    if (!found) throw new PatientNotFoundError();

    // PA-045. An absorbed chart says where it went, on every operation that
    // names it — answering `null` here would read as «no se ha registrado».
    if (found.mergedIntoMrn !== null) {
      throw new PatientMergedError(found.mergedIntoMrn);
    }

    await this.audit.record({
      userId: requester.userId,
      resourceType: SEXUAL_ORIENTATION_RESOURCE_TYPE,
      resourceId: id,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
      // `before`/`after` deliberately absent, as everywhere in this module:
      // `access_audit_payload_only_for_declared_resources` refuses a payload
      // outside `'configuration'`, and recording does not throw — the entry
      // would simply be lost (REQ-113, D-032).
    });

    return found;
  }

  /**
   * Registers a new patient.
   *
   * The duplicate check is a COURTESY, not the guarantee. The database holds a
   * partial unique index over active identifiers, and that is what actually
   * prevents two charts for the same cedula under concurrency. Checking first
   * only buys a message that names the problem instead of a constraint
   * violation the receptionist cannot read.
   */
  async create(
    input: NewPatient,
    requester: Requester,
    now: Date = new Date(),
  ): Promise<PatientDetail> {
    await this.assertReferences(input, clinicalDateToday(now));
    await this.assertCountry(
      input.countryOfNationalityCode,
      clinicalDateToday(now),
    );
    await this.assertConditionalFields(
      {
        countryOfNationalityCode: input.countryOfNationalityCode ?? null,
        ethnicityConceptId: input.ethnicityConceptId ?? null,
        nationalityConceptId: input.nationalityConceptId ?? null,
        peopleConceptId: input.peopleConceptId ?? null,
        sexualOrientationConceptId: input.sexualOrientationConceptId ?? null,
        /**
         * The column is a DATE and the controller parsed it at UTC midnight,
         * so the calendar day is its UTC slice — asking Ecuador here would
         * move it to the day before. Same conversion the adapter does
         * (`toClinicalDate`).
         */
        birthDate: parseClinicalDate(
          input.birthDate.toISOString().slice(0, 10),
        ),
      },
      clinicalDateToday(now),
    );
    await this.assertMotherExists(input.motherPatientId);

    if (input.identifier) {
      const existing = await this.patients.findByIdentifier(input.identifier);
      if (existing) throw new DuplicateIdentifierError();
    }

    const created = await this.patients.create(input);

    await this.audit.record({
      userId: requester.userId,
      resourceType: 'patient',
      resourceId: created.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    // The MRN is safe to log: it is an internal number, not a national
    // identifier, and support needs it to trace a registration.
    this.logger.info(
      { patient_mrn: created.mrn, action: 'PATIENT_REGISTERED' },
      'patient registered',
    );

    return created;
  }

  /**
   * Corrects a chart (PA-008, PA-009, PA-026 to PA-029, PA-031).
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * A CORRECTION WRITES TWO KINDS OF ROW, AND THEY ARE TWO TABLES ON PURPOSE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * D-032, 16-08-2026. `access_audit` gets an `UPDATE` entry with NO
   * `before`/`after` — who touched the chart and when — and
   * `patient_change_history` gets one row per field that actually changed,
   * with the previous value.
   *
   * ⚠️ THE PAYLOAD MUST NOT GO TO THE AUDIT TRAIL, and this is not a style
   * rule: `access_audit_payload_only_for_declared_resources` refuses a row
   * whose `resource_type` is not on the whitelist — today exactly
   * `'configuration'` — and carries a payload. Since recording does not throw
   * (see `AccessAuditRecorder.record`), the entry would simply be LOST, in
   * silence. That table is append-only and never purged, so a previous surname
   * landing in it could never be rectified, minimised or erased, against
   * REQ-113. The history table is rectifiable precisely because it holds chart
   * contents.
   *
   * THE MRN IS NOT CORRECTABLE (PA-002) — it is not on the list, in this code
   * or in the database's CHECK.
   */
  async correct(
    id: string,
    requested: PatientCorrectionRequest,
    requester: Requester,
    now: Date = new Date(),
  ): Promise<PatientDetail> {
    /**
     * ⚠️ THIS READ FAILS EARLY; IT DOES NOT DECIDE ANYTHING.
     *
     * It exists so a missing chart, a merged one or a bad catalogue reference
     * comes back as a message the desk can act on, before a transaction is
     * opened. What it CANNOT be is the only check: it runs outside the
     * transaction, and both the previous values and the merge can change
     * between here and the write. The adapter locks the row and repeats the
     * two (`PatientRepository.correct`).
     */
    const state = await this.patients.findCorrectionState(id);
    if (!state) throw new PatientNotFoundError();

    /**
     * A merged chart is NOT corrected, and it is not a 404 either: the record
     * genuinely existed and printed documents still quote its MRN. The caller
     * is told where it went, exactly as the agenda does when refusing a
     * booking on one (AG-027).
     */
    if (state.mergedIntoMrn !== null) {
      throw new PatientMergedError(state.mergedIntoMrn);
    }

    await this.assertReferences(requested, clinicalDateToday(now));
    await this.assertCountry(
      requested.countryOfNationalityCode,
      clinicalDateToday(now),
    );
    /**
     * PA-027, PA-056, PA-057 and PA-059, all decided on the chart that WOULD
     * RESULT and never on the body.
     *
     * Correcting only the ethnicity of a chart that already declares a
     * nationality — or only the country of one that already declares an
     * ethnicity, or only the birth date of one that already declares a sexual
     * orientation — has to be answered exactly like sending both at once: the
     * contradiction is a property of the ROW, and a rule that only looked at
     * what was sent would let the desk reach it in two requests instead of one.
     * `state.values` is the snapshot read above, so ABSENT means «lo que ya
     * había» and `null` means «bórralo» — the same two meanings the correction
     * has everywhere else.
     */
    await this.assertConditionalFields(
      {
        countryOfNationalityCode: resultingValue(state.values.countryOfNationalityCode, requested.countryOfNationalityCode), // prettier-ignore
        ethnicityConceptId: resultingValue(state.values.ethnicityConceptId, requested.ethnicityConceptId), // prettier-ignore
        nationalityConceptId: resultingValue(state.values.nationalityConceptId, requested.nationalityConceptId), // prettier-ignore
        peopleConceptId: resultingValue(state.values.peopleConceptId, requested.peopleConceptId), // prettier-ignore
        sexualOrientationConceptId: resultingValue(state.values.sexualOrientationConceptId, requested.sexualOrientationConceptId), // prettier-ignore
        /**
         * ⚠️ AND THE BIRTH DATE IS ONE OF THE INPUTS, which is what makes
         * PA-057 hold when it is the DATE that gets corrected rather than the
         * orientation. The snapshot already stores it as `YYYY-MM-DD`, the
         * same shape the request carries, so no conversion enters here — and
         * it is never `null`: the column is `NOT NULL`.
         */
        birthDate: resultingBirthDate(state.values.birthDate, requested.birthDate), // prettier-ignore
      },
      clinicalDateToday(now),
    );
    await this.assertMotherExists(requested.motherPatientId);

    /**
     * The update and the trail travel together into ONE transaction. A chart
     * changed with no trail is what REQ-113 cannot live with, and a trail of a
     * change that did not happen is worse. THE REQUEST TRAVELS, NOT A PLAN:
     * «desde qué valor» is only true if it was read with the row locked, which
     * only the adapter's transaction can do.
     */
    const applied = await this.patients.correct({
      patientId: id,
      // PA-031: who changed it is who is signed in, never a field of the
      // request, or the trail could be written to name somebody else.
      changedById: requester.userId,
      requested,
    });
    if (!applied) throw new PatientNotFoundError();

    /**
     * NO SE REGISTRA LO QUE NO OCURRIÓ (D-032).
     *
     * Una corrección que reenvía los valores que ya estaban no cambia nada y no
     * deja fila de histórico. Registrar igualmente un `UPDATE` escribiría en una
     * tabla append-only QUE NO SE PURGA NUNCA que la ficha se modificó, sin
     * ninguna fila que pueda decir qué — un rastro de algo que no pasó, que es
     * lo contrario de lo que la bitácora sirve.
     */
    if (applied.changed) await this.recordMutation(id, requester);

    return applied.patient;
  }

  /**
   * PA-015. A patient registered without a document now has one.
   *
   * IT NEVER CREATES A CHART. Until this route existed, `is_provisional` was
   * fixed at registration and nothing moved it, so the only way for a newborn
   * to get their cedula on file was to register them again — which is exactly
   * the duplicate REQ-010 then has to merge, with the history split in two.
   */
  async addIdentifier(
    id: string,
    identifier: PatientIdentifier,
    requester: Requester,
  ): Promise<PatientDetail> {
    const patient = await this.patients.findById(id);
    if (!patient) throw new PatientNotFoundError();
    if (patient.mergedIntoMrn !== null) {
      throw new PatientMergedError(patient.mergedIntoMrn);
    }

    // Same courtesy as registration, and the same guarantee underneath: the
    // partial unique index is what actually stops two active charts holding
    // one document (PA-013, PA-014).
    const holder = await this.patients.findByIdentifier(identifier);
    if (holder && holder.id !== id) throw new DuplicateIdentifierError();

    const updated = await this.patients.addIdentifier({
      patientId: id,
      identifier,
    });
    if (!updated) throw new PatientNotFoundError();

    await this.recordMutation(id, requester);

    return updated;
  }

  /**
   * The audit entry of a mutation: who and when, and NOTHING ELSE (D-032).
   *
   * One place, so «sin `before`/`after`» is a property of the code rather than
   * a rule each new write has to remember — and forgetting it does not fail
   * loudly, it loses the entry.
   */
  private async recordMutation(
    patientId: string,
    requester: Requester,
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType: 'patient',
      resourceId: patientId,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }

  /**
   * Every catalogue reference sent, resolved before anything is written.
   *
   * THREE NEGATIVES AND TWO ANSWERS, and the collapse is deliberate:
   *
   *   - the id does not exist              → `CATALOG_CONCEPT_NOT_FOUND`
   *   - it exists, in ANOTHER catalogue    → `CATALOG_CONCEPT_NOT_FOUND` too
   *   - it exists here but is not in force → `CATALOG_CONCEPT_NOT_IN_FORCE`
   *
   * The second answers like the first because for the caller it means the same
   * thing — that is not a valid value for this field — and because telling
   * them «existe, pero es de otro catálogo» would turn the chart's endpoint
   * into an oracle of the whole catalogue, walkable by trying identifiers.
   * The third is separate because a withdrawn code needs a different action:
   * choose a current one, not correct a typo.
   */
  private async assertReferences(
    input: Partial<Record<ConceptField, string | null | undefined>>,
    today: ClinicalDate,
  ): Promise<void> {
    for (const field of Object.keys(EXPECTED_SYSTEM) as ConceptField[]) {
      const id = input[field];
      if (id === undefined || id === null) continue;

      const reference = await this.patients.findConceptReference(id);
      if (!reference || reference.systemCode !== EXPECTED_SYSTEM[field]) {
        throw CatalogConceptNotFoundError.byId(id, field);
      }

      if (!isInForce(reference, today)) {
        throw new CatalogConceptNotInForceError(reference.code, today, field);
      }
    }
  }

  /**
   * PA-053. El país de nacionalidad existe en el catálogo `COUNTRY`.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * TRES LETRAS MAYÚSCULAS NO ES UN PAÍS, Y POR ESO ESTA COMPROBACIÓN EXISTE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * El DTO exige la forma y `patient_country_of_nationality_format` la repite
   * en la base, porque una importación no pasa por el DTO. Ninguno de los dos
   * puede decir que `XXX` no es un país: un `CHECK` no consulta otra tabla. Eso
   * se decide aquí, contra el catálogo, y se responde POR CAMPO — con el mismo
   * criterio que las cuatro referencias de {@link assertReferences}.
   *
   * `null` es «vaciar» y no se resuelve: exigir que el país que se está
   * borrando siga en el catálogo haría imposible deshacer una elección mal
   * hecha el día que ese país se retire.
   */
  private async assertCountry(
    code: string | null | undefined,
    today: ClinicalDate,
  ): Promise<void> {
    if (code === undefined || code === null) return;

    const reference = await this.patients.findConceptReferenceByCode(
      COUNTRY_SYSTEM_CODE,
      code,
    );
    if (!reference) {
      throw CatalogConceptNotFoundError.byCode(
        COUNTRY_SYSTEM_CODE,
        code,
        COUNTRY_FIELD,
      );
    }

    if (!isInForce(reference, today)) {
      throw new CatalogConceptNotInForceError(
        reference.code,
        today,
        COUNTRY_FIELD,
      );
    }
  }

  /**
   * The chart the RDACAA can report: the four conditional fields of the
   * ministry's form, decided together (PA-027, PA-056, PA-057, PA-059).
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * IN THE SERVICE, BECAUSE THERE IS NOWHERE ELSE THEY CAN LIVE.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Not the DTO: enforcing a rule only at the transport layer stops enforcing
   * it the day another use case calls from inside — the same argument the merge
   * reason and the end of a pregnancy already make. And not a `CHECK` either,
   * which is where the rest of this module's invariants live:
   *
   *   - whether an ethnicity is «Indígena» and whether a nationality is
   *     «Kichwa» depend on WHICH ROW of another catalogue they point at, and a
   *     `CHECK` cannot query another table;
   *   - whether a patient is ten depends on an age that is DERIVED and moves
   *     with the calendar, so a `CHECK` would turn a valid row invalid with
   *     nobody touching it;
   *   - and the country one COULD be a `CHECK`, at the price of writing `'ECU'`
   *     in SQL as well as in the domain — two copies of a literal that one day
   *     disagree (see `ecuadorian-ethnicity.ts`).
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ONE METHOD FOR FOUR RULES, AND THE ORDER IS THE FORM'S OWN.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Columns 11 → 12 → 13 → 14 are a chain: the country enables the ethnicity,
   * the ethnicity enables the nationality, the nationality enables the people.
   * They are checked in that order so the OUTERMOST broken link is the one
   * reported — telling a Venezuelan chart that its people needs a Kichwa
   * nationality would send the desk to fix a field that has to be emptied
   * anyway. The sexual orientation of column 7 hangs off nothing and is checked
   * last.
   *
   * ⚠️ EACH CATALOGUE IS RESOLVED ONLY WHEN A RULE ACTUALLY NEEDS IT. With no
   * nationality there is nothing to refuse about the people, and a query per
   * registration that decides nothing is a query somebody will remove without
   * being able to see why it was there.
   *
   * ⚠️ VALIDITY IS NOT ASKED. A category the ministry withdraws does not stop
   * being the one the patient declared, and refusing a correction of an
   * unrelated field because an ethnicity recorded in 2022 is no longer current
   * would make old charts uncorrectable. Whether a concept may be CHOSEN today
   * is {@link assertReferences}, and it already ran.
   */
  private async assertConditionalFields(
    chart: ConditionalChart,
    today: ClinicalDate,
  ): Promise<void> {
    // PA-059, column 12: «Aplica para nacionalidad Ecuatoriana».
    if (ethnicityContradictsCountry(chart)) {
      throw new EthnicityRequiresEcuadorianNationalityError();
    }

    // PA-027, column 13: «Aplica únicamente para la autoidentificación
    // "indígena"».
    if (chart.nationalityConceptId !== null) {
      const ethnicity = await this.conceptCodeOf(chart.ethnicityConceptId);
      if (
        nationalityContradictsEthnicity({
          ethnicityCode: ethnicity,
          nationalityConceptId: chart.nationalityConceptId,
        })
      ) {
        throw new NationalityRequiresIndigenousEthnicityError();
      }
    }

    // PA-056, column 14: «Aplica únicamente para la nacionalidad indígena
    // "Kichwa"».
    if (chart.peopleConceptId !== null) {
      const nationality = await this.conceptCodeOf(chart.nationalityConceptId);
      if (
        peopleContradictsNationality({
          nationalityCode: nationality,
          peopleConceptId: chart.peopleConceptId,
        })
      ) {
        throw new PeopleRequiresKichwaNationalityError();
      }
    }

    // PA-057, column 7: «aplica a usuarios a partir de los 10 años de edad».
    // No catalogue to resolve — the answer is in the chart's own birth date,
    // read on the clinical date of Ecuador and never on the host's.
    if (sexualOrientationBelowMinimumAge(chart, today)) {
      throw new SexualOrientationBelowMinimumAgeError();
    }
  }

  /**
   * The catalogue `code` behind a stored concept id, or `null`.
   *
   * The rules above compare CODES and never ids, because which row of a
   * catalogue means «Indígena» or «Kichwa» is the thing that changes between
   * editions — and it already did once, on 19-08-2026. Resolving it in one
   * place keeps the three conditional rules asking the same question.
   */
  private async conceptCodeOf(
    conceptId: string | null,
  ): Promise<string | null> {
    if (conceptId === null) return null;
    const reference = await this.patients.findConceptReference(conceptId);
    return reference?.code ?? null;
  }

  /**
   * PA-009. The mother's chart has to exist AND still be the live one.
   *
   * ⚠️ NOT `exists`. A merged chart is not deleted — printed documents still
   * quote its MRN — so `exists` says yes about one that has been absorbed.
   * Linking a newborn to it makes them vanish from
   * `GET /patients?motherId=<survivor>`, which is the only way of finding them
   * before they have a document of their own: the link is left looking checked
   * while it points at the chart nobody searches by.
   *
   * A chart being its OWN mother is refused by `patient_mother_not_self` and
   * not here: a CHECK is what also stops an import and a `psql` INSERT, and
   * repeating it in TypeScript would be a second rule to keep in step with the
   * first.
   */
  private async assertMotherExists(
    motherPatientId: string | null | undefined,
  ): Promise<void> {
    if (motherPatientId === undefined || motherPatientId === null) return;
    if (!(await this.patients.existsUnmerged(motherPatientId))) {
      throw new PatientNotFoundError('motherPatientId');
    }
  }
}

/**
 * What a field would hold once the correction is applied.
 *
 * ABSENT MEANS «do not touch» AND `null` MEANS «clear it», which is the whole
 * contract of `PatientCorrectionRequest` and the only reason a rule about the
 * resulting chart can be decided before writing.
 */
function resultingValue(
  stored: string | null,
  requested: string | null | undefined,
): string | null {
  return requested === undefined ? stored : requested;
}

/**
 * The birth date the chart would hold once the correction is applied.
 *
 * ITS OWN FUNCTION BECAUSE IT IS THE ONE FIELD THAT CANNOT BE CLEARED. The
 * snapshot types every correctable field as `string | null` — it is one record
 * over one list — but `patient.birth_date` is `NOT NULL` and
 * `correctPatientSchema` does not accept `null` for it, so both `null`s are
 * unreachable. Collapsing them into `parseClinicalDate(x ?? '')` at the call
 * site would hide that behind a `RangeError` nobody could read; here the
 * impossible case is named and answered with the value that is actually there.
 */
function resultingBirthDate(
  stored: string | null,
  requested: string | undefined,
): ClinicalDate {
  const resulting = requested ?? stored;
  if (resulting === null) {
    throw new Error('A chart cannot exist without a birth date');
  }
  return parseClinicalDate(resulting);
}

/**
 * Whether a stored concept may be CHOSEN today.
 *
 * ⚠️ ONLY ON WRITING. Reading a chart never asks this: a parish withdrawn from
 * the DPA must not blank out the address of somebody who has not moved, and an
 * ethnic category reworded by INEC must still come back as it was declared.
 * Same criterion as `CatalogsService.byId`.
 *
 * Both ends inclusive, and compared as `YYYY-MM-DD` strings — which sort
 * chronologically — so no instant and no zone enters the comparison.
 */
function isInForce(reference: CatalogReference, on: ClinicalDate): boolean {
  if (reference.validFrom > on) return false;
  return reference.validTo === null || reference.validTo >= on;
}
