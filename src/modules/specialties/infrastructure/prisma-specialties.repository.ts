import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  ServiceTypeInUseError,
  SpecialtyInUseError,
} from '../domain/specialties.errors';
import type {
  SpecialtiesRepository,
  PractitionerDurationRow,
  PractitionerSpecialtyView,
  ServiceTypeView,
  SpecialtyAssignment,
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

  async findSpecialtiesByIds(
    ids: readonly string[],
  ): Promise<readonly SpecialtyView[]> {
    return this.prisma.specialty.findMany({
      where: { id: { in: [...ids] } },
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

  async findServiceType(id: string): Promise<ServiceTypeView | null> {
    return this.prisma.serviceType.findUnique({
      where: { id },
      select: SERVICE_TYPE_SELECT,
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

  async practitionerExists(id: string): Promise<boolean> {
    const row = await this.prisma.practitioner.findUnique({
      where: { id },
      select: { id: true },
    });
    return row !== null;
  }

  /** SP-008: primary first, so the agenda reads row zero. */
  async listPractitionerSpecialties(
    practitionerId: string,
  ): Promise<readonly PractitionerSpecialtyView[]> {
    const rows = await this.prisma.practitionerSpecialty.findMany({
      where: { practitionerId },
      select: {
        specialtyId: true,
        isPrimary: true,
        specialty: { select: { code: true, name: true, active: true } },
      },
      orderBy: [{ isPrimary: 'desc' }, { specialty: { name: 'asc' } }],
    });

    return rows.map((row) => ({
      specialtyId: row.specialtyId,
      code: row.specialty.code,
      name: row.specialty.name,
      active: row.specialty.active,
      isPrimary: row.isPrimary,
    }));
  }

  /**
   * SP-005, replace-set in ONE transaction: what is not named disappears,
   * what is named is written fresh. Delete-then-insert rather than a diff —
   * the set is a handful of rows, and a diff would trade readability for
   * nothing measurable. The partial unique index arbitrates any concurrent
   * writer that slips in between.
   */
  async replacePractitionerSpecialties(
    practitionerId: string,
    items: readonly SpecialtyAssignment[],
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.practitionerSpecialty.deleteMany({
        where: { practitionerId },
      }),
      this.prisma.practitionerSpecialty.createMany({
        data: items.map((item) => ({
          practitionerId,
          specialtyId: item.specialtyId,
          isPrimary: item.isPrimary,
        })),
      }),
    ]);
  }

  /**
   * The two upper levels of SP-023 for every service type the practitioner's
   * specialties offer. Only ACTIVE types of ACTIVE specialties: this listing
   * feeds selection (SP-004, SP-007), not administration.
   */
  async listPractitionerDurations(
    practitionerId: string,
  ): Promise<readonly PractitionerDurationRow[]> {
    const rows = await this.prisma.serviceType.findMany({
      where: {
        active: true,
        specialty: {
          active: true,
          practitioners: { some: { practitionerId } },
        },
      },
      select: {
        id: true,
        name: true,
        durationMinutes: true,
        specialty: { select: { id: true, name: true } },
        durationExceptions: {
          where: { practitionerId },
          select: { durationMinutes: true },
        },
      },
      orderBy: [{ specialty: { name: 'asc' } }, { name: 'asc' }],
    });

    return rows.map((row) => ({
      serviceTypeId: row.id,
      serviceTypeName: row.name,
      specialtyId: row.specialty.id,
      specialtyName: row.specialty.name,
      baseMinutes: row.durationMinutes,
      exceptionMinutes: row.durationExceptions[0]?.durationMinutes ?? null,
    }));
  }

  /** SP-022. One statement; the composite key is the identity. */
  async upsertDurationException(
    practitionerId: string,
    serviceTypeId: string,
    durationMinutes: number,
  ): Promise<void> {
    await this.prisma.durationException.upsert({
      where: {
        practitionerId_serviceTypeId: { practitionerId, serviceTypeId },
      },
      update: { durationMinutes },
      create: { practitionerId, serviceTypeId, durationMinutes },
    });
  }

  async deleteDurationException(
    practitionerId: string,
    serviceTypeId: string,
  ): Promise<boolean> {
    const result = await this.prisma.durationException.deleteMany({
      where: { practitionerId, serviceTypeId },
    });
    return result.count > 0;
  }
}
