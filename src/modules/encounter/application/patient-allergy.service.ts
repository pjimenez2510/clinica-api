import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  ACTIVE_ALLERGY_READER,
  type ActiveAllergy,
  type ActiveAllergyReader,
  type AllergyCriticality,
} from '../../../shared/clinical/patient-allergy.port';
import {
  ENCOUNTER_REPOSITORY,
  type EncounterRepository,
} from '../domain/encounter.repository';
import {
  ChartHasAllergiesError,
  PatientAllergyNotFoundError,
  PatientChartNotOpenError,
  RefutationReasonRequiredError,
} from '../domain/encounter.errors';
import {
  PATIENT_ALLERGY_REPOSITORY,
  type AllergyAbsenceAssertion,
  type AllergyView,
  type PatientAllergyRepository,
} from '../domain/patient-allergy.repository';
import type { Requester } from './encounter.service';

/**
 * Its own resource type in the trail, and not `'patient'`.
 *
 * «¿Quién abrió la ficha de esta persona?» and «¿quién leyó, escribió o
 * descartó sus alergias?» are two questions, and answering the second by
 * filtering `'patient'` rows by hand is how an investigation gets the wrong
 * answer. It is the argument PA-040 made for the priority groups and this
 * module made again for block D and for the diagnoses.
 *
 * ⚠️ AND IT IS THE ONLY ANSWER TO «¿QUIÉN DIJO QUE ERA ALÉRGICO?» TODAY.
 * EN-086 asks for the author on the row and `patient_allergy` has
 * `recorded_at` and no author column — **falta esquema**. The trail is a
 * weaker answer than the requirement asks for, because the trail is not the
 * datum: it can be queried by an administrator and it is not what a doctor
 * reads on the screen beside the allergy. Writing it is what keeps the
 * question answerable at all until the column lands, exactly as EN-143 is
 * being held up by the same stopgap for the vital signs.
 */
const RESOURCE_TYPE = 'patient_allergy';

/** EN-080, EN-083. What recording an allergy needs to be told. */
export interface RecordAllergyRequest {
  patientId: string;
  /** EN-080. A CNMB concept when the allergen is a drug; absent otherwise. */
  substanceConceptId?: string;
  substanceText: string;
  reaction?: string;
  /** EN-083. Asked for, never defaulted into an assertion nobody made. */
  criticality: AllergyCriticality;
}

/**
 * EN-082, EN-087. The chart's allergies as the listing serves them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TRES ESTADOS, NO DOS — y la lista sola sólo podía expresar dos
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   - `allergies` con filas                  → hay alergias registradas
 *   - `allergies` vacío, `noKnownAllergies`  → «sin alergias conocidas (quién, cuándo)»
 *   - `allergies` vacío y `null`             → «no se preguntó»
 *
 * `null` es «no se preguntó» y NUNCA «no tiene». Es la dirección segura y la
 * que el estándar obliga: lo contrario sería el sistema afirmando por su cuenta
 * algo que ningún clínico dijo.
 */
export interface AllergyChart {
  /** EN-082. Worst first, refuted ones included. */
  allergies: readonly AllergyView[];
  /** EN-087. The STANDING assertion, or `null` for «no se preguntó». */
  noKnownAllergies: AllergyAbsenceAssertion | null;
}

/** EN-082. What ruling one out needs to be told. */
export interface RefuteAllergyRequest {
  patientId: string;
  allergyId: string;
  notes: string;
}

/**
 * REQ-008 — the half that saves a life, and the half that hides one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A SERVICE OF ITS OWN, AND THE REASON IS NOT THE LINE COUNT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ADR-008 §2 splits on three limits and this crosses two. `EncounterService`
 * already publishes eight public use cases, and everything here is about a
 * PATIENT rather than about an attention: an allergy outlives every
 * consultation it was ever read in, it is addressed by the chart and not by
 * the encounter, and it shares no dependency with the attention's state
 * machine. The table even belongs to another module's schema — it is
 * `patients`' — and lives here because REQ-008's rule is «visible durante la
 * consulta», which is this module.
 *
 * ⚠️ WHAT THIS SERVICE DOES NOT DO, AND THE ABSENCES ARE REQUIREMENTS:
 *
 *  - IT NEVER DELETES (EN-082). There is no method, and the controller has no
 *    route. «Saber que una alergia se descartó es información clínica por
 *    derecho propio»: the patient told they were allergic to penicillin and
 *    who turned out not to be needs THAT on the record, or in two years
 *    somebody writes it again and again withholds the right antibiotic.
 *  - IT DOES NOT CHECK A PRESCRIPTION (EN-084). That check belongs to
 *    `prescription`, which reads the same rows through the same shared reader.
 *    Doing it here would be this module deciding what may be prescribed.
 *  - IT DOES NOT DEFAULT THE CRITICALITY (EN-083). The COLUMN defaults to
 *    `UNABLE_TO_ASSESS`, which honestly says «nadie lo evaluó»; what no code
 *    path does is turn a missing answer into `LOW`.
 */
