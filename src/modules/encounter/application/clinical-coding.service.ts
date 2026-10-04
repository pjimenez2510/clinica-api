import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  CLINICAL_CODING_REPOSITORY,
  type ClinicalCodingRepository,
  type DiagnosisView,
  type ProcedureView,
  type RetractedDiagnosisView,
} from '../domain/clinical-coding.repository';
import {
  ENCOUNTER_REPOSITORY,
  type EncounterRepository,
  type EncounterView,
} from '../domain/encounter.repository';
import {
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
} from '../domain/encounter.errors';
import { acceptsNewClinicalContent } from '../domain/encounter-state';
import type {
  CareModality,
  DiagnosisCertainty,
  DiagnosisOccurrence,
} from '../domain/encounter';
import type { Requester } from './encounter.service';

/**
 * Its own resource type in the trail, and not `'encounter'`.
 *
 * «¿Quién abrió la atención?» and «¿quién leyó el diagnóstico?» are two
 * questions, and a diagnosis is the most sensitive datum this system holds: it
 * is what an employer, an insurer or a neighbour would want. Recording it as
 * `'encounter'` would leave an investigation filtering by hand over rows that
 * mean two different things — the argument PA-040 already made for the
 * priority groups and this module made again for block D.
 */
const DIAGNOSIS_RESOURCE_TYPE = 'encounter_diagnosis';

/** Its own type for the same reason: a procedure is a different disclosure. */
const PROCEDURE_RESOURCE_TYPE = 'encounter_procedure';

/** EN-040 to EN-049. What registering a diagnosis needs to be told. */
export interface RecordDiagnosisRequest {
  encounterId: string;
  /** EN-040. A concept of the catalogue, never a code typed by hand. */
  conceptId: string;
  certainty: DiagnosisCertainty;
  /** EN-045. Per diagnosis, never derived from the attention's own sequence. */
  occurrence: DiagnosisOccurrence;
  /** EN-043, EN-047. Absent means «detrás del último». */
  rank?: number;
  /** EN-049. A stopgap until the concept carries the ministry's list. */
  notifiable?: boolean;
  note?: string;
}

/** EN-180 to EN-182. What removing a diagnosis needs to be told. */
export interface RetractDiagnosisRequest {
  encounterId: string;
  diagnosisId: string;
  /** EN-181. Required once the consultation note is signed. */
  reason?: string;
}

/** EN-047, EN-180. The diagnoses that count, and the trace of those removed. */
export interface DiagnosisSheet {
  items: DiagnosisView[];
  retracted: RetractedDiagnosisView[];
}

/** EN-050. What registering a procedure needs to be told. */
export interface RecordProcedureRequest {
  encounterId: string;
  conceptId: string;
  /** EN-050. Two extractions in one visit is the instructivo's own example. */
  quantity: number;
  performedAt?: Date;
  note?: string;
}

/**
 * Block K of the RDACAA: the diagnoses and the procedures of an attention.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A SERVICE OF ITS OWN, AND THE REASON IS NOT THE LINE COUNT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ADR-008 §2 splits on three limits and this crosses two of them. The
 * attention's service already publishes eight use cases — opening, reading,
 * listing, the open ones, closing, and the three of block D — and everything
 * here answers a question about a CATALOGUE CONCEPT rather than about the act:
 * which catalogue it came from, what it was called, whether it was in force
 * that day. The day the CIE-10 edition is replaced or the tariff republished,
 * this file moves and `EncounterService` does not. That is a second reason to
 * change, which is the third limit.
 *
 * ⚠️ WHAT THIS SERVICE DOES NOT DO, AND EACH ABSENCE IS A REQUIREMENT:
 *
 *  - IT DOES NOT LIMIT THE HISTORY TO THREE DIAGNOSES (EN-047). The RDACAA
 *    form has three boxes and a person can have five diseases; the trimming
 *    belongs to the export, exactly as PA-005 put the reduction of sex to two
 *    values in the ministry's file and not in the chart.
 *  - IT DOES NOT DERIVE `occurrence` FROM THE ATTENTION (EN-045). A patient
 *    seen for hypertension — subsequent — who is diagnosed with diabetes today
 *    — first time — is the ordinary case, and deriving it reports zero new
 *    cases of diabetes for the month.
 *  - IT DOES NOT PRICE ANYTHING (EN-051). No amount is read, written or
 *    served: the charge is `charge_item`, in `billing`, resolved from the
 *    price list of the payer on the service date.
 *  - IT DOES NOT CHECK THE DIAGNOSIS AGAINST THE PATIENT'S SEX OR AGE.
 *    ⚠️ **Falta esquema**, and it is written down rather than approximated: an
 *    obstetric code on a male patient and a neonatal one on an adult are both
 *    refusable ONLY if the catalogue says which codes apply to whom, and
 *    `catalog_concept.attributes` carries `{ level, chapter }` for CIE-10 and
 *    nothing else. Deriving it from the chapter would refuse real diagnoses —
 *    chapter XV holds codes that are legitimately coded on a newborn's chart —
 *    so the rule waits for the datum. The note is on EN-040 in the SPEC.
 */
