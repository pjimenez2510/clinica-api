import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
  type AuditAction,
} from '../../../shared/audit/access-audit.port';
import { Ruc } from '../../../shared/domain/value-objects/ruc.vo';
import {
  EstablishmentNotFoundError,
  SiteNotFoundError,
} from '../domain/organization.errors';
import {
  ORGANIZATION_REPOSITORY,
  type DocumentIdentityInput,
  type EstablishmentInput,
  type EstablishmentView,
  type OrganizationRepository,
  type RimpeRegime,
  type SiteInput,
  type SitePatch,
  type SiteScopeFilter,
  type SiteView,
} from '../domain/organization.repository';

/** Who is asking, so the trail can say so (OR-005). */
export interface Requester {
  userId: string;
  ip?: string;
  userAgent?: string;
}

/** The establishment form, before the RUC has been validated (OR-008). */
export interface EstablishmentCommand {
  mspUnicode: string;
  typology: string;
  legalName: string;
  ruc?: string | null;
  /** OR-028. Absent keeps what is stored: the screen may not know the field. */
  headOfficeAddress?: string | null;
  /** OR-029. Each absent flag keeps what is stored. */
  keepsAccounting?: boolean;
  specialTaxpayerResolution?: string | null;
  withholdingAgentResolution?: string | null;
  rimpeRegime?: RimpeRegime;
  /** OR-031. True only when a person ticked that the flags were checked. */
  confirmsFiscalProfile?: boolean;
  active?: boolean;
}

/**
 * OR-004. No establishment id: the site hangs from the one registered, resolved
 * by `createSite`. The RUC is validated before it is written (OR-008).
 */
export interface CreateSiteCommand {
  mspUnicode: string;
  name: string;
  ruc?: string | null;
  parishConceptId?: string | null;
  addressLine?: string | null;
  phone?: string | null;
  sriEstablishmentCode?: string | null;
}

/**
 * OR-004, OR-007. The MSP code is absent and cannot be patched; `active: false`
 * is how a site that cannot be deleted is retired (OR-006).
 */
export interface UpdateSiteCommand {
  name?: string;
  ruc?: string | null;
  parishConceptId?: string | null;
  addressLine?: string | null;
  phone?: string | null;
  /** OR-027. */
  sriEstablishmentCode?: string | null;
  active?: boolean;
}

/**
 * The establishment and its sites (O1: OR-001..OR-008).
 *
 * The authorisation decision is NOT here — the guard settled it from the
 * route's `@RequirePermission`. What IS here is what must hold regardless of
 * which endpoint asked: the RUC actually being a RUC (OR-008), and an audit
 * entry on every mutation (OR-005).
 *
 * WHAT THIS SERVICE DOES NOT DO: check for duplicates or references before
 * writing. Two administrators registering the same MSP code in the same
 * millisecond both read "free"; only the unique index can arbitrate, and the
 * adapter translates its refusal into the codes the SPEC fixes (OR-002,
 * OR-006).
 */
