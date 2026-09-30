import { Inject, Injectable } from '@nestjs/common';

import {
  type ClinicalDate,
  addDays,
  clinicalDateOf,
} from '../../../shared/domain/clinic-time';
import {
  ACESS_WARNING_DAYS,
  type AcessStatus,
  acessStatusOn,
} from '../domain/acess-eligibility';
import {
  AcessExpiredError,
  AcessMissingError,
  PractitionerNotFoundError,
} from '../domain/staff.errors';
import {
  type AcessExpiryRow,
  type PractitionerView,
  STAFF_REPOSITORY,
  type StaffRepository,
} from '../domain/staff.repository';

import { type Requester, StaffAuditTrail } from './staff-audit.trail';

/** ST-005, as the warning screen reads it: the row plus how long is left. */
export interface AcessExpiryWarning extends AcessExpiryRow {
  daysToExpiry: number;
}

/**
 * The practitioner's file and their habilitación (S1).
 *
 * The authorisation decision is NOT here — the guard settled it from the
 * route's `@RequirePermission`. What IS here is what must hold whichever
 * endpoint asked: the audit entry on every mutation (ST-010), and the fact
 * that a practitioner with history is DEACTIVATED and never deleted.
 *
 * WHAT THIS SERVICE DOES NOT DO: check for a duplicate cedula, a duplicate
 * profile or existing history before writing. Two administrators registering
 * the same person in the same millisecond both read "free"; only the unique
 * index on `app_user.cedula`, the one on `practitioner.user_id` and the
 * RESTRICT foreign keys can arbitrate, and the adapter translates their
 * refusal into the codes the SPEC fixes.
 *
 * THE CLOCK ENTERS HERE AND NOWHERE DEEPER. `acessStatusOn` takes the clinical
 * date as a parameter so it can be tested without travelling in time; this
 * layer is where "today" is resolved, and it is resolved in
 * `America/Guayaquil` — a `::date` on the host's zone shifts the evening by a
 * day, which is exactly the kind of error that refuses a signature on a day
 * the ACESS paper says is valid.
 */
@Injectable()
export class PractitionerService {
  constructor(
    @Inject(STAFF_REPOSITORY)
    private readonly repository: StaffRepository,
    private readonly trail: StaffAuditTrail,
  ) {}

  /** ST-010: administration lists everything on demand; selection defaults to active. */
  async list(includeInactive: boolean): Promise<readonly PractitionerView[]> {
    return this.repository.listPractitioners(includeInactive);
  }

  /** One practitioner, active or not; `PractitionerNotFoundError` when there is none. */
  async get(id: string): Promise<PractitionerView> {
    const practitioner = await this.repository.findPractitioner(id);
    if (!practitioner) throw new PractitionerNotFoundError();
    return practitioner;
  }

  /** ST-001..ST-003, ST-006. */
  async create(
    input: { userId: string; mspCode?: string | null; schedulable?: boolean },
    requester: Requester,
  ): Promise<PractitionerView> {
    const created = await this.repository.createPractitioner({
      userId: input.userId,
      mspCode: input.mspCode ?? null,
      schedulable: input.schedulable ?? true,
    });
    await this.trail.record('CREATE', created.id, requester);
    return created;
  }

  /**
   * ST-001..ST-003, ST-006, ST-010. The cedula and the ACESS travel in this
   * patch even though they are stored on `app_user`: from the screen they are
   * the professional's file, and splitting the form across two endpoints would
   * mean a half-registered practitioner every time the second call failed.
   */
  async update(
    id: string,
    patch: {
      mspCode?: string | null;
      schedulable?: boolean;
      active?: boolean;
      cedula?: string | null;
      acessRegistration?: string | null;
      acessExpiresOn?: ClinicalDate | null;
    },
    requester: Requester,
  ): Promise<PractitionerView> {
    const updated = await this.repository.updatePractitioner(id, patch);
    if (!updated) throw new PractitionerNotFoundError();

    await this.trail.record('UPDATE', updated.id, requester);
    return updated;
  }

  /**
   * ST-010. The attempt is a DELETE and the outcome is usually not: the
   * RESTRICT foreign keys refuse the moment there is an appointment, an
   * encounter or a signed document, and the adapter turns that into
   * `PRACTITIONER_IN_USE`, whose sentence offers deactivation instead.
   *
   * Deleting a practitioner who never worked stays possible on purpose — a
   * profile created against the wrong account is a typo, and forcing the
   * clinic to keep a deactivated ghost of it forever is not caution, it is
   * clutter.
   */
  async delete(id: string, requester: Requester): Promise<void> {
    const deleted = await this.repository.deletePractitioner(id);
    if (!deleted) throw new PractitionerNotFoundError();

    await this.trail.record('UPDATE', id, requester);
  }

  /**
   * ST-005. Who has 30 days or fewer left, WITHOUT blocking anything.
   *
   * The window is a parameter with the requirement's number as its default:
   * the SPEC fixes 30 days as what the clinic is entitled to, not as the only
   * question anybody may ask.
   */
  async listAcessExpiring(
    withinDays: number = ACESS_WARNING_DAYS,
    today: ClinicalDate = clinicalDateOf(new Date()),
  ): Promise<readonly AcessExpiryWarning[]> {
    const rows = await this.repository.listAcessExpiringThrough(
      addDays(today, withinDays),
    );

    return rows.map((row) => ({
      ...row,
      // Through the same function the refusal uses, so the warning and the
      // block can never disagree about which day is the last one.
      daysToExpiry:
        acessStatusOn(
          {
            registration: row.acessRegistration,
            expiresOn: row.acessExpiresOn,
          },
          today,
        ).daysToExpiry ?? 0,
    }));
  }

  /**
   * ST-002, ST-004 — THE signature-time check (D-009, REQ-041).
   *
   * It REFUSES rather than reporting, and that is the requirement: whoever is
   * about to sign a note, a prescription or a certificate asks this, and an
   * expired registration has to stop them. Reporting `{eligible: false}` with
   * a 200 would make the refusal optional for every future caller, and the one
   * that forgot to read the flag would sign anyway.
   *
   * `agenda` DOES NOT CALL THIS AND MUST NOT. D-009 settled that an expired
   * ACESS blocks the signature and never the booking, so this module stays
   * outside the booking path entirely.
   */
  async assertMaySign(
    practitionerId: string,
    on: ClinicalDate = clinicalDateOf(new Date()),
  ): Promise<AcessStatus> {
    const practitioner = await this.get(practitionerId);
    const status = acessStatusOn(
      {
        registration: practitioner.acessRegistration,
        expiresOn: practitioner.acessExpiresOn,
      },
      on,
    );

    if (status.reason === 'MISSING') throw new AcessMissingError();
    // Non-null: `EXPIRED` is only reachable with a date in hand.
    if (status.reason === 'EXPIRED') {
      throw new AcessExpiredError(status.expiresOn ?? on);
    }
    return status;
  }
}
