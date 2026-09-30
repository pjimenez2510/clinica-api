import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  EncounterAlreadyClosedError,
  EncounterNotFoundError,
  PatientChartNotOpenError,
  PractitionerProfileRequiredError,
} from '../domain/encounter.errors';
import {
  ENCOUNTER_REPOSITORY,
  type EncounterPage,
  type EncounterRepository,
  type EncounterView,
  type SiteScopeFilter,
  type VitalSignsView,
} from '../domain/encounter.repository';
import { acceptsNewClinicalContent } from '../domain/encounter-state';
import { planClosure } from '../domain/encounter-closure';
import {
  assertMandatoryAnthropometry,
  type VitalSigns,
} from '../domain/vital-signs';
import type {
  CareModality,
  CareSetting,
  VisitSequence,
} from '../domain/encounter';

/**
 * The resource type the access trail uses for an attention.
 *
 * DISTINCT FROM `'patient'`, exactly as `patient_sexual_orientation` is:
 * «¿quién abrió la ficha de esta persona?» and «¿quién abrió una atención
 * suya?» are two questions, and answering the second by filtering `'patient'`
 * rows by hand is how an investigation gets the wrong answer.
 * `access_audit.resource_type` is a `varchar(64)` with no CHECK, so this
 * constant is the whole change.
 */
const RESOURCE_TYPE = 'encounter';

/**
 * Its own resource type for block D, and the argument is the same one PA-040
 * made for the priority groups: the vital signs are written by nursing under a
 * different permission through a different route, and an audit that recorded
 * them as «encounter» could not answer «¿quién tomó los signos?». The row
 * names who took it and who corrected it last (EN-143); the trail keeps all.
 */
const VITALS_RESOURCE_TYPE = 'encounter_vitals';

/** Who is asking, for the access trail (EN-017, EN-122). */
export interface Requester {
  /** The account id. Never a cedula (REQ-110). */
  userId: string;
  /** EN-121. The caller's own resolved scope, never a site they named. */
  sites: SiteScopeFilter;
  ip?: string;
  userAgent?: string;
}

/** EN-003 to EN-008. What opening an attention needs to be told. */
export interface OpenEncounterRequest {
  siteId: string;
  practitionerId: string;
  patientId: string;
  /** EN-003. Absent on a walk-in. */
  agendaEntryId?: string;
  /** EN-034. The real instant of the attention, never `now()`. */
  startedAt: Date;
  careModality: CareModality;
  careSetting: CareSetting;
  /** EN-007. Asked for, never derived from the history. */
  visitSequence: VisitSequence;
}

/**
 * EN-015, EN-162. What reading a page of a chart's history needs to be told.
 *
 * THE WINDOW ARRIVES RESOLVED AND NOT AS «TODAS», for the same reason the port
 * has no default: a caller who says nothing is answered by the DTO, which is
 * the only layer that knows what a caller who said nothing meant.
 */
export interface ChartHistoryRequest {
  patientId: string;
  /** 1-based, as the client counts it. */
  page: number;
  pageSize: number;
}

/** EN-131, EN-144, EN-147. What closing the account needs to be told. */
export interface CloseEncounterRequest {
  encounterId: string;
  /** EN-147. Why somebody other than the author is closing it. */
  substituteReason?: string;
  /**
   * EN-147. Whether the caller holds `record:sign`.
   *
   * RESOLVED BY THE CONTROLLER FROM THE SESSION. The service does not ask the
   * guard a second question — the guard already settled `record:write` — and
   * the domain must not learn what a permission is.
   */
  canSignRecords: boolean;
}

/**
 * The attention: opening it, reading it, closing it, and block D.
 *
 * ONE SERVICE, ONE AGGREGATE. The vital signs are here and not in a service of
 * their own because `encounter_vitals.encounter_id` IS the attention's
 * identifier: there is at most one taking (EN-067), it has no life of its own,
 * and nothing can reach it except through the attention it belongs to. The
 * clinical note is the opposite on all three counts and has its own service.
 *
 * ⚠️ THE AUTHORISATION DECISION IS NOT HERE. The guard settled the permission
 * from each route's `@RequirePermission`; what the controller hands down is the
 * caller's RESOLVED SITE SCOPE, because the site is not in the URL and the
 * guard cannot check what it cannot see (EN-121, `'query'`). Every read below
 * carries that scope into the query rather than filtering afterwards: a filter
 * applied in application code is one somebody can forget, and the consequence
 * here is a chart of another site on a doctor's screen.
 */