@Injectable()
export class OrganizationService {
  constructor(
    @Inject(ORGANIZATION_REPOSITORY)
    private readonly repository: OrganizationRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  /**
   * OR-003: the MSP code travels to whoever must write it on every attention.
   * A 404 when nothing is registered yet is the honest answer, and OR-001 is
   * the reason it is an error and not an empty body: the clinic must not
   * operate without a typology and a code.
   */
  async getEstablishment(): Promise<EstablishmentView> {
    const establishment = await this.repository.findEstablishment();
    if (!establishment) throw new EstablishmentNotFoundError();

    return establishment;
  }

  /**
   * OR-001, OR-002, OR-008. Create-or-update in one verb because there IS one
   * establishment: a POST that failed the second time would force the screen
   * to ask "does it exist yet?" before every save, and the answer would be
   * stale by the time it acted on it.
   */
  async saveEstablishment(
    command: EstablishmentCommand,
    requester: Requester,
  ): Promise<EstablishmentView> {
    const input: EstablishmentInput = {
      mspUnicode: command.mspUnicode,
      typology: command.typology,
      legalName: command.legalName,
      ruc: OrganizationService.validRuc(command.ruc),
      headOfficeAddress: command.headOfficeAddress ?? null,
      keepsAccounting: command.keepsAccounting ?? false,
      specialTaxpayerResolution: command.specialTaxpayerResolution ?? null,
      withholdingAgentResolution: command.withholdingAgentResolution ?? null,
      rimpeRegime: command.rimpeRegime ?? 'NONE',
      // OR-031. Declared only when a person says so, with the two flags that
      // have a default in hand: a save that merely carries them (the form
      // always does) states nothing to the SRI.
      declaresFiscalProfile:
        command.confirmsFiscalProfile === true &&
        command.keepsAccounting !== undefined &&
        command.rimpeRegime !== undefined,
      active: command.active ?? true,
    };

    const current = await this.repository.findEstablishment();
    // OR-028, OR-029. A form that predates a field does not send it, and a
    // PUT without it must not erase what the vouchers declare.
    if (current) {
      if (command.headOfficeAddress === undefined) {
        input.headOfficeAddress = current.headOfficeAddress;
      }
      if (command.keepsAccounting === undefined) {
        input.keepsAccounting = current.keepsAccounting;
      }
      if (command.specialTaxpayerResolution === undefined) {
        input.specialTaxpayerResolution = current.specialTaxpayerResolution;
      }
      if (command.withholdingAgentResolution === undefined) {
        input.withholdingAgentResolution = current.withholdingAgentResolution;
      }
      if (command.rimpeRegime === undefined) {
        input.rimpeRegime = current.rimpeRegime;
      }
    }
    if (!current) {
      const created = await this.repository.createEstablishment(input);
      await this.recordMutation('CREATE', created.id, requester);
      return created;
    }

    const updated = await this.repository.updateEstablishment(
      current.id,
      input,
    );
    // Somebody deleted it between the read and the write. Answering 404 is
    // truthful; retrying would be guessing what the caller wanted.
    if (!updated) throw new EstablishmentNotFoundError();

    await this.recordMutation('UPDATE', updated.id, requester);
    return updated;
  }

  /**
   * OR-010 to OR-012. What the documents' header prints. Blank is absent: a
   * field nobody filled is not printed, never invented (DOC-080).
   */
  async saveDocumentIdentity(
    command: DocumentIdentityInput,
    requester: Requester,
  ): Promise<EstablishmentView> {
    const current = await this.repository.findEstablishment();
    if (!current) throw new EstablishmentNotFoundError();

    const present = (value: string | null): string | null =>
      value === null || value.trim() === '' ? null : value.trim();

    const updated = await this.repository.updateDocumentIdentity(current.id, {
      tradeName: present(command.tradeName),
      contactEmail: present(command.contactEmail),
      operatingPermit: present(command.operatingPermit),
    });
    if (!updated) throw new EstablishmentNotFoundError();

    await this.recordMutation('UPDATE', updated.id, requester);
    return updated;
  }

  /**
   * OR-007: deactivated sites are not offered unless explicitly asked for.
   *
   * The SCOPE is the caller's own, resolved by the controller from their
   * grants (ADR-007): the route declares `'query'` site scope because there is
   * no site in the URL for the guard to check, and this is where the narrowing
   * lands. Passing anything other than the caller's resolved scope here is the
   * bug this sentence exists to prevent — same contract as the agenda's
   * AG-107 listing.
   */
  async listSites(
    includeInactive: boolean,
    scope: SiteScopeFilter,
  ): Promise<readonly SiteView[]> {
    return this.repository.listSites(includeInactive, scope);
  }

  /**
   * 404 for an unknown id. The site-scope check already happened in the guard,
   * from the route parameter.
   */
  async getSite(id: string): Promise<SiteView> {
    const site = await this.repository.findSite(id);
    if (!site) throw new SiteNotFoundError();

    return site;
  }

  /** OR-004, OR-005, OR-008. */
  async createSite(
    command: CreateSiteCommand,
    requester: Requester,
  ): Promise<SiteView> {
    // The site belongs to the establishment that is registered. `null` when
    // none is — the column is nullable precisely so the rows that predate
    // `establishment` survived, and refusing here would block the clinic from
    // adding a site before filling the establishment form.
    const establishment = await this.repository.findEstablishment();

    const input: SiteInput = {
      mspUnicode: command.mspUnicode,
      establishmentId: establishment?.id ?? null,
      name: command.name,
      ruc: OrganizationService.validRuc(command.ruc),
      parishConceptId: command.parishConceptId ?? null,
      addressLine: command.addressLine ?? null,
      phone: command.phone ?? null,
      sriEstablishmentCode: command.sriEstablishmentCode ?? null,
    };

    const created = await this.repository.createSite(input);
    await this.recordMutation('CREATE', created.id, requester);
    return created;
  }

  /** OR-005, OR-007 (deactivate), OR-008. */
  async updateSite(
    id: string,
    command: UpdateSiteCommand,
    requester: Requester,
  ): Promise<SiteView> {
    const patch: SitePatch = {
      name: command.name,
      parishConceptId: command.parishConceptId,
      addressLine: command.addressLine,
      phone: command.phone,
      sriEstablishmentCode: command.sriEstablishmentCode,
      active: command.active,
    };
    // Only when the caller sent the field: `undefined` means "leave it", and
    // `null` means "clear it". Collapsing the two would erase a RUC on every
    // rename.
    if (command.ruc !== undefined) {
      patch.ruc = OrganizationService.validRuc(command.ruc);
    }

    const updated = await this.repository.updateSite(id, patch);
    if (!updated) throw new SiteNotFoundError();

    await this.recordMutation('UPDATE', updated.id, requester);
    return updated;
  }

  /**
   * OR-006. A hard delete that only succeeds when nothing references the site;
   * otherwise the adapter raises `SiteInUseError` from the FK refusal and the
   * client is offered deactivation instead.
   */
  async deleteSite(id: string, requester: Requester): Promise<void> {
    const deleted = await this.repository.deleteSite(id);
    if (!deleted) throw new SiteNotFoundError();

    await this.recordMutation('UPDATE', id, requester);
  }

  /**
   * OR-008. An empty string is the browser's way of saying "no RUC" and is
   * stored as NULL; anything else must survive the SRI's algorithms, and the
   * value object is the only place that knows them — for the establishment,
   * for the site and, later, for the invoice.
   */
  private static validRuc(ruc: string | null | undefined): string | null {
    const trimmed = ruc?.trim();
    if (!trimmed) return null;

    return Ruc.create(trimmed).toString();
  }

  /**
   * OR-005: every mutation leaves author and instant in the trail. The port
   * guarantees a failure to record never blocks the mutation itself.
   *
   * `resourceType` is `organization`, the module — not `configuration`, which
   * is what `specialties` still writes for rows that already exist. This
   * module has no history to keep compatible, so it starts on the vocabulary
   * ADR-011 settled instead of inheriting one it would have to migrate.
   */
  private async recordMutation(
    action: AuditAction,
    resourceId: string,
    requester: Requester,
  ): Promise<void> {
    await this.audit.record({
      userId: requester.userId,
      resourceType: 'organization',
      resourceId,
      action,
      ip: requester.ip,
      userAgent: requester.userAgent,
    });
  }
}
