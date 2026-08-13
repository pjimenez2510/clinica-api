import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { SiteRoomInUseError } from '../domain/organization.errors';
import type {
  EmissionPointView,
  SiteResourcesRepository,
  SiteRoomView,
} from '../domain/site-resources.repository';
import {
  duplicateErrorFrom,
  isForeignKeyRestriction,
  isRecordNotFound,
} from './organization-database-errors';

/**
 * Rooms and points of emission, rows in and domain shapes out.
 *
 * The refusals that mean something to an administrator stop here: the unique
 * indexes answer as `SITE_ROOM_DUPLICATE` (OR-020) and
 * `EMISSION_POINT_DUPLICATE` (OR-024), and the RESTRICT foreign key from
 * `agenda_entry.room_id` answers as `SITE_ROOM_IN_USE` (OR-022).
 */

const ROOM_SELECT = {
  id: true,
  siteId: true,
  name: true,
  active: true,
} satisfies Prisma.SiteRoomSelect;

const EMISSION_POINT_SELECT = {
  id: true,
  siteId: true,
  code: true,
  description: true,
  active: true,
} satisfies Prisma.EmissionPointSelect;

@Injectable()
export class PrismaSiteResourcesRepository implements SiteResourcesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async siteExists(siteId: string): Promise<boolean> {
    const row = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { id: true },
    });
    return row !== null;
  }

  async listRooms(
    siteId: string,
    includeInactive: boolean,
  ): Promise<readonly SiteRoomView[]> {
    return this.prisma.siteRoom.findMany({
      where: { siteId, ...(includeInactive ? {} : { active: true }) },
      select: ROOM_SELECT,
      orderBy: { name: 'asc' },
    });
  }

  /** OR-020, answered by `site_room_site_id_name_key`. */
  async createRoom(input: {
    siteId: string;
    name: string;
  }): Promise<SiteRoomView> {
    try {
      return await this.prisma.siteRoom.create({
        data: input,
        select: ROOM_SELECT,
      });
    } catch (error) {
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  /**
   * The SITE is not patchable, and that is OR-021 in this file: moving a room
   * to another site would strand every appointment already booked in it. The
   * composite foreign key would refuse the move anyway; not offering it is
   * cheaper than explaining the refusal.
   */
  async updateRoom(
    id: string,
    patch: { name?: string; active?: boolean },
  ): Promise<SiteRoomView | null> {
    try {
      return await this.prisma.siteRoom.update({
        where: { id },
        data: patch,
        select: ROOM_SELECT,
      });
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  /** OR-022: `agenda_entry.room_id` is RESTRICT, and it has the final word. */
  async deleteRoom(id: string): Promise<boolean> {
    try {
      await this.prisma.siteRoom.delete({ where: { id } });
      return true;
    } catch (error) {
      if (isRecordNotFound(error)) return false;
      if (isForeignKeyRestriction(error)) throw new SiteRoomInUseError();
      throw error;
    }
  }

  /** OR-023. Ordered by code: that is how the SRI lists them. */
  async listEmissionPoints(
    siteId: string,
    includeInactive: boolean,
  ): Promise<readonly EmissionPointView[]> {
    return this.prisma.emissionPoint.findMany({
      where: { siteId, ...(includeInactive ? {} : { active: true }) },
      select: EMISSION_POINT_SELECT,
      orderBy: { code: 'asc' },
    });
  }

  /** OR-023; OR-024 answered by `emission_point_code_unique_per_site`. */
  async createEmissionPoint(input: {
    siteId: string;
    code: string;
    description: string | null;
  }): Promise<EmissionPointView> {
    try {
      return await this.prisma.emissionPoint.create({
        data: input,
        select: EMISSION_POINT_SELECT,
      });
    } catch (error) {
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  async updateEmissionPoint(
    id: string,
    patch: { description?: string | null; active?: boolean },
  ): Promise<EmissionPointView | null> {
    try {
      return await this.prisma.emissionPoint.update({
        where: { id },
        data: patch,
        select: EMISSION_POINT_SELECT,
      });
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * No "in use" branch: nothing references `emission_point` today. When
   * `billing` starts issuing comprobantes (REQ-085) it brings the foreign key
   * and the code that goes with it.
   */
  async deleteEmissionPoint(id: string): Promise<boolean> {
    try {
      await this.prisma.emissionPoint.delete({ where: { id } });
      return true;
    } catch (error) {
      if (isRecordNotFound(error)) return false;
      throw error;
    }
  }
}
