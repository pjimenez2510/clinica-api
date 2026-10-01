import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { ClinicalDate } from '../../../shared/domain/clinic-time';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { PractitionerInUseError } from '../domain/staff.errors';
import type {
  AcessExpiryRow,
  PractitionerDurationRow,
  PractitionerSiteView,
  PractitionerSpecialtyView,
  PractitionerView,
  SpecialtyAssignment,
  SpecialtyReference,
  StaffRepository,
} from '../domain/staff.repository';

import {
  isForeignKeyRestriction,
  isRecordNotFound,
} from './staff-database-errors';

/**
 * Rows in, domain shapes out.
 *
 * Everything Prisma-shaped stops here, and so does every PostgreSQL refusal
 * that means something to an administrator: the RESTRICT foreign keys on a
 * delete answer as `PRACTITIONER_IN_USE` (ST-010), and the unique indexes on
 * `app_user.cedula` and `practitioner.user_id` answer through the constraint
 * registry. Nothing here checks first — two administrators registering the
 * same person in the same millisecond are arbitrated by the indexes, not by a
 * read that was stale before it returned.
 *
 * THE FILE SPANS TWO TABLES ON PURPOSE. Cedula and ACESS live on `app_user`
 * and are NOT duplicated onto `practitioner` (ST-001, ST-002): the account is
 * where they belong, its unique index is the guarantee, and a second copy
 * would be a second answer to one question. The cost is that this adapter
 * writes both tables in one transaction, which is the right place for that
 * cost to land — the service never learns the profile is stored in two pieces.
 */

const PRACTITIONER_INCLUDE = {
  user: {
    select: {
      firstName: true,
      lastName: true,
      email: true,
      cedula: true,
      acessRegistration: true,
      acessExpiresOn: true,
    },
  },
  sites: { select: { siteId: true } },
  specialties: {
    where: { isPrimary: true },
    select: { specialty: { select: { id: true, code: true, name: true } } },
  },
} satisfies Prisma.PractitionerInclude;

/** The row `PRACTITIONER_INCLUDE` yields: the practitioner, its account's identity and its primary specialty. */
type PractitionerRow = Prisma.PractitionerGetPayload<{
  include: typeof PRACTITIONER_INCLUDE;
}>;

/**
 * A `date` column as a calendar date.
 *
 * The driver hands a `@db.Date` back as a `Date` at UTC midnight, so the first
 * ten characters of the ISO string ARE the calendar date. Reading it with
 * local getters would shift it by the host's offset — which for Ecuador means
 * the day before, every single time.
 */
function toClinicalDate(value: Date | null): ClinicalDate | null {
  return value === null
    ? null
    : (value.toISOString().slice(0, 10) as ClinicalDate);
}

