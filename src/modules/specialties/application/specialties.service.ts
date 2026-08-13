import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
  type AuditAction,
} from '../../../shared/audit/access-audit.port';
import {
  InactiveSpecialtyAssignmentError,
  PractitionerNotFoundError,
  PrimarySpecialtyRequiredError,
  ServiceTypeNotFoundError,
  SpecialtyNotFoundError,
} from '../domain/specialties.errors';
import {
  SPECIALTIES_REPOSITORY,
  type SpecialtiesRepository,
  type PractitionerSpecialtyView,
  type ServiceTypeView,
  type SpecialtyAssignment,
  type SpecialtyView,
} from '../domain/specialties.repository';
import { resolveDuration } from '../domain/duration-resolution';

/** Who is asking, so the trail can say so (SP-002, SP-027). */
export interface Requester {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/** One row of the duration listing, with SP-023 already resolved (SP-028). */
export interface PractitionerDurationView {
  serviceTypeId: string;
  serviceTypeName: string;
  specialtyId: string;
  specialtyName: string;
  baseMinutes: number;
  exceptionMinutes: number | null;
  /** exception → base, by `resolveDuration`; the rule level belongs to agenda. */
  resolvedMinutes: number;
}

/**
 * Administering specialties, service types and durations (C1).
 *
 * The authorisation decision is NOT here — the guard settled it from the
 * route's `@RequirePermission`. What IS here is what must hold regardless of
 * which endpoint asked: the audit entry on every mutation (SP-002, SP-027),
 * the exactly-one-primary rule (SP-005), and the refusal of deactivated
 * specialties for new assignments (SP-004).
 *
 * WHAT THIS SERVICE DOES NOT DO: check for duplicates or references before
 * writing. Two administrators creating «Pediatría» in the same millisecond
 * both read "free"; only the functional unique indexes can arbitrate, and the
 * adapter translates their refusal into the codes the SPEC fixes (SP-006,
 * SP-026, SP-003, SP-025).
 */
@Injectable()
export class SpecialtiesService {
  constructor(
    @Inject(SPECIALTIES_REPOSITORY)
    private readonly repository: SpecialtiesRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  /** SP-007: administration lists everything on demand; selection defaults to active. */
  async listSpecialties(
    includeInactive: boolean,
  ): Promise<readonly SpecialtyView[]> {
    return this.repository.listSpecialties(includeInactive);
  }

  /** SP-002. */
  async createSpecialty(
    input: { code: string; name: string },
    requester: Requester,
  ): Promise<SpecialtyView> {
    const created = await this.repository.createSpecialty(input);
    await this.recordMutation('CREATE', created.id, requester);
    return created;
  }

  /** SP-002 (rename), SP-004 (deactivate). */
  async updateSpecialty(
    id: string,
    patch: { name?: string; active?: boolean },
    requester: Requester,
  ): Promise<SpecialtyView> {
    const updated = await this.repository.updateSpecialty(id, patch);
    if (!updated) throw new SpecialtyNotFoundError();

    await this.recordMutation('UPDATE', updated.id, requester);
    return updated;
  }

  /**
   * SP-003. A hard delete that only succeeds when nothing references the
   * specialty; otherwise the adapter raises `SpecialtyInUseError` from the FK
   * refusal, and the client is offered deactivation instead.
   */
  async deleteSpecialty(id: string, requester: Requester): Promise<void> {
    const deleted = await this.repository.deleteSpecialty(id);
    if (!deleted) throw new SpecialtyNotFoundError();

    await this.recordMutation('UPDATE', id, requester);
  }

  async listServiceTypes(
    specialtyId: string,
    includeInactive: boolean,
  ): Promise<readonly ServiceTypeView[]> {
    const specialty = await this.repository.findSpecialty(specialtyId);
    if (!specialty) throw new SpecialtyNotFoundError();

    return this.repository.listServiceTypes(specialtyId, includeInactive);
  }

  /** SP-020. */
  async createServiceType(
    input: { specialtyId: string; name: string; durationMinutes: number },
    requester: Requester,
  ): Promise<ServiceTypeView> {
    // The specialty is named by the URL, so a wrong id is a missing resource;
    // letting the FK answer would dress a 404 up as invalid data.
    const specialty = await this.repository.findSpecialty(input.specialtyId);
    if (!specialty) throw new SpecialtyNotFoundError();

    const created = await this.repository.createServiceType(input);
    await this.recordMutation('CREATE', created.id, requester);
    return created;
  }

  /**
   * SP-024: changing a duration rules forwards only. Nothing here reads or
   * writes an appointment — the repository method touches exactly one
   * `service_type` row — so what is asserted by the tests is the ABSENCE of
   * any other write.
   */
  async updateServiceType(
    id: string,
    patch: { name?: string; durationMinutes?: number; active?: boolean },
    requester: Requester,
  ): Promise<ServiceTypeView> {
    const updated = await this.repository.updateServiceType(id, patch);
    if (!updated) throw new ServiceTypeNotFoundError();

    await this.recordMutation('UPDATE', updated.id, requester);
    return updated;
  }

  /** SP-025. */
  async deleteServiceType(id: string, requester: Requester): Promise<void> {
    const deleted = await this.repository.deleteServiceType(id);
    if (!deleted) throw new ServiceTypeNotFoundError();

    await this.recordMutation('UPDATE', id, requester);
  }

  /** SP-008: the primary flag travels with each row. */
  async listPractitionerSpecialties(
    practitionerId: string,
  ): Promise<readonly PractitionerSpecialtyView[]> {
    await this.requirePractitioner(practitionerId);
    return this.repository.listPractitionerSpecialties(practitionerId);
  }

  /**
   * SP-005: the whole assignment in one request — at least one specialty,
   * exactly one primary. SP-004: a deactivated specialty is refused for ids
   * the practitioner did not already hold; the ones already assigned survive
   * intact, deactivated or not, because deactivation must not amputate
   * existing references.
   */
  async replacePractitionerSpecialties(
    practitionerId: string,
    items: readonly SpecialtyAssignment[],
    requester: Requester,
  ): Promise<readonly PractitionerSpecialtyView[]> {
    await this.requirePractitioner(practitionerId);

    const primaries = items.filter((item) => item.isPrimary).length;
    if (items.length === 0 || primaries !== 1) {
      throw new PrimarySpecialtyRequiredError(primaries);
    }

    const specialties = await this.repository.findSpecialtiesByIds(
      items.map((item) => item.specialtyId),
    );
    const byId = new Map(specialties.map((s) => [s.id, s]));
    const current =
      await this.repository.listPractitionerSpecialties(practitionerId);
    const alreadyHeld = new Set(current.map((row) => row.specialtyId));

    for (const item of items) {
      const specialty = byId.get(item.specialtyId);
      if (!specialty) throw new SpecialtyNotFoundError();
      if (!specialty.active && !alreadyHeld.has(item.specialtyId)) {
        throw new InactiveSpecialtyAssignmentError();
      }
    }

    await this.repository.replacePractitionerSpecialties(practitionerId, items);
    await this.recordMutation('UPDATE', practitionerId, requester);

    return this.repository.listPractitionerSpecialties(practitionerId);
  }

  /**
   * SP-023 as a listing, SP-028 as its consumer: every service type the
   * practitioner can serve, with the duration already resolved through the
   * SAME function the agenda will use. The rule level is absent on purpose —
   * a base duration always exists here, and the schedule rule belongs to the
   * booking, not to the catalogue.
   */
  async listPractitionerDurations(
    practitionerId: string,
  ): Promise<readonly PractitionerDurationView[]> {
    await this.requirePractitioner(practitionerId);

    const rows =
      await this.repository.listPractitionerDurations(practitionerId);
    return rows.map((row) => ({
      ...row,
      // Non-null: `baseMinutes` is NOT NULL in the base, so the hierarchy
      // always lands somewhere before the rule level.
      resolvedMinutes:
        resolveDuration({
          exceptionMinutes: row.exceptionMinutes,
          serviceTypeMinutes: row.baseMinutes,
        }) ?? row.baseMinutes,
    }));
  }

  /** SP-022. */
  async setDurationException(
    practitionerId: string,
    serviceTypeId: string,
    durationMinutes: number,
    requester: Requester,
  ): Promise<void> {
    await this.requirePractitioner(practitionerId);
    const serviceType = await this.repository.findServiceType(serviceTypeId);
    if (!serviceType) throw new ServiceTypeNotFoundError();

    await this.repository.upsertDurationException(
      practitionerId,
      serviceTypeId,
      durationMinutes,
    );
    await this.recordMutation('UPDATE', serviceTypeId, requester);
  }

  /**
   * SP-022. Removing an exception that is not there is not an error: the
   * caller wanted it gone and it is gone. Only an actual removal is audited —
   * recording a no-op would write noise into the trail.
   */
  async removeDurationException(
    practitionerId: string,
    serviceTypeId: string,
    requester: Requester,
  ): Promise<void> {
    await this.requirePractitioner(practitionerId);

    const removed = await this.repository.deleteDurationException(
      practitionerId,
      serviceTypeId,
    );
    if (removed) {
      await this.recordMutation('UPDATE', serviceTypeId, requester);
    }
  }

  private async requirePractitioner(practitionerId: string): Promise<void> {
    const exists = await this.repository.practitionerExists(practitionerId);
    if (!exists) throw new PractitionerNotFoundError();
  }

  /**
   * SP-002, SP-027: every mutation leaves author and instant in the trail.
   * The port guarantees a failure to record never blocks the mutation itself.
   * `resourceType` is the module, `resourceId` the entity touched: enough to
   * reconstruct who changed the parametrisation and when, with no clinical
   * content involved.
   *
   * IT STILL SAYS `configuration` AFTER THE MOVE TO `specialties` (ADR-011).
   * The discriminator is a WRITTEN VALUE, not a symbol: rows already carry it,
   * and rewriting the code without migrating them would split one trail into
   * two that no query joins. It is revisited together with `config:read` /
   * `config:manage`, which the same ADR froze, when `staff` and
   * `organization` arrive and the audit vocabulary is settled in one pass.
   */
  private async recordMutation(
    action: AuditAction,
    resourceId: string,
    requester: Requester,
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType: 'configuration',
      resourceId,
      action,
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }
}
