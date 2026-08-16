import { Inject, Injectable } from '@nestjs/common';

import type { Principal } from '../../../shared/authorisation/principal';
import { assertSitesInScope } from '../../../shared/authorisation/site-scope';
import { resolveDuration } from '../../../shared/domain/duration-resolution';
import {
  ServiceTypeNotFoundError,
  SpecialtyNotFoundError,
} from '../../../shared/domain/errors/master-data.errors';
import {
  assertDurationFitsSlotAtom,
  clinicSlotAtom,
} from '../../../shared/domain/slot-atom';
import {
  InactiveSpecialtyAssignmentError,
  PractitionerNotFoundError,
  PrimarySpecialtyRequiredError,
} from '../domain/staff.errors';
import {
  type PractitionerSiteView,
  type PractitionerSpecialtyView,
  STAFF_REPOSITORY,
  type SpecialtyAssignment,
  type StaffRepository,
} from '../domain/staff.repository';

import { type Requester, StaffAuditTrail } from './staff-audit.trail';

/** One row of the duration listing, with the D-010 hierarchy resolved (ST-009). */
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
 * WHERE a practitioner attends and WHAT they practise: sites (ST-007),
 * specialties (ST-008) and their own durations (ST-009).
 *
 * SPLIT FROM `PractitionerService` BECAUSE THEY CHANGE FOR DIFFERENT REASONS.
 * The profile answers to the habilitación — the ACESS, the MSP code, whether
 * the person is still employed. These three answer to the clinic's map and its
 * catalogue: a new site, a specialty deactivated, a duration the doctor
 * insists on. Together they would be fourteen public use cases in one class,
 * which is over the limit ADR-008 §2 sets, and the limit is there because a
 * class nobody can hold in their head is a class where an invariant gets
 * added twice.
 *
 * ST-008 AND ST-009 ARRIVED HERE FROM `specialties` ON 13-08-2026, settling
 * the debt that SPEC declared on the 12th. The behaviour is unchanged and so
 * are the error codes; only the owner and the path did.
 */
@Injectable()
export class PractitionerAssignmentsService {
  constructor(
    @Inject(STAFF_REPOSITORY)
    private readonly repository: StaffRepository,
    private readonly trail: StaffAuditTrail,
  ) {}

  // --- Sites (ST-007) --------------------------------------------------------

  async listSites(
    practitionerId: string,
  ): Promise<readonly PractitionerSiteView[]> {
    await this.requirePractitioner(practitionerId);
    return this.repository.listPractitionerSites(practitionerId);
  }

  /**
   * ST-007. Replace-set, which is why it is a PUT: the body is the whole list
   * of sites the practitioner attends at, and what is not named disappears.
   *
   * NOTHING VERIFIES THE SITES EXIST FIRST. The foreign key does, and
   * `staff.constraints.ts` turns its refusal into `SITE_NOT_FOUND` with the
   * field pointing at the list — one round trip instead of two, and no window
   * between the check and the write in which a site is deactivated.
   *
   * ST-047 IS CHECKED HERE AND NOT BY THE GUARD, and the reason is the same
   * one AG-105 gives for the room: guards run before the pipes, so a site that
   * travels in the BODY is unvalidated and unusable for an authorisation
   * decision. The route declares `'query'` and the caller's own resolved scope
   * — never anything taken from the request — is what narrows it.
   *
   * BOTH ENDS OF THE REPLACEMENT ARE JUDGED, and that is not belt and braces:
   * a caller scoped to Norte sending `[Norte]` over a practitioner who also
   * attends Sur would DROP the Sur row, and the practitioner would vanish from
   * another city's list of bookable people (AG-108) without anybody there
   * deciding it. What is being set and what is being replaced are both changes
   * to a site's agenda, so both have to be inside the caller's scope.
   */
  async replaceSites(
    practitionerId: string,
    siteIds: readonly string[],
    requester: Requester,
    caller: Principal,
  ): Promise<readonly PractitionerSiteView[]> {
    await this.requirePractitioner(practitionerId);

    const current = await this.repository.listPractitionerSites(practitionerId);
    // ST-047. Before the write and before any refusal that could describe the
    // clinic's map: `SITE_SCOPE_DENIED` names the permission, never a site.
    assertSitesInScope(caller, 'staff:manage', [
      ...siteIds,
      ...current.map((site) => site.siteId),
    ]);

    await this.repository.replacePractitionerSites(practitionerId, siteIds);
    await this.trail.record('UPDATE', practitionerId, requester);

    return this.repository.listPractitionerSites(practitionerId);
  }

  // --- Specialties (ST-008) --------------------------------------------------

  /** ST-008: the primary flag travels with each row, primary first. */
  async listSpecialties(
    practitionerId: string,
  ): Promise<readonly PractitionerSpecialtyView[]> {
    await this.requirePractitioner(practitionerId);
    return this.repository.listPractitionerSpecialties(practitionerId);
  }

  /**
   * ST-008: the whole assignment in one request — at least one specialty,
   * exactly one primary. SP-004 survives the move: a deactivated specialty is
   * refused for ids the practitioner did not already hold; the ones already
   * assigned survive intact, deactivated or not, because deactivating a
   * specialty must not amputate existing references.
   */
  async replaceSpecialties(
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
    const byId = new Map(specialties.map((specialty) => [specialty.id, specialty])); // prettier-ignore
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
    await this.trail.record('UPDATE', practitionerId, requester);

    return this.repository.listPractitionerSpecialties(practitionerId);
  }

  // --- Duration exceptions (ST-009) ------------------------------------------

  /**
   * ST-009 as a listing: every service type the practitioner can serve, with
   * the duration already resolved through the SAME function the agenda uses.
   * The rule level is absent on purpose — a base duration always exists here,
   * and the schedule rule belongs to the booking, not to the file.
   */
  async listDurations(
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

  /** ST-009. A PUT: setting it twice is the same exception, not two. */
  async setDurationException(
    practitionerId: string,
    serviceTypeId: string,
    durationMinutes: number,
    requester: Requester,
  ): Promise<void> {
    await this.requirePractitioner(practitionerId);
    if (!(await this.repository.serviceTypeExists(serviceTypeId))) {
      throw new ServiceTypeNotFoundError();
    }

    /**
     * SP-022, D-021. The exception has to be a whole number of slots too, and
     * it is refused HERE — at save time — for the same reason the base
     * duration is: a 25-minute exception on a 10-minute grid is inside
     * `duration_exception_range` and still impossible to book.
     *
     * IT IS THE RUNG THAT WINS (SP-023), so leaving it out would make the
     * guarantee cosmetic: every service type could tile the grid and one
     * doctor's override would still strand every appointment of theirs.
     */
    assertDurationFitsSlotAtom(
      'durationMinutes',
      durationMinutes,
      clinicSlotAtom(await this.repository.siteSlotAtoms()),
    );

    await this.repository.upsertDurationException(
      practitionerId,
      serviceTypeId,
      durationMinutes,
    );
    await this.trail.record('UPDATE', practitionerId, requester);
  }

  /**
   * ST-009. Removing an exception that is not there is not an error: the
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
      await this.trail.record('UPDATE', practitionerId, requester);
    }
  }

  private async requirePractitioner(practitionerId: string): Promise<void> {
    const practitioner = await this.repository.findPractitioner(practitionerId);
    if (!practitioner) throw new PractitionerNotFoundError();
  }
}
