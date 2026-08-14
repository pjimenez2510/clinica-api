import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  ServiceTypeInUseError,
  SpecialtyInUseError,
} from '../domain/specialties.errors';
import type {
  SpecialtiesRepository,
  ServiceTypeView,
  SpecialtyView,
} from '../domain/specialties.repository';
import {
  duplicateErrorFrom,
  isForeignKeyRestriction,
  isRecordNotFound,
} from './specialties-database-errors';

/**
 * Rows in, domain shapes out.
 *
 * Everything Prisma-shaped stops here, and so does every PostgreSQL refusal
 * that means something to an administrator: the functional unique indexes
 * answer as `SPECIALTY_DUPLICATE`/`SERVICE_TYPE_DUPLICATE` (SP-006, SP-026)
 * and a RESTRICT foreign key on a delete answers as the "in use" conflict
 * that offers deactivation (SP-003, SP-025). Nothing here checks first: two
 * administrators writing in the same millisecond are arbitrated by the
 * indexes, not by a read that was stale before it returned.
 */

const SPECIALTY_SELECT = {
  id: true,
  code: true,
  name: true,
  active: true,
} satisfies Prisma.SpecialtySelect;

const SERVICE_TYPE_SELECT = {
  id: true,
  specialtyId: true,
  name: true,
  durationMinutes: true,
  active: true,
} satisfies Prisma.ServiceTypeSelect;

@Injectable()
export class PrismaSpecialtiesRepository implements SpecialtiesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** SP-007. Ordered by name so the screen is stable between requests. */
  async listSpecialties(
    includeInactive: boolean,
  ): Promise<readonly SpecialtyView[]> {
    return this.prisma.specialty.findMany({
      where: includeInactive ? {} : { active: true },
      select: SPECIALTY_SELECT,
      orderBy: { name: 'asc' },
    });
  }

  async findSpecialty(id: string): Promise<SpecialtyView | null> {
    return this.prisma.specialty.findUnique({
      where: { id },
      select: SPECIALTY_SELECT,
    });
  }

  /** SP-002; SP-006 answered by `specialty_code_unique`/`specialty_name_unique`. */
  async createSpecialty(input: {
    code: string;
    name: string;
  }): Promise<SpecialtyView> {
    try {
      return await this.prisma.specialty.create({
        data: input,
        select: SPECIALTY_SELECT,
      });
    } catch (error) {
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  async updateSpecialty(
    id: string,
    patch: { name?: string; active?: boolean },
  ): Promise<SpecialtyView | null> {
    try {
      return await this.prisma.specialty.update({
        where: { id },
        data: patch,
        select: SPECIALTY_SELECT,
      });
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  /** SP-003: the RESTRICT foreign keys have the final word. */
  async deleteSpecialty(id: string): Promise<boolean> {
    try {
      await this.prisma.specialty.delete({ where: { id } });
      return true;
    } catch (error) {
      if (isRecordNotFound(error)) return false;
      if (isForeignKeyRestriction(error)) throw new SpecialtyInUseError();
      throw error;
    }
  }

  async listServiceTypes(
    specialtyId: string,
    includeInactive: boolean,
  ): Promise<readonly ServiceTypeView[]> {
    return this.prisma.serviceType.findMany({
      where: { specialtyId, ...(includeInactive ? {} : { active: true }) },
      select: SERVICE_TYPE_SELECT,
      orderBy: { name: 'asc' },
    });
  }

  /** SP-020; SP-026 answered by `service_type_name_unique_per_specialty`. */
  async createServiceType(input: {
    specialtyId: string;
    name: string;
    durationMinutes: number;
  }): Promise<ServiceTypeView> {
    try {
      return await this.prisma.serviceType.create({
        data: input,
        select: SERVICE_TYPE_SELECT,
      });
    } catch (error) {
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  /**
   * SP-024 is the ABSENCE here: one UPDATE on one `service_type` row. No
   * appointment table is named in this method, so a duration change cannot
   * touch anything already booked — it rules forwards by construction.
   */
  async updateServiceType(
    id: string,
    patch: { name?: string; durationMinutes?: number; active?: boolean },
  ): Promise<ServiceTypeView | null> {
    try {
      return await this.prisma.serviceType.update({
        where: { id },
        data: patch,
        select: SERVICE_TYPE_SELECT,
      });
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw duplicateErrorFrom(error) ?? error;
    }
  }

  /**
   * SP-025. Today the only incoming reference (duration exceptions) CASCADEs
   * by design — a personal override dies with its type — so the RESTRICT
   * branch is armed for the day `agenda_entry` points here (C4).
   */
  async deleteServiceType(id: string): Promise<boolean> {
    try {
      await this.prisma.serviceType.delete({ where: { id } });
      return true;
    } catch (error) {
      if (isRecordNotFound(error)) return false;
      if (isForeignKeyRestriction(error)) throw new ServiceTypeInUseError();
      throw error;
    }
  }

  /**
   * D-021, SP-021. The distinct slot atoms of the clinic's sites.
   *
   * A SITE WITHOUT A ROW CONTRIBUTES NOTHING, and that is not a hole:
   * `trg_site_parameter_defaults` writes the row of D-001 the moment a site is
   * inserted, whoever inserts it (CF-062), so the set of rows IS the set of
   * sites. `distinct` because the answer feeds a lowest common multiple, where
   * repeating a value changes nothing.
   */
  async siteSlotAtoms(): Promise<readonly number[]> {
    const rows = await this.prisma.siteParameter.findMany({
      distinct: ['slotAtomMinutes'],
      select: { slotAtomMinutes: true },
    });
    return rows.map((row) => row.slotAtomMinutes);
  }
}
