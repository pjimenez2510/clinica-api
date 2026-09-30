import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import {
  ENCOUNTER_REPOSITORY,
  type EncounterRepository,
} from '../domain/encounter.repository';
import {
  PatientChartNotOpenError,
  PatientHistoryNotFoundError,
  RefutationReasonRequiredError,
} from '../domain/encounter.errors';
import {
  PATIENT_HISTORY_REPOSITORY,
  type HistoryView,
  type PatientHistoryKind,
  type PatientHistoryRepository,
} from '../domain/patient-history.repository';

import type { Requester } from './encounter.service';

/** Its own resource type, so «¿quién leyó los antecedentes?» has an answer. */
const RESOURCE_TYPE = 'patient_history';

export interface RecordHistoryRequest {
  patientId: string;
  kind: PatientHistoryKind;
  description: string;
  relative?: string;
}

export interface RefuteHistoryRequest {
  patientId: string;
  historyId: string;
  notes: string;
}

/**
 * EN-085, EN-164. The patient's personal and family history.
 *
 * A SERVICE OF ITS OWN and not three more methods on `PatientAllergyService`:
 * the two share a regime, not a reason to change — the allergy answers to the
 * prescription check (EN-084) and to «sin alergias conocidas» (EN-087), and a
 * history entry answers to neither (ADR-008 §2).
 */
@Injectable()
export class PatientHistoryService {
  constructor(
    @Inject(PATIENT_HISTORY_REPOSITORY)
    private readonly history: PatientHistoryRepository,
    @Inject(ENCOUNTER_REPOSITORY)
    private readonly encounters: EncounterRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PatientHistoryService.name);
  }

  /**
   * EN-085, EN-164. Records one entry, authored by the session (EN-086).
   * Refused on a chart that was absorbed: new facts go on the survivor.
   */
  async record(
    request: RecordHistoryRequest,
    requester: Requester,
  ): Promise<HistoryView> {
    await this.requireOpenChart(request.patientId);

    const entry = await this.history.record({
      patientId: request.patientId,
      kind: request.kind,
      description: request.description,
      relative: request.relative,
      recordedById: requester.userId,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: entry.id,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
    // EN-124. The fact and nothing else: no patient, no description.
    this.logger.info({ action: 'HISTORY_RECORDED' }, 'history recorded');

    return entry;
  }

  /**
   * EN-085. Rules one out, never deletes it. The reason is demanded here and
   * not only in the DTO, as with the allergy (EN-082). No open-chart check,
   * for the allergy's reason: a wrong entry on an absorbed chart must still be
   * correctable from the survivor.
   */
  async refute(
    request: RefuteHistoryRequest,
    requester: Requester,
  ): Promise<HistoryView> {
    if (request.notes.trim().length === 0) {
      throw new RefutationReasonRequiredError('el antecedente');
    }

    const refuted = await this.history.refute({
      patientId: request.patientId,
      historyId: request.historyId,
      notes: request.notes,
      now: new Date(),
      refutedById: requester.userId,
    });
    if (refuted === null) throw new PatientHistoryNotFoundError();

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: refuted.id,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
    this.logger.info({ action: 'HISTORY_REFUTED' }, 'history refuted');

    return refuted;
  }

  /** EN-085. The whole history of the chart, refuted entries included. */
  async listFor(
    patientId: string,
    requester: Requester,
  ): Promise<HistoryView[]> {
    const chart = await this.requireOpenChart(patientId);
    const entries = await this.history.listFor(chart);

    await this.audit.record({
      userId: requester.userId,
      resourceType: RESOURCE_TYPE,
      resourceId: chart,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    return entries;
  }

  /** The chart must exist and not be absorbed (PA-055): read the survivor. */
  private async requireOpenChart(patientId: string): Promise<string> {
    const chart = await this.encounters.findPatientChart(patientId);
    if (!chart || chart.mergedIntoId !== null) {
      throw new PatientChartNotOpenError();
    }
    return chart.id;
  }
}