/** The inverse: a calendar date as the `date` column wants it. */
function fromClinicalDate(value: ClinicalDate | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00Z`);
}

/** The staff port over PostgreSQL, as the note at the top of this file describes. */
@Injectable()
export class PrismaStaffRepository implements StaffRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** ST-010. Ordered by name so the screen is stable between requests. */
  async listPractitioners(
    includeInactive: boolean,
  ): Promise<readonly PractitionerView[]> {
    const rows = await this.prisma.practitioner.findMany({
      where: includeInactive ? {} : { active: true },
      include: PRACTITIONER_INCLUDE,
      orderBy: [{ user: { lastName: 'asc' } }, { user: { firstName: 'asc' } }],
    });
    return rows.map(toView);
  }

  /** Active or not; `null` when there is none. */
  async findPractitioner(id: string): Promise<PractitionerView | null> {
    const row = await this.prisma.practitioner.findUnique({
      where: { id },
      include: PRACTITIONER_INCLUDE,
    });
    return row === null ? null : toView(row);
  }

  async createPractitioner(input: {
    userId: string;
    mspCode: string | null;
    schedulable: boolean;
  }): Promise<PractitionerView> {
    const created = await this.prisma.practitioner.create({
      data: input,
      include: PRACTITIONER_INCLUDE,
    });
    return toView(created);
  }

  /**
   * ONE TRANSACTION over two tables. Writing the profile and then the account
   * would leave a practitioner with a new MSP code and an unchanged ACESS the
   * moment the second statement failed — and the form the administrator filled
   * in was one form.
   */
  async updatePractitioner(
    id: string,
    patch: {
      mspCode?: string | null;
      emergencyContactPhone?: string | null;
      schedulable?: boolean;
      active?: boolean;
      cedula?: string | null;
      acessRegistration?: string | null;
      acessExpiresOn?: ClinicalDate | null;
    },
  ): Promise<PractitionerView | null> {
    const { cedula, acessRegistration, acessExpiresOn, ...profile } = patch;
    const touchesAccount =
      cedula !== undefined ||
      acessRegistration !== undefined ||
      acessExpiresOn !== undefined;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.practitioner.update({
          where: { id },
          data: profile,
          include: PRACTITIONER_INCLUDE,
        });

        if (!touchesAccount) return toView(updated);

        const user = await tx.user.update({
          where: { id: updated.userId },
          data: {
            ...(cedula !== undefined ? { cedula } : {}),
            ...(acessRegistration !== undefined ? { acessRegistration } : {}),
            ...(acessExpiresOn !== undefined
              ? { acessExpiresOn: fromClinicalDate(acessExpiresOn) }
              : {}),
          },
          select: PRACTITIONER_INCLUDE.user.select,
        });
        return toView({ ...updated, user });
      });
    } catch (error) {
      if (isRecordNotFound(error)) return null;
      throw error;
    }
  }

  /** ST-010: the RESTRICT foreign keys have the final word. */
  async deletePractitioner(id: string): Promise<boolean> {
    try {
      await this.prisma.practitioner.delete({ where: { id } });
      return true;
    } catch (error) {
      if (isRecordNotFound(error)) return false;
      if (isForeignKeyRestriction(error)) throw new PractitionerInUseError();
      throw error;
    }
  }

  /**
   * ST-005. NO LOWER BOUND, on purpose: a registration that expired last week
   * is more urgent than one expiring next month, and leaving it out of the
   * warning list is how it stays unnoticed until somebody cannot sign. The
   * caller reports the days left, which goes negative for those.
   *
   * Inactive practitioners are excluded: warning about the habilitación of
   * somebody who no longer works here is noise that trains people to ignore
   * the list.
   */
  async listAcessExpiringThrough(
    through: ClinicalDate,
  ): Promise<readonly AcessExpiryRow[]> {
    const rows = await this.prisma.practitioner.findMany({
      where: {
        active: true,
        user: {
          acessRegistration: { not: null },
          acessExpiresOn: { not: null, lte: fromClinicalDate(through) ?? undefined }, // prettier-ignore
        },
      },
      select: {
        id: true,
        user: {
          select: {
            firstName: true,
            lastName: true,
            acessRegistration: true,
            acessExpiresOn: true,
          },
        },
      },
      orderBy: { user: { acessExpiresOn: 'asc' } },
    });

    return rows.map((row) => ({
      practitionerId: row.id,
      firstName: row.user.firstName,
      lastName: row.user.lastName,
      // Non-null by the `where`; the select cannot express that to the types.
      acessRegistration: row.user.acessRegistration ?? '',
      acessExpiresOn: toClinicalDate(row.user.acessExpiresOn) ?? ('' as ClinicalDate), // prettier-ignore
    }));
  }

  /** ST-008: primary first, so the agenda reads row zero. */
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

  async findSpecialtiesByIds(
    ids: readonly string[],
  ): Promise<readonly SpecialtyReference[]> {
    return this.prisma.specialty.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, active: true },
    });
  }

  /**
   * ST-008, replace-set in ONE transaction: what is not named disappears, what
   * is named is written fresh. Delete-then-insert rather than a diff — the set
   * is a handful of rows, and a diff would trade readability for nothing
   * measurable. The partial unique index arbitrates any concurrent writer that
   * slips in between.
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
   * ST-009. Only ACTIVE types of ACTIVE specialties: this listing feeds
   * selection, not administration of the catalogue.
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

  /** ST-009. Lets the service answer 404 for an unknown service type before writing an exception for it. */
  async serviceTypeExists(id: string): Promise<boolean> {
    const row = await this.prisma.serviceType.findUnique({
      where: { id },
      select: { id: true },
    });
    return row !== null;
  }

  /** ST-009. One statement; the composite key is the identity. */
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

  /** ST-007. */
  async listPractitionerSites(
    practitionerId: string,
  ): Promise<readonly PractitionerSiteView[]> {
    const rows = await this.prisma.practitionerSite.findMany({
      where: { practitionerId },
      select: { siteId: true, site: { select: { name: true, active: true } } },
      orderBy: { site: { name: 'asc' } },
    });

    return rows.map((row) => ({
      siteId: row.siteId,
      name: row.site.name,
      active: row.site.active,
    }));
  }

  /**
   * ST-007, replace-set. A site that disappears from the list takes the
   * practitioner's assignment with it and NOTHING ELSE: appointments already
   * booked there keep their own `site_id`, which is what stops an
   * administrative correction from erasing a day's agenda.
   */
  async replacePractitionerSites(
    practitionerId: string,
    siteIds: readonly string[],
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.practitionerSite.deleteMany({ where: { practitionerId } }),
      this.prisma.practitionerSite.createMany({
        data: siteIds.map((siteId) => ({ practitionerId, siteId })),
      }),
    ]);
  }

  /**
   * D-021, SP-022. The distinct slot atoms of the clinic's sites.
   *
   * `distinct` because the answer feeds a lowest common multiple, where a
   * repeated value changes nothing. A site without a parameter row contributes
   * nothing: `trg_site_parameter_defaults` writes one for every site (CF-062),
   * so the set of rows IS the set of sites.
   */
  async siteSlotAtoms(): Promise<readonly number[]> {
    const rows = await this.prisma.siteParameter.findMany({
      distinct: ['slotAtomMinutes'],
      select: { slotAtomMinutes: true },
    });
    return rows.map((row) => row.slotAtomMinutes);
  }
}

/**
 * Row to view. Cedula and ACESS come from the account, not the practitioner
 * row (ST-001, ST-002); only the primary specialty is selected, hence `[0]`.
 */
function toView(row: PractitionerRow): PractitionerView {
  const primary = row.specialties[0]?.specialty ?? null;
  return {
    id: row.id,
    userId: row.userId,
    firstName: row.user.firstName,
    lastName: row.user.lastName,
    email: row.user.email,
    cedula: row.user.cedula,
    acessRegistration: row.user.acessRegistration,
    acessExpiresOn: toClinicalDate(row.user.acessExpiresOn),
    mspCode: row.mspCode,
    emergencyContactPhone: row.emergencyContactPhone,
    schedulable: row.schedulable,
    active: row.active,
    primarySpecialty: primary,
    siteIds: row.sites.map((site) => site.siteId),
  };
}
