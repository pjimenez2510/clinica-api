import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  ACTIVE_ALLERGY_READER,
  type ActiveAllergy,
  type ActiveAllergyReader,
} from '../../../shared/clinical/patient-allergy.port';
import {
  CHART_SUMMARY_REPOSITORY,
  type ChartSummaryRepository,
  type PreviousEncounterSummary,
  type PriorAttention,
  type PriorDiagnosis,
} from '../domain/chart-summary.repository';
import { cie10CategoryOf } from '../domain/diagnosis';
import type { DiagnosisOccurrence } from '../domain/encounter';
import {
  ENCOUNTER_REPOSITORY,
  type EncounterRepository,
} from '../domain/encounter.repository';
import {
  ConceptWrongCatalogueError,
  EncounterNotFoundError,
} from '../domain/encounter.errors';
import {
  PATIENT_ALLERGY_REPOSITORY,
  type AllergyAbsenceAssertion,
  type PatientAllergyRepository,
} from '../domain/patient-allergy.repository';
import {
  PATIENT_HISTORY_REPOSITORY,
  type HistoryView,
  type PatientHistoryRepository,
} from '../domain/patient-history.repository';

import type { Requester } from './encounter.service';

/**
 * Its own resource type in the trail.
 *
 * NOT `'encounter'` AND NOT `'patient'`. What this read discloses is neither
 * one attention nor the administrative chart: it is a slice of the person's
 * clinical history — diagnoses included — assembled for one screen. An
 * investigation asking «¿quién revisó la historia de esta paciente?» has to be
 * able to find these rows without filtering by hand over rows that mean
 * something else, which is the argument PA-040 made for the priority groups.
 */
const RESOURCE_TYPE = 'patient_chart_summary';

/**
 * EN-159. How many previous attentions the summary carries.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A BOUND AND NOT A PAGE, AND THE NUMBER IS AN ARGUMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * §7 bis of `FLUJO-DE-LA-ATENCION.md` is the reason there is a number here at
 * all. Clinical-record usability measures **45,9 out of 100 on the System
 * Usability Scale — the 9th percentile against more than 1300 studies from
 * other industries**, and the relationship with burnout is dose-response: each
 * point of usability is 3% less probability of burnout. The documented problem
 * is not missing data, it is FRAGMENTATION — so the answer is not «serve
 * everything and let the screen decide», which is how a panel becomes
 * something people close.
 *
 * Five, because it is what fits beside a consultation without scrolling and it
 * covers the recent history of a chronic patient seen every three months.
 * Nothing is hidden by it: `totalEncounters` says how many there are, and
 * `GET /encounters?patientId=` serves the whole list, which is EN-015.
 *
 * ⚠️ AND IT IS NOT A REQUEST PARAMETER. A caller-supplied limit is a caller
 * that can ask for two hundred attentions with their diagnoses in one call —
 * the shape of a bulk extraction that leaves ONE audit row.
 */
const PREVIOUS_ENCOUNTERS = 5;

/** EN-159. The history as a consultation reads it. */
export interface ChartSummary {
  encounterId: string;
  /** The SURVIVING chart, never an absorbed identifier. */
  patientId: string;
  /** EN-081. Worst first. The first field, because it is what changes conduct. */
  allergies: readonly ActiveAllergy[];
  /**
   * EN-087. The standing «sin alergias conocidas», or `null`.
   *
   * ⚠️ IT TRAVELS BESIDE THE LIST AND NOT INSTEAD OF IT, and the pair is what
   * makes THREE states readable where a list alone only ever had two:
   *
   *   - list with rows                → hay alergias registradas
   *   - list empty, this present      → «sin alergias conocidas (quién, cuándo)»
   *   - list empty, this `null`       → «no se preguntó»
   *
   * `null` is «no se preguntó» and NEVER «no tiene». HL7's International
   * Patient Summary is literal about it: `nilknown` is «una afirmación positiva
   * por parte de un usuario clínico, y no una posición por defecto afirmada por
   * un sistema informático a falta de otra información». A screen that turned
   * an empty list into «ninguna» would be inventing exactly that.
   */
  noKnownAllergies: AllergyAbsenceAssertion | null;
  /** EN-085. The live history entries of the chart and those it absorbed. */
  history: readonly HistoryView[];
  /** EN-159. Newest first, bounded by `PREVIOUS_ENCOUNTERS`. */
  previousEncounters: readonly PreviousEncounterSummary[];
  /** EN-159. So a screen can say «5 de 23» instead of implying there are 5. */
  totalEncounters: number;
}

/** EN-184. What the screen preselects for a diagnosis, and why. */
export interface OccurrenceProposal {
  proposed: DiagnosisOccurrence;
  /** The earlier diagnosis that makes it «subsecuente»; `null` otherwise. */
  basis: PriorDiagnosis | null;
}

