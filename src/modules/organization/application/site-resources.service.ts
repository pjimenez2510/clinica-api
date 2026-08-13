import { Inject, Injectable } from '@nestjs/common';

import {
  ACCESS_AUDIT_RECORDER,
  type AccessAuditRecorder,
  type AuditAction,
} from '../../../shared/audit/access-audit.port';
import {
  EmissionPointNotFoundError,
  SiteNotFoundError,
  SiteRoomNotFoundError,
} from '../domain/organization.errors';
import {
  SITE_RESOURCES_REPOSITORY,
  type EmissionPointView,
  type SiteResourcesRepository,
  type SiteRoomView,
} from '../domain/site-resources.repository';

import type { Requester } from './organization.service';

/**
 * Consulting rooms and points of emission (O2: OR-020..OR-026).
 *
 * A SECOND SERVICE and not more methods on `OrganizationService`: together
 * they would cross the ~8 public use cases the constitution fixes as the point
 * where an aggregate service is split (§3), and the two halves change for
 * different reasons — one when the MSP changes its typologies, the other when
 * the SRI changes how comprobantes are numbered.
 *
 * What is common to every method here: the site named by the URL must exist
 * before anything is written, so a wrong id answers 404 instead of letting the
 * foreign key dress it up as invalid data. And every mutation goes into the
 * trail (OR-026).
 */
@Injectable()
export class SiteResourcesService {
  constructor(
    @Inject(SITE_RESOURCES_REPOSITORY)
    private readonly repository: SiteResourcesRepository,
    @Inject(ACCESS_AUDIT_RECORDER)
    private readonly audit: AccessAuditRecorder,
  ) {}

  /**
   * The site a room belongs to, so the caller's scope can be checked against
   * it before anything is written (ADR-007).
   *
   * IT IS A READ AND NOT A DECISION: the service says which site owns the row,
   * and the controller — where every other authorisation decision in this
   * codebase is taken — decides whether the caller may act there. A missing
   * row answers 404 here rather than 403, because that is what it already
   * answered before any scope check existed and «no existe» is the truthful
   * answer to whoever may act on the site.
   */
  async siteOfRoom(id: string): Promise<string> {
    const siteId = await this.repository.siteOfRoom(id);
    if (siteId === null) throw new SiteRoomNotFoundError();

    return siteId;
  }

  /** See `siteOfRoom`. */
  async siteOfEmissionPoint(id: string): Promise<string> {
    const siteId = await this.repository.siteOfEmissionPoint(id);
    if (siteId === null) throw new EmissionPointNotFoundError();

    return siteId;
  }

  /** OR-022: deactivated rooms are not offered for new appointments. */
  async listRooms(
    siteId: string,
    includeInactive: boolean,
  ): Promise<readonly SiteRoomView[]> {
    await this.requireSite(siteId);
    return this.repository.listRooms(siteId, includeInactive);
  }

  /** OR-020, OR-026. */
  async createRoom(
    siteId: string,
    name: string,
    requester: Requester,
  ): Promise<SiteRoomView> {
    await this.requireSite(siteId);

    const created = await this.repository.createRoom({ siteId, name });
    await this.recordMutation('CREATE', created.id, requester);
    return created;
  }

  /** OR-022 (deactivate), OR-026. */
  async updateRoom(
    id: string,
    patch: { name?: string; active?: boolean },
    requester: Requester,
  ): Promise<SiteRoomView> {
    const updated = await this.repository.updateRoom(id, patch);
    if (!updated) throw new SiteRoomNotFoundError();

    await this.recordMutation('UPDATE', updated.id, requester);
    return updated;
  }

  /**
   * OR-022. Refused with `SITE_ROOM_IN_USE` when an appointment references
   * the room — the requirement asks for deactivation, not for amputating the
   * appointments that already happened there.
   */
  async deleteRoom(id: string, requester: Requester): Promise<void> {
    const deleted = await this.repository.deleteRoom(id);
    if (!deleted) throw new SiteRoomNotFoundError();

    await this.recordMutation('UPDATE', id, requester);
  }

  /** OR-023, OR-025: served as data, with no sequential and no SRI dialogue. */
  async listEmissionPoints(
    siteId: string,
    includeInactive: boolean,
  ): Promise<readonly EmissionPointView[]> {
    await this.requireSite(siteId);
    return this.repository.listEmissionPoints(siteId, includeInactive);
  }

  /** OR-023, OR-024, OR-026. */
  async createEmissionPoint(
    siteId: string,
    input: { code: string; description?: string | null },
    requester: Requester,
  ): Promise<EmissionPointView> {
    await this.requireSite(siteId);

    const created = await this.repository.createEmissionPoint({
      siteId,
      code: input.code,
      description: input.description ?? null,
    });
    await this.recordMutation('CREATE', created.id, requester);
    return created;
  }

  /**
   * OR-026. The CODE is not editable: `billing` will store it on every
   * comprobante it issues (REQ-085), so changing it would rewrite the meaning
   * of documents already filed with the SRI. Renaming the description or
   * deactivating the point is what an administrator actually needs.
   */
  async updateEmissionPoint(
    id: string,
    patch: { description?: string | null; active?: boolean },
    requester: Requester,
  ): Promise<EmissionPointView> {
    const updated = await this.repository.updateEmissionPoint(id, patch);
    if (!updated) throw new EmissionPointNotFoundError();

    await this.recordMutation('UPDATE', updated.id, requester);
    return updated;
  }

  /** OR-026. */
  async deleteEmissionPoint(id: string, requester: Requester): Promise<void> {
    const deleted = await this.repository.deleteEmissionPoint(id);
    if (!deleted) throw new EmissionPointNotFoundError();

    await this.recordMutation('UPDATE', id, requester);
  }

  private async requireSite(siteId: string): Promise<void> {
    const exists = await this.repository.siteExists(siteId);
    if (!exists) throw new SiteNotFoundError();
  }

  /** OR-026: author and instant for every mutation. See `OrganizationService`. */
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
