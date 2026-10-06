import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  ACTIVE_ALLERGY_READER,
  type ActiveAllergyReader,
} from '../../../shared/clinical/patient-allergy.port';
import {
  ENCOUNTER_REPOSITORY,
  type EncounterRepository,
} from '../domain/encounter.repository';
import {
  ChartHasAllergiesError,
  NoKnownAllergiesNotStandingError,
  PatientChartNotOpenError,
} from '../domain/encounter.errors';
import {
  PATIENT_ALLERGY_REPOSITORY,
  type AllergyAbsenceAssertion,
  type PatientAllergyRepository,
} from '../domain/patient-allergy.repository';
import type { Requester } from './encounter.service';

/**
 * The trail names the table the rows live in, as the allergy service does:
 * the assertion is part of the chart's allergy record.
 */
const RESOURCE_TYPE = 'patient_allergy';

/**
 * EN-087, EN-226. «Sin alergias conocidas»: asserting it, asserting it after
 * ruling out the allergies the screen listed, and withdrawing one made by
 * mistake.
 *
 * A SERVICE OF ITS OWN (ADR-008 §2): with editing, reactivating and the
 * versions, `PatientAllergyService` would publish ten use cases, and these
 * three change for one reason of their own — what the third state of the
 * allergy band means. They share the repository, not the rules.
 */
@Injectable()
export class NoKnownAllergiesService {
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
    this.logger.setContext(NoKnownAllergiesService.name);
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
   * ⚠️ IT REFUSES A CHART THAT HAS ALLERGIES, and the way out is to refute
   * them —since EN-226 in the same step, `assertRefuting`, naming each one: the
   * list the screen showed is the clinical judgement, never the side effect of
   * ticking a box. The read here is the SHARED one, so
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

    await this.auditAssertion(assertion.id, 'CREATE', requester);

    // EN-124, SC-016. The fact and nothing else, and nothing interpolated:
    // «Fulano no tiene alergias» is still a health datum about a named person.
    this.logger.info(
      { action: 'NO_KNOWN_ALLERGIES_ASSERTED' },
      'no known allergies asserted',
    );

    return assertion;
  }

  /**
   * EN-226. «Descartar estas y afirmar»: the screen lists the active
   * allergies and the person rules them out and asserts, in ONE step and one
   * transaction, without a reason.
   *
   * ⚠️ THE BRAKE STAYS. Every active allergy has to be NAMED: one that was not
   * on the screen —recorded by a colleague a moment ago— is not ruled out by
   * accident, and the request is refused with `CHART_HAS_ALLERGIES` without
   * refuting any. The service compares first for the sentence; the database
   * decides under concurrency (`trg_patient_allergy_absence_empty_chart`
   * sees this transaction's refutations and none of a colleague's insert).
   */
  async assertRefuting(
    patientId: string,
    allergyIds: readonly string[],
    requester: Requester,
  ): Promise<AllergyAbsenceAssertion> {
    await this.requireOpenChart(patientId);

    const named = new Set(allergyIds);
    const active = await this.activeAllergies.activeFor(patientId);
    if (active.some((allergy) => !named.has(allergy.id))) {
      throw new ChartHasAllergiesError();
    }

    const assertion = await this.allergies.refuteAndAssertNoKnownAllergies({
      patientId,
      allergyIds: [...named],
      actorId: requester.userId,
      now: new Date(),
    });

    for (const allergyId of named) {
      await this.audit.record({
        userId: requester.userId,
        resourceType: RESOURCE_TYPE,
        resourceId: allergyId,
        action: 'UPDATE',
        ip: requester.ip,
        userAgent: requester.userAgent,
      });
    }
    await this.auditAssertion(assertion.id, 'CREATE', requester);
    this.logger.info(
      { action: 'NO_KNOWN_ALLERGIES_ASSERTED_REFUTING' },
      'no known allergies asserted after refuting the active ones',
    );

    return assertion;
  }

  /**
   * EN-226. Withdraws the chart's STANDING «sin alergias conocidas», asserted
   * by mistake. The row stays —who asserted it and when never change— with
   * who withdrew it and when, and the chart goes back to «no se preguntó».
   * Nothing standing to withdraw is `NO_KNOWN_ALLERGIES_NOT_STANDING`: a
   * colleague withdrew it, or an allergy recorded since already ended it.
   *
   * NO CHART CHECK, like refuting an allergy: it corrects what is on the
   * chart, reachable from the survivor.
   */
  async retract(patientId: string, requester: Requester): Promise<void> {
    const standing = await this.allergies.standingAbsenceFor(patientId);
    if (standing === null) throw new NoKnownAllergiesNotStandingError();

    const retracted = await this.allergies.retractNoKnownAllergies({
      assertionId: standing.id,
      patientId,
      retractedById: requester.userId,
      now: new Date(),
    });
    if (!retracted) throw new NoKnownAllergiesNotStandingError();

    await this.auditAssertion(standing.id, 'UPDATE', requester);
    this.logger.info(
      { action: 'NO_KNOWN_ALLERGIES_RETRACTED' },
      'no known allergies retracted',
    );
  }

  private async auditAssertion(
    assertionId: string,
    action: 'CREATE' | 'UPDATE',
    requester: Requester,
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: assertionId,
      action,
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }

  /** EN-001, PA-045. The chart exists and no merge absorbed it. */
  private async requireOpenChart(patientId: string): Promise<void> {
    const chart = await this.encounters.findPatientChart(patientId);
    if (!chart || chart.mergedIntoId !== null) {
      throw new PatientChartNotOpenError();
    }
  }
}