@Injectable()
export class ClinicalCodingService {
  constructor(
    @Inject(CLINICAL_CODING_REPOSITORY)
    private readonly coding: ClinicalCodingRepository,
    @Inject(ENCOUNTER_REPOSITORY)
    private readonly encounters: EncounterRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ClinicalCodingService.name);
  }

  /**
   * EN-040 to EN-049. Registers one diagnosis.
   *
   * WHAT IS CHECKED HERE is the pair no constraint can see: that the attention
   * exists inside the caller's scope, and that it still admits new clinical
   * content. Everything else — the catalogue, the validity on the clinical
   * date, the rank still free — is arbitrated INSIDE the write, because every
   * one of them is a race and a read taken first can be stale by the time the
   * row lands.
   */
  async recordDiagnosis(
    request: RecordDiagnosisRequest,
    requester: Requester,
  ): Promise<DiagnosisView> {
    const encounter = await this.requireLiveEncounter(
      request.encounterId,
      requester,
    );

    const diagnosis = await this.coding.addDiagnosis({
      encounterId: encounter.id,
      conceptId: request.conceptId,
      certainty: request.certainty,
      occurrence: request.occurrence,
      rank: request.rank,
      notifiable: request.notifiable,
      note: request.note,
      sites: requester.sites,
    });

    /**
     * REQ-110, EN-122. The accountable act, recorded with the row that EXISTS
     * — after the write, so a refused insert leaves no entry claiming somebody
     * diagnosed something.
     *
     * `before`/`after` deliberately absent:
     * `access_audit_payload_only_for_declared_resources` refuses a payload
     * outside `'configuration'`, and a CIE-10 code landing in an append-only
     * table that is never purged could not afterwards be corrected or removed.
     */
    await this.audit.record({
      userId: requester.userId,
      resourceType: DIAGNOSIS_RESOURCE_TYPE,
      resourceId: diagnosis.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    /**
     * EN-124, SC-016. THE SITE AND THE FACT, AND NOT THE CODE. A CIE-10 code
     * in a log line is the diagnosis of an identifiable person sitting in a
     * file nobody treats as clinical — and nothing is interpolated, because
     * the logger prunes by allowlist and a template string walks past it.
     */
    this.logger.info(
      { site_id: encounter.siteId, action: 'DIAGNOSIS_RECORDED' },
      'diagnosis recorded',
    );

    return diagnosis;
  }

  /**
   * EN-047. The diagnoses of one attention, principal first.
   *
   * AUDITED, unlike the listing of attentions (EN-123), and the difference is
   * what travels: an attention carries identifiers and a state, this carries
   * what the person has.
   */
  async diagnosesOf(
    encounterId: string,
    requester: Requester,
  ): Promise<DiagnosisSheet> {
    const encounter = await this.requireEncounter(encounterId, requester);

    const query = { encounterId: encounter.id, sites: requester.sites };
    const [items, retracted] = await Promise.all([
      this.coding.diagnosesOf(query),
      // EN-180. The trace travels with the list: one read, one audit row.
      this.coding.retractedDiagnosesOf(query),
    ]);

    await this.audit.record({
      userId: requester.userId,
      resourceType: DIAGNOSIS_RESOURCE_TYPE,
      resourceId: encounter.id,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return { items, retracted };
  }

  /**
   * EN-180 to EN-182. Takes a diagnosis off a live attention, archived with
   * who removed it and, once the note is signed, why.
   *
   * The signed note and the documents that cite the diagnoses are judged by
   * the adapter under the attention's lock, because both can change between
   * a read here and the write.
   */
  async retractDiagnosis(
    request: RetractDiagnosisRequest,
    requester: Requester,
  ): Promise<void> {
    const encounter = await this.requireLiveEncounter(
      request.encounterId,
      requester,
    );
    const reason = request.reason?.trim();

    await this.coding.retractDiagnosis({
      encounterId: encounter.id,
      diagnosisId: request.diagnosisId,
      reason: reason === undefined || reason === '' ? null : reason,
      retractedById: requester.userId,
      sites: requester.sites,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: DIAGNOSIS_RESOURCE_TYPE,
      resourceId: request.diagnosisId,
      // An UPDATE of the attention's coding: the archive row is the record
      // of what was removed, and there is no DELETE action because nothing
      // clinical is ever deleted.
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    this.logger.info(
      { site_id: encounter.siteId, action: 'DIAGNOSIS_RETRACTED' },
      'diagnosis retracted',
    );
  }

  /**
   * EN-187. Corrects what the attention says the patient came for. Not the
   * report's classification — that is per diagnosis and derived (EN-046) —
   * so it is audited as the attention's own change.
   */
  async correctCareModality(
    encounterId: string,
    careModality: CareModality,
    requester: Requester,
  ): Promise<CareModality> {
    const encounter = await this.requireLiveEncounter(encounterId, requester);

    const corrected = await this.coding.setCareModality(
      { encounterId: encounter.id, sites: requester.sites },
      careModality,
    );

    await this.audit.record({
      userId: requester.userId,
      resourceType: 'encounter',
      resourceId: encounter.id,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return corrected;
  }

  /** EN-183. Makes a diagnosis the principal of its live attention. */
  async makePrimary(
    encounterId: string,
    diagnosisId: string,
    requester: Requester,
  ): Promise<DiagnosisView[]> {
    const encounter = await this.requireLiveEncounter(encounterId, requester);

    const diagnoses = await this.coding.makePrimary({
      encounterId: encounter.id,
      diagnosisId,
      sites: requester.sites,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: DIAGNOSIS_RESOURCE_TYPE,
      resourceId: diagnosisId,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return diagnoses;
  }

  /**
   * EN-050, EN-151. Registers one procedure with its quantity.
   *
   * ⚠️ NOTHING HERE ASKS FOR AN INFORMED CONSENT, AND THAT IS EN-151 WRITTEN
   * AS CODE. The A.M. 5316 §7.6.d is literal — «no se requiere un
   * consentimiento informado suscrito en las intervenciones de riesgo mínimo»
   * — and a consent barrier on the ordinary procedure is not merely useless
   * work: it trains everybody to click without reading, so the consent that
   * DOES matter gets signed with the same automatism. The barrier EN-152 asks
   * for is for major-risk procedures, and it needs two things that do not
   * exist yet — the risk classification on the service catalogue and the form
   * 024 table — so it is not approximated here.
   */
  async recordProcedure(
    request: RecordProcedureRequest,
    requester: Requester,
  ): Promise<ProcedureView> {
    const encounter = await this.requireLiveEncounter(
      request.encounterId,
      requester,
    );

    const procedure = await this.coding.addProcedure({
      encounterId: encounter.id,
      conceptId: request.conceptId,
      quantity: request.quantity,
      performedAt: request.performedAt,
      note: request.note,
      sites: requester.sites,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: PROCEDURE_RESOURCE_TYPE,
      resourceId: procedure.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    this.logger.info(
      { site_id: encounter.siteId, action: 'PROCEDURE_RECORDED' },
      'procedure recorded',
    );

    return procedure;
  }

  /** EN-050. The procedures of one attention. AUDITED, like the diagnoses. */
  async proceduresOf(
    encounterId: string,
    requester: Requester,
  ): Promise<ProcedureView[]> {
    const encounter = await this.requireEncounter(encounterId, requester);

    const procedures = await this.coding.proceduresOf({
      encounterId: encounter.id,
      sites: requester.sites,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: PROCEDURE_RESOURCE_TYPE,
      resourceId: encounter.id,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return procedures;
  }

  /**
   * EN-121. The attention, or the one refusal that covers «no existe» and «es
   * de otra sede».
   *
   * Telling them apart would confirm attentions of other sites to whoever
   * guesses identifiers, one at a time.
   */
  private async requireEncounter(
    encounterId: string,
    requester: Requester,
  ): Promise<EncounterView> {
    const encounter = await this.encounters.findById({
      encounterId,
      sites: requester.sites,
    });
    if (!encounter) throw new EncounterNotFoundError();
    return encounter;
  }

  /**
   * EN-009, EN-130. New clinical content goes into an attention that is still
   * live.
   *
   * A DIAGNOSIS IS NEW CONTENT AND NOT AN AMENDMENT, so `DISCHARGED` refuses
   * it: the doctor signed, the act is over, and coding a disease afterwards
   * would change what the consultation said without a single trace of a
   * correction. The way to add one is to amend the note that discharged it.
   */
  private async requireLiveEncounter(
    encounterId: string,
    requester: Requester,
  ): Promise<EncounterView> {
    const encounter = await this.requireEncounter(encounterId, requester);
    if (!acceptsNewClinicalContent(encounter.status)) {
      throw new EncounterAlreadyClosedError(encounter.status);
    }
    return encounter;
  }
}
