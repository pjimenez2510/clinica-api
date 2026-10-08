import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
  type AuditAction,
} from '../../../shared/audit/access-audit.port';
import { clinicalDateOf } from '../../../shared/domain/clinic-time';
import {
  ServiceTypeNotFoundError,
  SpecialtyNotFoundError,
} from '../../../shared/domain/errors/master-data.errors';
import {
  assertDurationFitsSlotAtom,
  clinicSlotAtom,
} from '../../../shared/domain/slot-atom';
import { specialtyCodeFromName } from '../domain/specialty-code';
import {
  SPECIALTIES_REPOSITORY,
  type SpecialtiesRepository,
  type ServiceTypeView,
  type SpecialtyView,
} from '../domain/specialties.repository';

/** Who is asking, so the trail can say so (SP-002, SP-027). */
export interface Requester {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Administering specialties, service types and durations (C1).
 *
 * The authorisation decision is NOT here — the guard settled it from the
 * route's `@RequirePermission`. What IS here is what must hold regardless of
 * which endpoint asked: the audit entry on every mutation (SP-002, SP-027).
 *
 * WHAT LEFT ON 13-08-2026: assigning specialties to a practitioner (SP-005,
 * SP-008) and their duration exceptions (SP-022) are now ST-008 and ST-009 in
 * `staff`, which owns the practitioner. This SPEC declared them as debt on the
 * 12th and it is settled; what stays here is the catalogue, the service type
 * and the BASE duration.
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

  /**
   * SP-002, SP-009. The caller sends a NAME; the stable code is derived here,
   * once, and stored with it (ADR-005 §5: nobody is asked to type an
   * identifier they cannot interpret).
   *
   * Two different names can derive the same code — the derivation keeps two
   * words, so «Medicina Familiar y Comunitaria» and «Medicina Familiar
   * Preventiva» are both `medicina-familiar`. Nothing is checked here: the
   * functional index `specialty_code_unique` arbitrates, and the adapter turns
   * its refusal into `SpecialtyDuplicateError('code')`, which speaks about the
   * NAME because that is the only thing this person wrote.
   */
  async createSpecialty(
    input: { name: string },
    requester: Requester,
  ): Promise<SpecialtyView> {
    const created = await this.repository.createSpecialty({
      code: specialtyCodeFromName(input.name),
      name: input.name,
    });
    await this.recordMutation('CREATE', created.id, requester, {
      after: specialtySnapshot(created),
    });
    return created;
  }

  /**
   * SP-002 (rename), SP-004 (deactivate), SP-010 (the code stays put).
   *
   * THE CODE IS NOT RE-DERIVED HERE, AND THAT IS THE POINT — do not "fix" it.
   * Deriving it again on a rename is the obvious symmetry and it is wrong: the
   * code is the identity of this row for everything that references it —
   * `practitioner_specialty` in `staff`, the reports and invoices that stored
   * it, and the MSP seed, which matches its 22 rows BY CODE and would create
   * duplicates the moment one moved. Correcting a missing accent in
   * «Ginecologia» would be enough to trigger all of it.
   *
   * Which is why the patch this method accepts has no `code` and the port's
   * does not either: the only way to keep it stable is for no path to be able
   * to write it after the insert.
   */
  async updateSpecialty(
    id: string,
    patch: { name?: string; active?: boolean },
    requester: Requester,
  ): Promise<SpecialtyView> {
    // SP-029. The row as it stood, so the trail can say what was replaced.
    const current = await this.repository.findSpecialty(id);
    if (!current) throw new SpecialtyNotFoundError();

    const updated = await this.repository.updateSpecialty(id, patch);
    if (!updated) throw new SpecialtyNotFoundError();

    await this.recordMutation('UPDATE', updated.id, requester, {
      before: specialtySnapshot(current),
      after: specialtySnapshot(updated),
    });
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

  /**
   * SP-020, SP-030. The type and the service it is charged with, born
   * together; the price, if any, from today in Ecuador. Who may set a price is
   * the controller's question (`billing:price-manage`).
   */
  async createServiceType(
    input: {
      specialtyId: string;
      name: string;
      durationMinutes: number;
      price: string | null;
    },
    requester: Requester,
    now: Date = new Date(),
  ): Promise<ServiceTypeView> {
    // The specialty is named by the URL, so a wrong id is a missing resource;
    // letting the FK answer would dress a 404 up as invalid data.
    const specialty = await this.repository.findSpecialty(input.specialtyId);
    if (!specialty) throw new SpecialtyNotFoundError();

    await this.requireSlotMultiple(input.durationMinutes);

    const created = await this.repository.createServiceType({
      ...input,
      today: clinicalDateOf(now),
    });
    await this.recordMutation('CREATE', created.id, requester, {
      after: serviceTypeSnapshot(created),
    });
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
    if (patch.durationMinutes !== undefined) {
      await this.requireSlotMultiple(patch.durationMinutes);
    }

    // SP-029. See `updateSpecialty`.
    const current = await this.repository.findServiceType(id);
    if (!current) throw new ServiceTypeNotFoundError();

    const updated = await this.repository.updateServiceType(id, patch);
    if (!updated) throw new ServiceTypeNotFoundError();

    await this.recordMutation('UPDATE', updated.id, requester, {
      before: serviceTypeSnapshot(current),
      after: serviceTypeSnapshot(updated),
    });
    return updated;
  }

  /**
   * SP-021, D-021. The base duration has to be a whole number of slots, and
   * this is where it is refused: AT SAVE TIME, not at booking time.
   *
   * WHY IT IS NOT A `CHECK`. The atom lives in `site_parameter` and a `CHECK`
   * cannot reach another table. What the base still holds is the range and the
   * step of 5 (`service_type_duration_range`), which the atom's own range
   * makes a consequence of this rule rather than a leftover contradicting it.
   *
   * WHY EVERY SITE AND NOT «THIS» ONE: a service type has no site. The
   * reasoning, and the alternatives that were rejected, are in `clinicSlotAtom`.
   */
  private async requireSlotMultiple(durationMinutes: number): Promise<void> {
    assertDurationFitsSlotAtom(
      'durationMinutes',
      durationMinutes,
      clinicSlotAtom(await this.repository.siteSlotAtoms()),
    );
  }

  /** SP-025. */
  async deleteServiceType(id: string, requester: Requester): Promise<void> {
    const deleted = await this.repository.deleteServiceType(id);
    if (!deleted) throw new ServiceTypeNotFoundError();

    await this.recordMutation('UPDATE', id, requester);
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
    change: { before?: Readonly<object>; after?: Readonly<object> } = {},
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType: 'configuration',
      resourceId,
      action,
      ip: requester.ip,
      userAgent: requester.userAgent,
      // SP-029. Plain copies; `'configuration'` has carried a payload since
      // D-017, and these rows hold names, a duration and a flag — no PHI.
      before: change.before && { ...change.before },
      after: change.after && { ...change.after },
    });
  }
}

/**
 * SP-029. A specialty's fields. The code travels although nobody edits it
 * (SP-010): it is what names the specialty to whoever reads the trail.
 */
function specialtySnapshot(view: SpecialtyView): object {
  return { code: view.code, name: view.name, active: view.active };
}

/** SP-029. A service type's editable fields, with the specialty it hangs off. */
function serviceTypeSnapshot(view: ServiceTypeView): object {
  return {
    specialtyId: view.specialtyId,
    name: view.name,
    durationMinutes: view.durationMinutes,
    active: view.active,
    billableServiceId: view.billableServiceId,
  };
}
