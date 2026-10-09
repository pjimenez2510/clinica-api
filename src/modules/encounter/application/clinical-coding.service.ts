import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  CONSULTATION_REPRICER,
  type ConsultationRepricer,
} from '../../../shared/billing/consultation-repricer.port';
import {
  PROCEDURE_CHARGE_SYNC,
  type ProcedureChargeSync,
} from '../../../shared/billing/procedure-charge-sync.port';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  CLINICAL_CODING_REPOSITORY,
  type ClinicalCodingRepository,
  type CorrectionAuthority,
  type DiagnosisVersionView,
  type DiagnosisView,
  type EncounterCodingView,
  type ProcedureVersionView,
  type ProcedureView,
  type RetractedDiagnosisView,
  type RetractedProcedureView,
} from '../domain/clinical-coding.repository';
import {
  ENCOUNTER_REPOSITORY,
  type EncounterRepository,
  type EncounterView,
} from '../domain/encounter.repository';
import {
  DiagnosisCorrectionRequiresSignatureError,
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
  PractitionerNotLicensedError,
  PractitionerProfileRequiredError,
  ProcedureRetractionReasonRequiredError,
} from '../domain/encounter.errors';
import {
  acceptsDiagnosisCorrection,
  acceptsNewClinicalContent,
  hasDischarge,
} from '../domain/encounter-state';
import type { SiteScopeFilter } from '../domain/encounter.repository';
import { afterDischargeRefusalOf } from '../domain/practitioner-licence';
import type {
  CareModality,
  CarePlace,
  DiagnosisCertainty,
  DiagnosisOccurrence,
  VisitSequence,
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

/** EN-180, EN-213, EN-214. What removing a diagnosis needs to be told. */
export interface RetractDiagnosisRequest {
  encounterId: string;
  diagnosisId: string;
  /** EN-214. Owed when an issued certificate or receta printed the code. */
  reason?: string;
}

/**
 * EN-212, D-117.13. Who is correcting, with where they may sign the history:
 * after the discharge the coding is corrected with `record:sign` at the
 * attention's site. Resolved by the controller from the session.
 */
export interface CodingRequester extends Requester {
  signSites: SiteScopeFilter;
}

/** EN-212. An edit in place: only what is present changes. */
export interface EditDiagnosisRequest {
  encounterId: string;
  diagnosisId: string;
  /** EN-040. A new concept of the catalogue, never a typed code. */
  conceptId?: string;
  certainty?: DiagnosisCertainty;
  occurrence?: DiagnosisOccurrence;
  primary?: boolean;
  /** EN-212. Owed when the code changes and a paper printed the old one. */
  reason?: string;
}

/** EN-047, EN-180. The diagnoses that count, and the trace of those removed. */
export interface DiagnosisSheet {
  /**
   * EN-189, EN-214. Each with whether an issued certificate or receta printed
   * its code: the screen asks for the reason before sending.
   */
  items: (DiagnosisView & {
    printedOnCertificate: boolean;
    printedOnPrescription: boolean;
    /** ORD-121. An issued order printed it: the laboratory holds the paper. */
    printedOnOrder: boolean;
  })[];
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

/** EN-244. A correction in place: only what is present changes. */
export interface EditProcedureRequest {
  encounterId: string;
  procedureId: string;
  conceptId?: string;
  quantity?: number;
  /** `null` clears the note. */
  note?: string | null;
}

/** EN-050, EN-245. The procedures that count, and the trace of those removed. */
export interface ProcedureSheet {
  items: ProcedureView[];
  retracted: RetractedProcedureView[];
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
    @Inject(CONSULTATION_REPRICER)
    private readonly consultationRepricer: ConsultationRepricer,
    @Inject(PROCEDURE_CHARGE_SYNC)
    private readonly procedureCharges: ProcedureChargeSync,
  ) {
    this.logger.setContext(ClinicalCodingService.name);
  }

  /**
   * EN-040 to EN-049, EN-215. Registers one diagnosis.
   *
   * WHAT IS CHECKED HERE is the pair no constraint can see: that the attention
   * exists inside the caller's scope, and that it still admits new clinical
   * content or — after the discharge — a correction by whoever signs. Everything else — the catalogue, the validity on the clinical
   * date, the rank still free — is arbitrated INSIDE the write, because every
   * one of them is a race and a read taken first can be stale by the time the
   * row lands.
   */
  async recordDiagnosis(
    request: RecordDiagnosisRequest,
    requester: CodingRequester,
  ): Promise<DiagnosisView> {
    // EN-215 (D-117.12). After the discharge the right code is still added:
    // the report reads the attention's diagnoses, not the note. It is a
    // correction of the coding, so D-117.13 and D-117.16 apply.
    const encounter = await this.requireCorrectableEncounter(
      request.encounterId,
      requester,
    );
    const authority = await this.correctionAuthority(encounter, requester);

    const diagnosis = await this.coding.addDiagnosis({
      mayCorrectAfterDischarge: authority.mayCorrectAfterDischarge,
      afterDischargeRefusal: authority.afterDischargeRefusal,
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
    const [diagnoses, retracted, printed, prescribed, ordered] =
      await Promise.all([
        this.coding.diagnosesOf(query),
        // EN-180. The trace travels with the list: one read, one audit row.
        this.coding.retractedDiagnosesOf(query),
        // EN-189, EN-214. So the screen asks for the reason before sending.
        this.coding.codesPrintedOnCertificates(query),
        this.coding.codesPrintedOnPrescriptions(query),
        this.coding.codesPrintedOnOrders(query),
      ]);
    const items = diagnoses.map((diagnosis) => ({
      ...diagnosis,
      printedOnCertificate: printed.includes(diagnosis.cie10Code),
      printedOnPrescription: prescribed.includes(diagnosis.cie10Code),
      printedOnOrder: ordered.includes(diagnosis.cie10Code),
    }));

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
   * EN-180, EN-188, EN-213, EN-214. Takes a diagnosis off a live or
   * discharged attention, archived with who removed it and — when a paper in
   * a third party's hands printed it — why.
   *
   * No confirmation is asked here (D-126.2): the screen confirms once a note
   * is signed or the attention discharged. Whether a reason is owed and the
   * refusals are judged by the adapter under the attention's lock, because
   * they can change between a read here and the write.
   */
  async retractDiagnosis(
    request: RetractDiagnosisRequest,
    requester: CodingRequester,
  ): Promise<void> {
    const encounter = await this.requireCorrectableEncounter(
      request.encounterId,
      requester,
    );
    const authority = await this.correctionAuthority(encounter, requester);
    const reason = request.reason?.trim();

    await this.coding.retractDiagnosis({
      encounterId: encounter.id,
      diagnosisId: request.diagnosisId,
      reason: reason === undefined || reason === '' ? null : reason,
      retractedById: requester.userId,
      mayCorrectAfterDischarge: authority.mayCorrectAfterDischarge,
      afterDischargeRefusal: authority.afterDischargeRefusal,
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
   * EN-213. «Deshacer» a removal: the diagnosis comes back as it was, behind
   * the principal if another took its place. Only while the attention admits
   * new clinical content (EN-009): bringing a diagnosis back is recording it.
   */
  async restoreDiagnosis(
    encounterId: string,
    diagnosisId: string,
    requester: Requester,
  ): Promise<DiagnosisView> {
    const encounter = await this.requireLiveEncounter(encounterId, requester);

    const diagnosis = await this.coding.restoreDiagnosis({
      encounterId: encounter.id,
      retractionId: diagnosisId,
      restoredById: requester.userId,
      sites: requester.sites,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: DIAGNOSIS_RESOURCE_TYPE,
      resourceId: diagnosis.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    this.logger.info(
      { site_id: encounter.siteId, action: 'DIAGNOSIS_RESTORED' },
      'diagnosis restored',
    );

    return diagnosis;
  }

  /**
   * EN-187, EN-215. Corrects what the attention says the patient came for
   * and whether it is first-time or subsequent — also after the discharge
   * (D-127), by whoever may correct the coding then (D-117.13). Not the
   * report's per-diagnosis classification — that is derived (EN-046) — so it
   * is audited as the attention's own change. The previous attention is the
   * database's version (`record_version`).
   *
   * BI-203 (D-134.2). A corrected sequence changes which consultation is
   * charged (BI-158). The charge is `billing`'s, so it is told through the
   * shared port AFTER this transaction, and it reprices the line that is
   * still unbilled. The port never throws: the clinical correction stands.
   */
  async correctEncounterCoding(
    request: {
      encounterId: string;
      careModality?: CareModality;
      visitSequence?: VisitSequence;
      carePlace?: CarePlace;
      medicoDelBarrio?: boolean;
    },
    requester: CodingRequester,
  ): Promise<EncounterCodingView> {
    const encounter = await this.requireCorrectableEncounter(
      request.encounterId,
      requester,
    );
    const authority = await this.correctionAuthority(encounter, requester);

    const corrected = await this.coding.correctEncounterCoding({
      encounterId: encounter.id,
      careModality: request.careModality,
      visitSequence: request.visitSequence,
      carePlace: request.carePlace,
      medicoDelBarrio: request.medicoDelBarrio,
      sites: requester.sites,
      ...authority,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: 'encounter',
      resourceId: encounter.id,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    if (request.visitSequence !== undefined) {
      await this.consultationRepricer.repriceConsultation({
        encounterId: encounter.id,
        siteId: encounter.siteId,
        changedById: requester.userId,
      });
    }

    return corrected;
  }

  /**
   * EN-183, EN-212. Makes a diagnosis the principal of its attention, also
   * after the discharge (D-127): the previous rank is a version.
   */
  async makePrimary(
    encounterId: string,
    diagnosisId: string,
    requester: CodingRequester,
  ): Promise<DiagnosisView[]> {
    const encounter = await this.requireCorrectableEncounter(
      encounterId,
      requester,
    );
    const authority = await this.correctionAuthority(encounter, requester);

    const diagnoses = await this.coding.makePrimary({
      encounterId: encounter.id,
      diagnosisId,
      sites: requester.sites,
      ...authority,
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
   * EN-212 (D-127). Edits a diagnosis in place: its code, its certainty, its
   * occurrence and whether it is the principal. The previous version is kept
   * by the database (`record_version`); nothing is removed and recorded again.
   *
   * No confirmation is asked here, and none is owed (D-126): the screen
   * confirms once the note is signed or the attention discharged. What the
   * API demands is the reason when a paper in a third party's hands printed
   * the old code, and — after the discharge — `record:sign` and a registration
   * in force (D-117.13).
   */
  async editDiagnosis(
    request: EditDiagnosisRequest,
    requester: CodingRequester,
  ): Promise<DiagnosisView> {
    const encounter = await this.requireCorrectableEncounter(
      request.encounterId,
      requester,
    );
    const authority = await this.correctionAuthority(encounter, requester);
    const reason = request.reason?.trim();

    const diagnosis = await this.coding.editDiagnosis({
      encounterId: encounter.id,
      diagnosisId: request.diagnosisId,
      conceptId: request.conceptId,
      certainty: request.certainty,
      occurrence: request.occurrence,
      primary: request.primary,
      reason: reason === undefined || reason === '' ? null : reason,
      sites: requester.sites,
      ...authority,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: DIAGNOSIS_RESOURCE_TYPE,
      resourceId: diagnosis.id,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    this.logger.info(
      { site_id: encounter.siteId, action: 'DIAGNOSIS_EDITED' },
      'diagnosis edited',
    );

    return diagnosis;
  }

  /**
   * EN-212. The versions an edit replaced, most recent first. The same
   * content as the diagnosis, only earlier: `record:read` and one audit row.
   */
  async diagnosisVersions(
    encounterId: string,
    diagnosisId: string,
    requester: Requester,
  ): Promise<DiagnosisVersionView[]> {
    const encounter = await this.requireEncounter(encounterId, requester);

    const versions = await this.coding.diagnosisVersions({
      encounterId: encounter.id,
      diagnosisId,
      sites: requester.sites,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: DIAGNOSIS_RESOURCE_TYPE,
      resourceId: diagnosisId,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return versions;
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

  /**
   * EN-050, EN-245. The procedures of one attention, with the removed ones
   * apart. AUDITED, like the diagnoses: one read, one audit row.
   */
  async proceduresOf(
    encounterId: string,
    requester: Requester,
  ): Promise<ProcedureSheet> {
    const encounter = await this.requireEncounter(encounterId, requester);

    const query = { encounterId: encounter.id, sites: requester.sites };
    const [items, retracted] = await Promise.all([
      this.coding.proceduresOf(query),
      this.coding.retractedProceduresOf(query),
    ]);
    const procedures = { items, retracted };

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
   * EN-244 (D-194.1). Corrects a procedure in place while the attention
   * admits new content — the rule of recording it (EN-009). The previous row
   * is the database's version. BI-240: `billing` follows the proposed charge,
   * told after this transaction; the port never throws.
   */
  async editProcedure(
    request: EditProcedureRequest,
    requester: Requester,
  ): Promise<ProcedureView> {
    const encounter = await this.requireLiveEncounter(
      request.encounterId,
      requester,
    );
    const note = request.note === undefined ? undefined : request.note?.trim();

    const procedure = await this.coding.editProcedure({
      encounterId: encounter.id,
      procedureId: request.procedureId,
      conceptId: request.conceptId,
      quantity: request.quantity,
      note: note === undefined ? undefined : note === '' ? null : note,
      editedById: requester.userId,
      sites: requester.sites,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: PROCEDURE_RESOURCE_TYPE,
      resourceId: procedure.id,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
    this.logger.info(
      { site_id: encounter.siteId, action: 'PROCEDURE_EDITED' },
      'procedure edited',
    );
    await this.procedureCharges.procedureChanged({
      encounterId: encounter.id,
      siteId: encounter.siteId,
      changedById: requester.userId,
      procedureId: procedure.id,
      change: 'EDITED',
    });

    return procedure;
  }

  /** EN-244. The versions corrections replaced. `record:read`, audited. */
  async procedureVersions(
    encounterId: string,
    procedureId: string,
    requester: Requester,
  ): Promise<ProcedureVersionView[]> {
    const encounter = await this.requireEncounter(encounterId, requester);

    const versions = await this.coding.procedureVersions({
      encounterId: encounter.id,
      procedureId,
      sites: requester.sites,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: PROCEDURE_RESOURCE_TYPE,
      resourceId: procedureId,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return versions;
  }

  /**
   * EN-245 (D-194.2). Takes a procedure off a live attention, archived with
   * who, when and why. BI-241: a proposed charge goes with it.
   */
  async retractProcedure(
    request: { encounterId: string; procedureId: string; reason?: string },
    requester: Requester,
  ): Promise<void> {
    const encounter = await this.requireLiveEncounter(
      request.encounterId,
      requester,
    );
    const reason = request.reason?.trim();
    if (reason === undefined || reason === '') {
      throw new ProcedureRetractionReasonRequiredError();
    }

    await this.coding.retractProcedure({
      encounterId: encounter.id,
      procedureId: request.procedureId,
      reason,
      retractedById: requester.userId,
      sites: requester.sites,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: PROCEDURE_RESOURCE_TYPE,
      resourceId: request.procedureId,
      // Nothing clinical is ever deleted: the archive keeps it.
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
    this.logger.info(
      { site_id: encounter.siteId, action: 'PROCEDURE_RETRACTED' },
      'procedure retracted',
    );
    await this.procedureCharges.procedureChanged({
      encounterId: encounter.id,
      siteId: encounter.siteId,
      changedById: requester.userId,
      procedureId: request.procedureId,
      change: 'RETRACTED',
    });
  }

  /**
   * EN-246. Brings a removed procedure back as a new row, only while the
   * attention is live. BI-242: with an open account its charge is proposed.
   */
  async restoreProcedure(
    encounterId: string,
    procedureId: string,
    requester: Requester,
  ): Promise<ProcedureView> {
    const encounter = await this.requireLiveEncounter(encounterId, requester);

    const procedure = await this.coding.restoreProcedure({
      encounterId: encounter.id,
      retractionId: procedureId,
      restoredById: requester.userId,
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
      { site_id: encounter.siteId, action: 'PROCEDURE_RESTORED' },
      'procedure restored',
    );
    await this.procedureCharges.procedureChanged({
      encounterId: encounter.id,
      siteId: encounter.siteId,
      changedById: requester.userId,
      procedureId: procedure.id,
      change: 'RESTORED',
    });

    return procedure;
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
   * A PROCEDURE, and bringing back a removed diagnosis (EN-213), are new
   * content: `DISCHARGED` refuses them. A NEW DIAGNOSIS after the discharge
   * is not refused here since EN-215 (D-117.12): it is a correction of the
   * coding the report reads, with its own rules (`correctionAuthority`).
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

  /**
   * EN-212, D-117.13. After the discharge the coding is corrected by whoever
   * may sign the history at the attention's site, with an ACESS registration
   * in force — the rule of the amendment (EN-025). Before it, by whoever codes.
   *
   * THE ANSWER IS DECIDED WHATEVER THE STATE READ HERE — signing at the site
   * AND the licence in force — and travels to the adapter, which asks again
   * under the attention's lock: a discharge that lands between this read and
   * the write is refused there with the same sentence it would get here.
   */
  private async correctionAuthority(
    encounter: EncounterView,
    requester: CodingRequester,
  ): Promise<CorrectionAuthority> {
    const signsHere =
      requester.signSites === 'all' ||
      requester.signSites.includes(encounter.siteId);
    const refusal = afterDischargeRefusalOf(
      signsHere,
      signsHere
        ? await this.encounters.findPractitionerByUser(requester.userId)
        : null,
      new Date(),
    );

    if (hasDischarge(encounter.status)) {
      if (refusal === 'NOT_SIGNER') {
        throw new DiagnosisCorrectionRequiresSignatureError();
      }
      if (refusal === 'NO_PRACTITIONER_PROFILE') {
        throw new PractitionerProfileRequiredError();
      }
      if (refusal === 'NOT_LICENSED') throw new PractitionerNotLicensedError();
    }

    return {
      editedById: requester.userId,
      mayCorrectAfterDischarge: refusal === undefined,
      ...(refusal === undefined ? {} : { afterDischargeRefusal: refusal }),
    };
  }

  /**
   * EN-188. Correcting the coding reaches past the discharge (D-117.8): the
   * report reads these rows, and amending the note does not change them.
   */
  private async requireCorrectableEncounter(
    encounterId: string,
    requester: Requester,
  ): Promise<EncounterView> {
    const encounter = await this.requireEncounter(encounterId, requester);
    if (!acceptsDiagnosisCorrection(encounter.status)) {
      throw new EncounterAlreadyClosedError(encounter.status);
    }
    return encounter;
  }
}