/**
 * EN-185. «Primera vez» only when it is certain; otherwise no proposal and the
 * last attention that may be of the same service, so the doctor decides with
 * it in front.
 */
export interface VisitSequenceProposal {
  proposed: 'FIRST_TIME' | null;
  /** Whether the appointment says which specialty it is. */
  specialtyKnown: boolean;
  last: PriorAttention | null;
  /** There are attentions of the service at sites the caller does not cover. */
  elsewhere: boolean;
}

/**
 * EN-159 to EN-161. The patient's history, during the consultation.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS AT ALL — it is a sentence from the flow document
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Step 4 of `FLUJO-DE-LA-ATENCION.md`: while attending, the doctor «tiene
 * delante la historia entera — atenciones anteriores, diagnósticos, alergias,
 * lo que se le recetó la última vez. Eso no es una pantalla aparte a la que
 * hay que ir: es parte de la consulta».
 *
 * ⚠️ A SERVICE OF ITS OWN BECAUSE IT IS A READ MODEL AND NOTHING ELSE. It
 * writes no clinical content, owns no invariant and enforces no rule; what it
 * does is COMPOSE — the allergies through the shared port, the attentions and
 * their block K through one query — and hold the decision about how much is
 * too much. That is a second reason to change from `EncounterService`, which
 * is ADR-008 §2's third limit: the day the summary gains prescriptions and
 * previous lab results, this file moves and the state machine does not.
 *
 * ⚠️ WHAT IT DOES NOT COMPOSE, AND EACH ABSENCE IS WRITTEN DOWN:
 *
 *  - NO NOTE TEXT (EN-160). 46% of a clinical note today is copied and 36%
 *    imported; each 1% of imported text adds 1,5% of length and the redundancy
 *    of the average note has reached 58,8%. The rule §7 bis draws is the one
 *    this obeys: «se enlazan o se muestran al lado, nunca se pegan».
 *  - ANTECEDENTES (EN-085), live ones only, from `patient_history` — and the
 *    `antecedentes` section of the last signed 002 is NOT a substitute: a note
 *    is immutable (EN-023), so what was true in March would keep coming back
 *    as March's answer for ever. An empty field would read as «no consta
 *    ninguno», which is worse than an absent one.
 *  - NO PRESCRIPTIONS. `prescription` owns them, no module imports another,
 *    and they will arrive the way the allergies do — through a shared port.
 */