@Injectable()
export class PatientAllergyService {
  constructor(
    @Inject(PATIENT_ALLERGY_REPOSITORY)
    private readonly allergies: PatientAllergyRepository,
    @Inject(ACTIVE_ALLERGY_READER)
    private readonly activeAllergies: ActiveAllergyReader,
    @Inject(ENCOUNTER_REPOSITORY)
    private readonly encounters: EncounterRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PatientAllergyService.name);
  }

  /**
   * EN-080, EN-083. Records one allergy.
   *
   * THE CHART IS CHECKED FIRST, and an absorbed one is refused. A merge
   * re-points nothing (D-031) and the survivor reads the absorbed chart's rows
   * through the link — so an allergy WRITTEN onto an absorbed chart today
   * would still be visible, and would still be right. What makes it wrong is
   * undoing the merge: the allergy recorded after the merge, on the chart that
   * has just been separated again, walks away with the wrong person. The rule
   * is the same one `open` applies (EN-001): you write on the live chart.
   *
   * AUDITED AS A CREATION. It is clinical content about an identifiable
   * person, and until the row carries an author (EN-086) this entry is the
   * only record of who said it.
   */
  async record(
    request: RecordAllergyRequest,
    requester: Requester,
  ): Promise<AllergyView> {
    await this.requireOpenChart(request.patientId);

    const allergy = await this.allergies.record({
      patientId: request.patientId,
      substanceConceptId: request.substanceConceptId,
      substanceText: request.substanceText,
      reaction: request.reaction,
      criticality: request.criticality,
      recordedById: requester.userId,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: allergy.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
      // `before`/`after` deliberately absent, as everywhere in this module:
      // `access_audit_payload_only_for_declared_resources` refuses a payload
      // outside `'configuration'`, and recording does not throw — the entry
      // would simply be lost.
    });

    /**
     * EN-124, SC-016. THE FACT AND NOTHING ELSE. No patient, no substance, no
     * reaction — and nothing interpolated: the logger prunes by allowlist and
     * a template string walks straight past it. «Fulano es alérgico a la
     * penicilina» in a log file is a health datum leaving the database's
     * access controls behind, and there is no site to name here because an
     * allergy has none.
     */
    this.logger.info({ action: 'ALLERGY_RECORDED' }, 'allergy recorded');

    return allergy;
  }

  /**
   * EN-082. Rules one out. NEVER deletes it.
   *
   * THE REASON IS DEMANDED HERE AND NOT ONLY IN THE DTO, the same belt and
   * braces `AMENDMENT_REASON_REQUIRED` gets: the DTO guards one door, and an
   * import, a console or a use case written in two years all arrive at this
   * method. A refutation with no reason is a row a future doctor cannot decide
   * whether to trust — which makes it worse than no row.
   *
   * NO CHART CHECK, unlike `record`, and the difference is deliberate: this
   * writes nothing new about the person, it CORRECTS something already on the
   * chart. Refusing it on an absorbed chart would leave a wrong allergy
   * visible on the survivor's screen with no way to retract it, which is the
   * opposite of what the requirement is for.
   */
  async refute(
    request: RefuteAllergyRequest,
    requester: Requester,
  ): Promise<AllergyView> {
    if (request.notes.trim().length === 0) {
      throw new RefutationReasonRequiredError();
    }

    const refuted = await this.allergies.refute({
      patientId: request.patientId,
      allergyId: request.allergyId,
      notes: request.notes,
      // Taken once and handed down: the domain owns no clock, and two readings
      // could straddle a second for no reason.
      now: new Date(),
      refutedById: requester.userId,
    });

    // `null` is «not on this chart nor on any it absorbed». One answer for
    // that and for «no existe», the line `ENCOUNTER_NOT_FOUND` already took.
    if (refuted === null) throw new PatientAllergyNotFoundError();

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: refuted.id,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    this.logger.info({ action: 'ALLERGY_REFUTED' }, 'allergy refuted');

    return refuted;
  }

  /**
   * EN-080 to EN-083, EN-087. The chart's allergies AND the standing
   * «sin alergias conocidas»: the refuted ones included, the third state too.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * THE TWO HALVES TRAVEL TOGETHER BECAUSE ONE ALONE ONLY HAS TWO STATES
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A list on its own cannot tell «sin alergias conocidas, afirmado por la Dra.
   * X el 14-03-2026» from «nadie lo preguntó»: both arrive as zero rows. HL7's
   * International Patient Summary is literal about which of the two a system
   * may assert on its own — `nilknown` is «una afirmación positiva por parte de
   * un usuario clínico, **y no una posición por defecto afirmada por un sistema
   * informático a falta de otra información**» — so the assertion has to be
   * SERVED, with its author and its instant, or it cannot be read.
   *
   * ⚠️ THE SAME QUESTION `chart-summary` ALREADY ASKS (EN-159), through the
   * same port method and resolved over the chart AND the charts it absorbed. A
   * second way of deciding whether an assertion still stands would eventually
   * disagree with the first, and what it would disagree about is the case the
   * requirement was written for: asserted in March, penicillin in April,
   * refuted in May — the chart is empty again and NOBODY HAS ASKED SINCE.
   *
   * ⚠️ AUDITED, AND THIS IS THE ONE LISTING IN THE MODULE THAT IS. EN-123
   * leaves listings out of the trail because they carry identifiers and no
   * clinical content — `EncounterView` is built around that promise. This one
   * breaks it: an allergy IS clinical content, and «esta persona es alérgica a
   * la penicilina» is exactly the sort of disclosure the LOPDP expects us to
   * be able to reconstruct. ONE entry per READ — not one per row, and not a
   * second one for the assertion: it is the same disclosure and the same act.
   */
  async listFor(
    patientId: string,
    requester: Requester,
  ): Promise<AllergyChart> {
    const chart = await this.requireOpenChart(patientId);
    const [allergies, noKnownAllergies] = await Promise.all([
      this.allergies.listFor(chart),
      this.allergies.standingAbsenceFor(chart),
    ]);

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: chart,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return { allergies, noKnownAllergies };
  }

  /**
   * EN-087. «Sin alergias conocidas», affirmed BY THIS PERSON, right now.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * THE THIRD STATE, AND THE ONE ALMOST NOBODY IMPLEMENTS (D-A-018)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * HL7's International Patient Summary — aligned with ISO 27269 — separates
   * `nilknown` from `notasked`, and defines the first one like this:
   *
   *   «Esto es una afirmación positiva por parte de un usuario clínico, y no
   *    una posición por defecto afirmada por un sistema informático a falta de
   *    otra información.»
   *
   * Which is why this is a use case with a caller, a route and a permission,
   * and not a branch inside a reader. `activeFor` returning an empty list means
   * «no consta ninguna», and no amount of reading it cleverly turns that into
   * «no tiene»: the only thing that can is a person saying so.
   *
   * THE CHART IS CHECKED FIRST AND AN ABSORBED ONE IS REFUSED, exactly as in
   * `record` and for the same reason: this writes something NEW about the
   * person, and an assertion written onto a chart that is later separated again
   * walks away with the wrong one.
   *
   * ⚠️ IT REFUSES A CHART THAT HAS ALLERGIES, and the way out is to refute them
   * one by one with their reason (EN-082) — a clinical judgement per allergy,
   * never the side effect of ticking a box. The read here is the SHARED one, so
   * the question asked is the same «¿a qué es alérgica esta persona?» a
   * prescription asks, chart scope included. The database refuses it again:
   * this service cannot see the request that is recording an allergy at the
   * same instant, and only `trg_patient_allergy_absence_empty_chart` arbitrates
   * that.
   *
   * AUDITED AS A CREATION. «Esta persona no tiene alergias conocidas» is a
   * clinical assertion about an identifiable person that changes what gets
   * prescribed, and the row itself already names its author — unlike
   * `patient_allergy`, which still cannot (EN-086).
   */
  async assertNoKnownAllergies(
    patientId: string,
    requester: Requester,
  ): Promise<AllergyAbsenceAssertion> {
    await this.requireOpenChart(patientId);

    const active = await this.activeAllergies.activeFor(patientId);
    if (active.length > 0) throw new ChartHasAllergiesError();

    const assertion = await this.allergies.assertNoKnownAllergies({
      patientId,
      assertedById: requester.userId,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: assertion.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    // EN-124, SC-016. The fact and nothing else, and nothing interpolated:
    // «Fulano no tiene alergias» is still a health datum about a named person.
    this.logger.info(
      { action: 'NO_KNOWN_ALLERGIES_ASSERTED' },
      'no known allergies asserted',
    );

    return assertion;
  }

  /**
   * EN-081, EN-084. The chart's active allergies.
   *
   * ⚠️ THROUGH THE SHARED READER AND NOT THROUGH THIS MODULE'S REPOSITORY, on
   * purpose: this is the SAME statement `prescription` will run to check what
   * is being prescribed (EN-084). One predicate, one place to be wrong, and
   * the thing it would be wrong about is the chart scope — the merged chart
   * whose penicillin allergy stops being visible.
   *
   * NOT AUDITED HERE. Its callers audit the act they are performing: opening
   * an attention (EN-122) or reading the chart summary (EN-161). An entry
   * written here as well would double every one of those, which is the
   * burying EN-123 exists to prevent.
   */
  async activeFor(patientId: string): Promise<readonly ActiveAllergy[]> {
    return this.activeAllergies.activeFor(patientId);
  }

  /**
   * EN-001, PA-045. The chart exists and no merge absorbed it.
   *
   * REUSES `EncounterRepository.findPatientChart` rather than asking the same
   * question a second way. A chart that does not exist and one that was
   * absorbed answer the same refusal, for the reason written on
   * `PatientChartNotOpenError`: the surviving MRN of somebody else's chart is
   * not a datum this module hands out one guess at a time.
   */
  private async requireOpenChart(patientId: string): Promise<string> {
    const chart = await this.encounters.findPatientChart(patientId);
    if (!chart || chart.mergedIntoId !== null) {
      throw new PatientChartNotOpenError();
    }
    return chart.id;
  }
}
