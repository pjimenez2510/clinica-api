import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { SiteInUseError } from '../domain/organization.errors';
import type {
  EstablishmentInput,
  EstablishmentView,
  OrganizationRepository,
  SiteInput,
  SitePatch,
  SiteView,
} from '../domain/organization.repository';
import {
  duplicateErrorFrom,
  isForeignKeyRestriction,
  isRecordNotFound,
} from './organization-database-errors';

/**
 * Rows in, domain shapes out.
 *
 * Everything Prisma-shaped stops here, and so does every PostgreSQL refusal
 * that means something to an administrator: the unique indexes answer as
 * `MSP_UNICODE_DUPLICATE` (OR-002) and a RESTRICT foreign key on a delete
 * answers as the "in use" conflict that offers deactivation (OR-006). Nothing
 * here checks first: two administrators writing in the same millisecond are
 * arbitrated by the indexes, not by a read that was stale before it returned.
 */

const ESTABLISHMENT_SELECT = {
  id: true,
  mspUnicode: true,
  typology: true,
  legalName: true,
  ruc: true,
  active: true,
} satisfies Prisma.EstablishmentSelect;

const SITE_SELECT = {
  id: true,
  establishmentId: true,
  mspUnicode: true,
  name: true,
  ruc: true,
  parishConceptId: true,
  addressLine: true,
  phone: true,
  active: true,
} satisfies Prisma.SiteSelect;

@Injectable()
export class PrismaOrganizationRepository implements OrganizationRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The oldest row. `uuidv7()` is time-ordered, so ordering by id is ordering
   * by creation without reading a second column — and it is stable, which is
   * what matters: the screens must not see a different establishment because
   * two rows happened to be written in the same millisecond.
   */
  async findEstablishment(): Promise<EstablishmentView | null> {
    return this.prisma.establishment.findFirst({
      select: ESTABLISHMENT_SELECT,
      orderBy: { id: 'asc' },
    });
  }

  /** OR-001; OR-002 answered by `establishment_msp_unicode_unique`. */
  async createEstablishment(
    input: EstablishmentInput,
  ): Promise<EstablishmentView> {
    try {
      return await this.prisma.establishment.create({
        data: input,
        select: ESTABLISHMENT_SELECT,
      });
    } catch (error) {
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  async updateEstablishment(
    id: string,
    input: EstablishmentInput,
  ): Promise<EstablishmentView | null> {
    try {
      return await this.prisma.establishment.update({
        where: { id },
        data: input,
        select: ESTABLISHMENT_SELECT,
      });
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  /** OR-007. Ordered by name so the screen is stable between requests. */
  async listSites(includeInactive: boolean): Promise<readonly SiteView[]> {
    return this.prisma.site.findMany({
      where: includeInactive ? {} : { active: true },
      select: SITE_SELECT,
      orderBy: { name: 'asc' },
    });
  }

  async findSite(id: string): Promise<SiteView | null> {
    return this.prisma.site.findUnique({
      where: { id },
      select: SITE_SELECT,
    });
  }

  /** OR-004; OR-002 answered by `site_msp_unicode_key`. */
  async createSite(input: SiteInput): Promise<SiteView> {
    try {
      return await this.prisma.site.create({
        data: input,
        select: SITE_SELECT,
      });
    } catch (error) {
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  /**
   * The MSP code is NOT patchable, and that is the whole reason `SitePatch`
   * does not carry it: it identifies the site in every attention already
   * reported to the ministry (REQ-020), so changing it would rewrite the
   * meaning of reports already filed.
   */
  async updateSite(id: string, patch: SitePatch): Promise<SiteView | null> {
    try {
      return await this.prisma.site.update({
        where: { id },
        data: patch,
        select: SITE_SELECT,
      });
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  /** OR-006: the RESTRICT foreign keys have the final word. */
  async deleteSite(id: string): Promise<boolean> {
    try {
      await this.prisma.site.delete({ where: { id } });
      return true;
    } catch (error) {
      if (isRecordNotFound(error)) return false;
      if (isForeignKeyRestriction(error)) throw new SiteInUseError();
      throw error;
    }
  }
}