@Injectable()
export class ChartSummaryService {
  constructor(
    @Inject(CHART_SUMMARY_REPOSITORY)
    private readonly summaries: ChartSummaryRepository,
    @Inject(ACTIVE_ALLERGY_READER)
    private readonly allergies: ActiveAllergyReader,
    /**
     * EN-087. Only for `standingAbsenceFor`, and it is a read.
     *
     * ⚠️ NOT THROUGH THE SHARED PORT, unlike the allergies themselves. «¿A qué
     * es alérgica esta persona?» is the question two modules ask and the reason
     * `ActiveAllergyReader` lives in `shared/`; «¿alguien afirmó que no tiene
     * ninguna?» is asked by this consultation and by nobody else — a
     * prescription is stopped by an allergy that EXISTS, and an assertion of
     * absence changes nothing it does. Widening the shared port for a caller
     * that does not exist is the symmetry `CLAUDE.md` §9 refuses.
     *
     * ⚠️ AND THIS SERVICE NEVER CALLS THE PORT'S WRITE METHODS. It is a read
     * model: it composes, owns no invariant and writes no clinical content.
     * Recording an allergy and asserting there are none are use cases of
     * `PatientAllergyService`, each with its own route, permission and audit
     * entry.
     */
    @Inject(PATIENT_ALLERGY_REPOSITORY)
    private readonly allergyRecords: PatientAllergyRepository,
    @Inject(PATIENT_HISTORY_REPOSITORY)
    private readonly historyRecords: PatientHistoryRepository,
    @Inject(ENCOUNTER_REPOSITORY)
    private readonly encounters: EncounterRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  /**
   * EN-159, EN-161. The history behind one attention.
   *
   * THE ATTENTION IS RESOLVED FIRST, WITHIN THE CALLER'S SCOPE, and the chart
   * is taken FROM THE ROW — never from the request. A `patientId` a caller
   * could name would make this route a way to read any chart's diagnoses with
   * a `record:read` granted for one site, which is the site scope with a hole
   * in it.
   *
   * ⚠️ ONE AUDIT ENTRY, AND IT IS WRITTEN BEFORE ANYTHING IS RETURNED. Opening
   * a patient's history IS the accountable act (EN-122): this payload carries
   * diagnoses, which is the most sensitive datum the system holds. What it
   * must NOT do is write one row per listed attention — «una vista que lea
   * cuarenta fichas sin dejar rastro» is what the trail exists to stop, and
   * forty rows that say nothing is how the accesses that matter get buried
   * (EN-123).
   *
   * AN ATTENTION THAT DOES NOT EXIST — or is outside the caller's scope — IS
   * NOT AUDITED: nothing was disclosed, and a row per guessed identifier would
   * let anybody fill the trail with noise (PA-024).
   */
  async forEncounter(
    encounterId: string,
    requester: Requester,
  ): Promise<ChartSummary> {
    const encounter = await this.encounters.findById({
      encounterId,
      sites: requester.sites,
    });
    if (!encounter) throw new EncounterNotFoundError();

    const query = {
      patientId: encounter.patientId,
      sites: requester.sites,
      excludeEncounterId: encounter.id,
      limit: PREVIOUS_ENCOUNTERS,
    };

    /**
     * FOUR STATEMENTS AND NOT FOUR ROUND TRIPS IN SEQUENCE. They share no
     * data, so waiting for each in turn would add latency to the one screen
     * that opens on every consultation — and a panel that arrives late is a
     * panel people learn to work without.
     */
    const [
      allergies,
      noKnownAllergies,
      history,
      previousEncounters,
      totalEncounters,
    ] = await Promise.all([
      this.allergies.activeFor(encounter.patientId),
      this.allergyRecords.standingAbsenceFor(encounter.patientId),
      this.historyRecords.activeFor(encounter.patientId),
      this.summaries.previousEncounters(query),
      this.summaries.countEncounters(query),
    ]);

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: encounter.patientId,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return {
      encounterId: encounter.id,
      patientId: encounter.patientId,
      allergies,
      noKnownAllergies,
      // EN-085. A ruled-out entry stays in the record and out of the summary,
      // as a refuted allergy does: the summary is what still counts.
      history,
      previousEncounters,
      totalEncounters,
    };
  }

  /**
   * EN-184. «Subsecuente» when the same category was diagnosed in an earlier
   * attention of the chart; «primera vez» otherwise. A proposal: the record
   * still demands `occurrence` (EN-045).
   *
   * It reads the history, so it is audited once, like the summary (EN-161).
   */
  async occurrenceProposal(
    encounterId: string,
    conceptId: string,
    requester: Requester,
  ): Promise<OccurrenceProposal> {
    const encounter = await this.encounters.findById({
      encounterId,
      sites: requester.sites,
    });
    if (!encounter) throw new EncounterNotFoundError();

    const code = await this.summaries.cie10CodeOf(conceptId);
    if (code === null) throw new ConceptWrongCatalogueError('CIE10');

    const basis = await this.summaries.priorDiagnosisInCategory({
      patientId: encounter.patientId,
      sites: requester.sites,
      encounterId: encounter.id,
      before: encounter.startedAt,
      category: cie10CategoryOf(code),
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: encounter.patientId,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return { proposed: basis === null ? 'FIRST_TIME' : 'SUBSEQUENT', basis };
  }

  /**
   * EN-185. EN-007 stands: an earlier attention in the service does NOT make
   * the consultation «subsecuente» — the patient may come for something new —
   * so with one on file nothing is proposed. Without any, «primera vez» is
   * certain. An appointment with no service type has no specialty to compare,
   * and nothing is proposed either.
   */
  async visitSequenceProposal(
    agendaEntryId: string,
    requester: Requester,
  ): Promise<VisitSequenceProposal> {
    const appointment = await this.summaries.appointmentForProposal(
      agendaEntryId,
      requester.sites,
    );
    // Out of scope, or no such appointment: nothing to propose and nothing
    // disclosed. Opening the attention refuses it on its own (EN-004).
    if (appointment?.specialtyId == null) {
      return {
        proposed: null,
        specialtyKnown: false,
        last: null,
        elsewhere: false,
      };
    }

    const service = {
      patientId: appointment.patientId,
      specialtyId: appointment.specialtyId,
      agendaEntryId,
    };
    const [last, anywhere] = await Promise.all([
      this.summaries.latestAttentionPossiblyInService({
        ...service,
        sites: requester.sites,
      }),
      this.summaries.anyAttentionPossiblyInService(service),
    ]);

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: appointment.patientId,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    // Certain only when there is none at ANY site; one the caller cannot see
    // is said as such, without saying anything of what it was.
    return {
      proposed: anywhere ? null : 'FIRST_TIME',
      specialtyKnown: true,
      last,
      elsewhere: anywhere && last === null,
    };
  }
}