@Injectable()
export class EncounterService {
  constructor(
    @Inject(ENCOUNTER_REPOSITORY)
    private readonly encounters: EncounterRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EncounterService.name);
  }

  /**
   * EN-001 to EN-008, EN-017, EN-127, EN-141. Opens an attention.
   *
   * ORDER OF THE CHECKS, AND WHY. The chart first: art. 4 of the A.M.
   * 00115-2021 requires the history open BEFORE the attention starts, so «esta
   * persona no tiene ficha» is the answer that comes before anything else is
   * read, and it is the answer whoever is at admissions can act on. Everything
   * else — the appointment's patient, the appointment's state, the frozen age,
   * the foreign keys — is arbitrated INSIDE the write, by the triggers and the
   * lock, because every one of them is a race and a read taken first would be
   * a read that can be stale by the time the row lands.
   *
   * ⚠️ NOTHING HERE CHECKS FOR AN EARLIER ATTENTION THE SAME DAY (EN-006). The
   * A.M. 00115-2021 is literal: «si un usuario/paciente recibe varias
   * atenciones en un mismo día … deberá registrarse tantas consultas como
   * atenciones médicas recibidas». The uniqueness anybody would add by
   * instinct — one patient, one day — is what makes the mother who sees the
   * gynaecologist in the morning and the paediatrician in the afternoon lose
   * one of the two, and the month's production come out at half.
   */
  async open(
    request: OpenEncounterRequest,
    requester: Requester,
  ): Promise<EncounterView> {
    /**
     * EN-001, PA-045. A chart that does not exist and one a merge absorbed
     * answer the same refusal — see `PatientChartNotOpenError` for why the
     * surviving MRN is not named on this route.
     *
     * READ BEFORE THE WRITE AND NOT INSIDE IT, unlike the appointment: a merge
     * landing between this read and the insert would leave an attention on a
     * chart that has just been absorbed, and that is a REPAIRABLE state — the
     * merge re-points nothing (D-031), so the attention is still read through
     * the link from the survivor (EN-015). An annulled appointment is not
     * repairable in the same way, which is why that one is locked.
     */
    const chart = await this.encounters.findPatientChart(request.patientId);
    if (!chart || chart.mergedIntoId !== null) {
      throw new PatientChartNotOpenError();
    }

    const encounter = await this.encounters.open({
      siteId: request.siteId,
      practitionerId: request.practitionerId,
      patientId: request.patientId,
      agendaEntryId: request.agendaEntryId,
      startedAt: request.startedAt,
      careModality: request.careModality,
      careSetting: request.careSetting,
      visitSequence: request.visitSequence,
    });

    /**
     * EN-017, REQ-110. The accountable act, recorded with the attention that
     * EXISTS — after the write and never before it, so a refused insert leaves
     * no row claiming a chart was opened.
     *
     * `before`/`after` deliberately absent:
     * `access_audit_payload_only_for_declared_resources` refuses a payload
     * outside `'configuration'`, and recording does not throw — the entry
     * would simply be lost.
     */
    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: encounter.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    /**
     * EN-124, SC-016. The site and the fact, and NOTHING about the person.
     *
     * No patient, no practitioner, no diagnosis — and nothing interpolated:
     * the logger prunes by allowlist and a template string walks straight past
     * it. This module is stricter than the agenda about it because the datum
     * that would leak here is a diagnosis rather than an hour.
     */
    this.logger.info(
      { site_id: encounter.siteId, action: 'ENCOUNTER_OPENED' },
      'encounter opened',
    );

    return encounter;
  }

  /**
   * EN-122. Opens one attention.
   *
   * THIS IS THE ACCOUNTABLE ACT and the entry is written whether or not
   * anything else succeeds afterwards. An attention that does not exist — or
   * is outside the caller's scope — is NOT audited: nothing was disclosed, and
   * a row per guessed identifier would let anybody fill the trail with noise
   * (the criterion PA-024 already set).
   */
  async byId(
    encounterId: string,
    requester: Requester,
  ): Promise<EncounterView> {
    const encounter = await this.requireEncounter(encounterId, requester);

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: encounter.id,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return encounter;
  }

  /**
   * EN-015, EN-162. One page of a chart's attentions, chronologically,
   * including those of the charts it absorbed.
   *
   * ⚠️ A PAGE AND NOT THE WHOLE HISTORY, and the reason is not the browser.
   * Cutting at the client reduces what gets PAINTED, never what travels: the
   * chronic patient of ten years sends a hundred and thirty-seven attentions
   * over the network so that twenty can be shown. The `total` is what lets a
   * screen say «20 de 137» without asking for the rest.
   *
   * ⚠️ AND THE PAGE STILL CARRIES NO CLINICAL CONTENT (EN-123, EN-124). What
   * bounds it is the row count, not the shape: a listing with a diagnosis or a
   * note in it would turn every opening of the screen into the reading of
   * forty histories with no trail, which is exactly why this read is not
   * audited. Paginating it changes how many identifiers travel and nothing
   * else.
   *
   * NOT AUDITED PER ROW (EN-123, SC-017), and that is the requirement rather
   * than an omission: AG-072 and PA-023 already draw the line and it is the
   * same one here — recording every row of every listing buries the accesses
   * that matter. Opening an attention is the accountable act and it is audited
   * above. What makes this safe to leave unaudited is that `EncounterView`
   * carries no clinical content at all.
   */
  async historyOf(
    request: ChartHistoryRequest,
    requester: Requester,
  ): Promise<EncounterPage> {
    return this.encounters.historyOf({
      patientId: request.patientId,
      sites: requester.sites,
      page: request.page,
      pageSize: request.pageSize,
    });
  }

  /**
   * EN-145, EN-146. What nobody has closed.
   *
   * ⚠️ THIS IS THE WHOLE OF WHAT REPLACES AN AUTOMATIC CLOSURE. There is no
   * scheduled process in this module and there is no method that could become
   * one: D-A-010 rules it out because a closure has to state a discharge
   * condition (EN-009) and a nightly job would have to invent a clinical fact.
   * What is left is that somebody can SEE what is open, and this is it.
   *
   * NOT AUDITED, like every other listing (EN-123).
   */
  async listStillOpen(
    practitionerId: string | undefined,
    requester: Requester,
  ): Promise<EncounterView[]> {
    return this.encounters.listStillOpen({
      practitionerId,
      sites: requester.sites,
    });
  }

  /**
   * EN-009, EN-131, EN-132, EN-139, EN-144, EN-147. Closes the account.
   *
   * THE POLICY TRAVELS INTO THE TRANSACTION as a closure, exactly as the
   * agenda's transition does: the rules judge the row AS IT IS at the moment
   * of the write, so two people closing the same attention cannot both
   * succeed, and the loser is refused with the state the winner left.
   *
   * WHO IS CLOSING IS RESOLVED FIRST AND FROM THE SESSION. An account with no
   * practitioner profile cannot close: `encounter.closed_by_id` is a foreign
   * key to `practitioner`, and without this refusal the case would come out as
   * a `RELATED_RECORD_MISSING` on a form where nothing is wrong.
   */
  async close(
    request: CloseEncounterRequest,
    requester: Requester,
  ): Promise<EncounterView> {
    const closer = await this.requirePractitioner(requester.userId);
    // Taken ONCE and handed to the pure policy: the domain owns no clock, and
    // two readings of `new Date()` inside one closure could straddle a second
    // and stamp `ended_at` and `closed_at` a beat apart for no reason.
    const now = new Date();

    const closed = await this.encounters.close(
      { encounterId: request.encounterId, sites: requester.sites },
      (encounter) =>
        planClosure({
          encounter: {
            status: encounter.status,
            practitionerId: encounter.practitionerId,
            endedAt: encounter.endedAt,
            dischargeCondition: encounter.dischargeCondition,
          },
          closer: {
            practitionerId: closer,
            canSignRecords: request.canSignRecords,
            substituteReason: request.substituteReason,
          },
          to: 'COMPLETED',
          now,
        }),
    );

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: closed.id,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    this.logger.info(
      { site_id: closed.siteId, action: 'ENCOUNTER_COMPLETED' },
      'encounter account closed',
    );

    return closed;
  }

  /**
   * EN-135. Nursing opened the vital-signs form: the patient is in
   * preparation.
   *
   * ⚠️ IT WRITES NOTHING CLINICAL, and that is why it exists. Between opening
   * block D and saving it there is a real gap — half an hour of a
   * pre-consultation — and the board is for exactly that gap: «la están
   * preparando» told apart from «lista para pasar» (EN-136). Deriving the
   * first from the second would leave the patient showing as merely arrived
   * for the whole of it, which is the interval somebody is most likely to be
   * forgotten in.
   *
   * IT IS THE PATIENT'S PROGRESS AND NOT THE ATTENTION'S STATE. Nothing here
   * touches `encounter.status`: the two axes cross, and «en preparación» is
   * one of the three moments `OPEN` covers (EN-134).
   */
  async startVitals(
    encounterId: string,
    requester: Requester,
  ): Promise<EncounterView> {
    const encounter = await this.requireEncounter(encounterId, requester);
    this.assertAcceptsContent(encounter);

    await this.encounters.stampSubjectStatus({
      encounterId: encounter.id,
      fact: 'VITALS_OPENED',
      now: new Date(),
    });

    return encounter;
  }

  /**
   * EN-060 to EN-063, EN-066, EN-067, EN-136. Records block D.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT IS *NOT* CHECKED HERE, AND IT IS MOST OF THE REQUIREMENT
   * ═══════════════════════════════════════════════════════════════════════════
   *
   *  - THE BMI IS NOT COMPUTED (EN-061). `trg_encounter_vitals_bmi` writes it
   *    on every insert and update of the weight or the height, and the value
   *    that comes back is the stored one. A figure computed here could
   *    disagree with the row, and the row is what a nutritional screening
   *    filters on.
   *  - THE RANGES ARE NOT CHECKED (EN-062). `encounter_vitals_ranges_*` refuses
   *    750 kg, and it also refuses it to an import and to a `psql`. A copy of
   *    the numbers here would be a second, weaker rule that drifts.
   *
   * WHAT *IS* CHECKED is the pair a constraint cannot see: that the attention
   * still admits content, and that an under-five carries the anthropometry the
   * instructivo makes obligatory — which needs the FROZEN age of the row
   * (EN-008), not today's.
   *
   * ⚠️ AND IT DOES NOT NEED `record:write` (EN-066). The route asks for
   * `vitals:write`, which `ENFERMERIA` holds and which authorises nothing
   * else. That is what lets nursing work before the doctor walks in, and until
   * D-A-003 gave `encounter:open` its own permission it was impossible: block
   * D hangs off an attention that has to exist first, and creating one
   * required a permission only `MEDICO` had.
   */
  async recordVitals(
    encounterId: string,
    vitals: VitalSigns,
    requester: Requester,
  ): Promise<VitalSignsView> {
    const encounter = await this.requireEncounter(encounterId, requester);
    this.assertAcceptsContent(encounter);

    // EN-063 against the age FROZEN on the attention. Evaluated against
    // today's date instead, a report reprocessed next year would refuse rows
    // it accepted — the reasoning PA-005 wrote down for «intersexual en
    // menores de un año».
    assertMandatoryAnthropometry(vitals, {
      years: encounter.ageYears,
      months: encounter.ageMonths,
      days: encounter.ageDays,
    });

    // EN-143, D-048. The author goes IN the datum, from the session and never
    // from the body: the author of a first taking, the corrector of a later one.
    const saved = await this.encounters.saveVitals(
      { encounterId: encounter.id, sites: requester.sites },
      vitals,
      requester.userId,
    );

    // EN-136. The board moves because the signs were SAVED — the fact proves
    // the state, and nobody had to press a second button (D-A-008).
    await this.encounters.stampSubjectStatus({
      encounterId: encounter.id,
      fact: 'VITALS_RECORDED',
      now: new Date(),
    });

    /**
     * EN-143. The row names who took the reading and who corrected it last;
     * the trail keeps every write in between.
     */
    await this.audit.record({
      userId: requester.userId,
      resourceType: VITALS_RESOURCE_TYPE,
      resourceId: encounter.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return saved;
  }

  /**
   * EN-060, EN-068. Block D of one attention, or `null` when nobody took it.
   *
   * AUDITED, unlike a listing: what comes back is a measurement of a
   * identifiable person, which is clinical content whatever else it is.
   */
  async vitalsOf(
    encounterId: string,
    requester: Requester,
  ): Promise<VitalSignsView | null> {
    const encounter = await this.requireEncounter(encounterId, requester);

    const vitals = await this.encounters.findVitals({
      encounterId: encounter.id,
      sites: requester.sites,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: VITALS_RESOURCE_TYPE,
      resourceId: encounter.id,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return vitals;
  }

  /**
   * EN-121. The attention, or the one refusal that covers «no existe» and «es
   * de otra sede».
   *
   * Telling them apart would confirm attentions of other sites to whoever
   * guesses identifiers, one at a time — the line `AGENDA_ENTRY_NOT_FOUND`
   * already took.
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
   * EN-130. New clinical content goes into an attention that is still live.
   *
   * `DISCHARGED` refuses it: the doctor signed, the act is over, and what
   * remains is the cashier. What stays possible is the AMENDMENT, which is a
   * new version of something already written and is checked by the note's own
   * service — never here.
   */
  private assertAcceptsContent(encounter: EncounterView): void {
    if (!acceptsNewClinicalContent(encounter.status)) {
      throw new EncounterAlreadyClosedError(encounter.status);
    }
  }

  /**
   * EN-011, EN-144. The caller's clinical identity.
   *
   * The account is not the practitioner: `closed_by_id`, `author_id` and
   * `signed_by_id` are foreign keys to `practitioner`, which is the schema
   * saying that a clinical act has a clinical author.
   */
  private async requirePractitioner(userId: string): Promise<string> {
    const identity = await this.encounters.findPractitionerByUser(userId);
    if (!identity) throw new PractitionerProfileRequiredError();
    return identity.practitionerId;
  }
}
