import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
} from '../../../shared/audit/access-audit.port';
import type { Principal } from '../../../shared/authorisation/principal';
import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import {
  PatientNotFoundError,
  PriorityGroupNotFoundError,
  RestrictedPriorityGroupError,
} from '../domain/patient.errors';
import {
  PATIENT_REPOSITORY,
  type PatientRepository,
  type PriorityGroupRecord,
} from '../domain/patient.repository';
import {
  assertRecordablePriorityGroup,
  clinicalDateToday,
  isPeriodInForce,
  isRestrictedPriorityGroup,
  type PriorityGroupOrigin,
} from '../domain/priority-groups';
import type { Requester } from './patients.service';

/**
 * The REASON a patient is prioritised: reading it, recording it, closing it
 * (PA-033 to PA-042, REQ-024, D-026, D-027).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A SERVICE OF ITS OWN, AND NOT SYMMETRY WITH THE MODULE NEXT DOOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `PatientsService` reads and writes an ADMINISTRATIVE record; this reads and
 * writes SPECIAL-CATEGORY HEALTH DATA under the LOPDP. Two different reasons
 * to change, which is one of the three limits ADR-008 §2 sets for splitting —
 * and it shows in the dependencies: only this one needs the `Principal`, to
 * enforce the second reading level of D-027 that no route decorator can
 * express, and only this one writes an audit entry for a read that opens no
 * chart.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS SERVICE NEVER DOES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It never logs a group code. PA-042 and SC-010 say the reason must not appear
 * in a listing, an error message or a log line, and «no interpolar variables en
 * una llamada de log» is what keeps that true — the logger prunes by allowlist
 * and interpolation walks straight past it. The calculated LEVEL is served by
 * `PatientsService` instead, with `patient:read`, because the order is not the
 * reason.
 */
@Injectable()
export class PatientPriorityService {
  constructor(
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  /**
   * The reasons, as of today in Ecuador.
   *
   * ⚠️ THE RESTRICTED ROWS ARE OMITTED, NOT REFUSED (D-027).
   *
   * A 403 on a read would itself confirm that such a row exists for this
   * person — the very oracle PA-024 refuses to be for the register as a whole,
   * and here the datum is «víctima de violencia doméstica», where the
   * consequence is the safety of a person and not only their privacy. Somebody
   * without `patient:priority:protected` sees the ordinary groups and cannot
   * tell whether there is anything else. What they DO see, always, is the
   * calculated priority — which already counted those rows.
   *
   * AUDITED. It is an access to health data (PA-040, REQ-110), and it is a
   * DIFFERENT act from opening the chart, so it carries its own resource type:
   * «quién abrió la ficha» and «quién leyó por qué es prioritaria» are two
   * questions an investigation asks separately.
   */
  async list(
    patientId: string,
    requester: Requester,
    principal: Principal,
    now: Date = new Date(),
  ): Promise<{
    asOf: ClinicalDate;
    records: readonly AssessedPriorityGroup[];
  }> {
    if (!(await this.patients.exists(patientId))) {
      throw new PatientNotFoundError();
    }

    await this.audit.record({
      userId: requester.userId,
      resourceType: PRIORITY_RESOURCE_TYPE,
      resourceId: patientId,
      action: 'READ',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    const asOf = clinicalDateToday(now);
    const visible = (await this.patients.listPriorityGroups(patientId)).filter(
      (record) => this.mayHandle(record.group, principal),
    );

    return { asOf, records: visible.map((record) => assess(record, asOf)) };
  }

  /**
   * Records one assessment (PA-033, PA-036, PA-038, PA-039).
   *
   * The refusal for a restricted group IS an error here and not an omission,
   * unlike the read: the caller named the group themselves, so saying no
   * reveals nothing they did not already type.
   */
  async record(
    input: {
      patientId: string;
      group: string;
      startsOn: ClinicalDate;
      endsOn: ClinicalDate | null;
      origin: PriorityGroupOrigin;
      evidenceDocument: string | null;
    },
    requester: Requester,
    principal: Principal,
    now: Date = new Date(),
  ): Promise<AssessedPriorityGroup> {
    if (!(await this.patients.exists(input.patientId))) {
      throw new PatientNotFoundError();
    }

    const group = assertRecordablePriorityGroup(input);
    if (isRestrictedPriorityGroup(group) && !this.mayHandle(group, principal)) {
      throw new RestrictedPriorityGroupError(group);
    }

    const created = await this.patients.addPriorityGroup({
      patientId: input.patientId,
      group,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      origin: input.origin,
      evidenceDocument: input.evidenceDocument,
      // PA-039. Not a parameter of the request: who recorded it is who is
      // signed in, or the trail could be written to say somebody else did.
      recordedById: requester.userId,
    });

    await this.audit.record({
      userId: requester.userId,
      resourceType: PRIORITY_RESOURCE_TYPE,
      resourceId: input.patientId,
      action: 'CREATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
      // `before`/`after` are deliberately absent: the whitelist of
      // `access_audit_payload_only_for_declared_resources` is exactly
      // `'configuration'`, and a health datum in an append-only table that is
      // never purged could not be rectified afterwards (REQ-113, D-032).
    });

    // NOT `inForce: true`. A back-dated assessment whose end has already
    // passed is created and does not count, and saying otherwise on the
    // response would be the screen's only source for a fact the next GET
    // contradicts.
    return assess(created, clinicalDateToday(now));
  }

  /**
   * Closes a record by setting its end date. NEVER deletes it (PA-037).
   *
   * A record the caller may not see answers `PRIORITY_GROUP_NOT_FOUND` rather
   * than a refusal, for the same reason the listing omits it.
   */
  async close(
    input: { patientId: string; recordId: string; endsOn: ClinicalDate },
    requester: Requester,
    principal: Principal,
    now: Date = new Date(),
  ): Promise<AssessedPriorityGroup> {
    const existing = (
      await this.patients.listPriorityGroups(input.patientId)
    ).find((record) => record.id === input.recordId);

    if (!existing || !this.mayHandle(existing.group, principal)) {
      throw new PriorityGroupNotFoundError();
    }

    const closed = await this.patients.closePriorityGroup({
      patientId: input.patientId,
      recordId: input.recordId,
      endsOn: input.endsOn,
      closedById: requester.userId,
    });
    if (!closed) throw new PriorityGroupNotFoundError();

    await this.audit.record({
      userId: requester.userId,
      resourceType: PRIORITY_RESOURCE_TYPE,
      resourceId: input.patientId,
      action: 'UPDATE',
      ip: requester.ip,
      userAgent: requester.userAgent,
    });

    // Closing «hoy» leaves it in force TODAY: the period is inclusive at both
    // ends, so a disability closed on the 15th still counted on the 15th.
    return assess(closed, clinicalDateToday(now));
  }

  /**
   * Whether this caller may see or write this group.
   *
   * The permission is NAMED HERE, in one place, rather than resolved into a
   * boolean by each controller. A boolean computed at the edge is a boolean
   * somebody eventually computes wrong, and the route decorator cannot express
   * it: a route declares ONE permission, and the second level depends on the
   * row, not on the endpoint.
   */
  private mayHandle(group: string, principal: Principal): boolean {
    if (!isRestrictedPriorityGroup(group)) return true;
    return principal.can('patient:priority:protected');
  }
}

/** A stored assessment plus the answer to «¿cuenta hoy?» (PA-036). */
export interface AssessedPriorityGroup extends PriorityGroupRecord {
  inForce: boolean;
}

/**
 * Computed on every read and never stored.
 *
 * The period is the FACT; «vigente» is a question about a day, and a column
 * holding the answer is a column that is wrong every morning until something
 * runs.
 */
function assess(
  record: PriorityGroupRecord,
  asOf: ClinicalDate,
): AssessedPriorityGroup {
  return { ...record, inForce: isPeriodInForce(record, asOf) };
}

/**
 * The resource type of the trail, distinct from `'patient'` ON PURPOSE.
 *
 * «¿Quién abrió la ficha de esta persona?» and «¿quién leyó por qué es
 * prioritaria?» are two questions, and answering the second by filtering
 * `'patient'` rows by hand is how an investigation gets the wrong answer.
 * `access_audit.resource_type` is a `varchar(64)` with no CHECK, so this is
 * the whole change.
 */
const PRIORITY_RESOURCE_TYPE = 'patient_priority_group';
