import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  clinicalDateOf,
  type ClinicalDate,
} from '../../../shared/domain/clinic-time';
import {
  createCatalogueEntry,
  selfPayPricesOn,
} from '../../../shared/infrastructure/prisma/catalogue-entry';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import {
  consultationServiceCode,
  consultationServiceName,
} from '../domain/consultation-service';
import {
  ConsultationBillingUnavailableError,
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

/**
 * The selections are the views: every column the domain shape declares and
 * nothing else.
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
  // SP-031. The first service, the one born with the type.
  billableServices: {
    orderBy: { position: 'asc' },
    take: 1,
    select: { billableServiceId: true },
  },
} satisfies Prisma.ServiceTypeSelect;

type ServiceTypeRow = Prisma.ServiceTypeGetPayload<{
  select: typeof SERVICE_TYPE_SELECT;
}>;

/** BI-171. Codes tried before giving the collision to the unique index. */
const MAX_CODE_ATTEMPTS = 50;

/**
 * Prisma adapter for `SpecialtiesRepository`; see the header for the refusals
 * translated here.
 */
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

  /** `null` for an unknown id; the service decides the refusal. */
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

  /**
   * SP-006 answered by the unique indexes on code and name. `null` when the row
   * is gone.
   */
  async updateSpecialty(
    id: string,
    patch: { name?: string; active?: boolean },
  ): Promise<SpecialtyView | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.specialty.update({
          where: { id },
          data: patch,
          select: SPECIALTY_SELECT,
        });
        // SP-030. «Especialidad · tipo» follows the specialty's new name.
        if (patch.name !== undefined) {
          const types = await tx.serviceType.findMany({
            where: { specialtyId: id },
            select: SERVICE_TYPE_SELECT,
          });
          for (const type of types) {
            await renameOwnService(tx, type, updated.name);
          }
        }
        return updated;
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

  /**
   * Deactivated types travel only when asked for. Ordered by name so the screen
   * is stable between requests.
   */
  async listServiceTypes(
    specialtyId: string,
    includeInactive: boolean,
  ): Promise<readonly ServiceTypeView[]> {
    const rows = await this.prisma.serviceType.findMany({
      where: { specialtyId, ...(includeInactive ? {} : { active: true }) },
      select: SERVICE_TYPE_SELECT,
      orderBy: { name: 'asc' },
    });
    return withPrices(this.prisma, rows);
  }

  async findServiceType(id: string): Promise<ServiceTypeView | null> {
    const row = await this.prisma.serviceType.findUnique({
      where: { id },
      select: SERVICE_TYPE_SELECT,
    });
    return row === null ? null : (await withPrices(this.prisma, [row]))[0]!;
  }

  /**
   * SP-020, SP-030; SP-026 answered by `service_type_name_unique_per_specialty`.
   * The type, its service, its link and its first price in ONE transaction:
   * a type that caja could not propose is not created at all.
   */
  async createServiceType(input: {
    specialtyId: string;
    name: string;
    durationMinutes: number;
    price: string | null;
    today: ClinicalDate;
  }): Promise<ServiceTypeView> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const type = await tx.serviceType.create({
          data: {
            specialtyId: input.specialtyId,
            name: input.name,
            durationMinutes: input.durationMinutes,
          },
          select: { id: true, specialty: { select: { code: true, name: true } } }, // prettier-ignore
        });
        await bornWithService(tx, type.id, type.specialty, input.name, input.price, input.today); // prettier-ignore
        return tx.serviceType.findUniqueOrThrow({
          where: { id: type.id },
          select: SERVICE_TYPE_SELECT,
        });
      });
      return (await withPrices(this.prisma, [row]))[0]!;
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
    today: ClinicalDate,
  ): Promise<ServiceTypeView | null> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.serviceType.update({
          where: { id },
          data: patch,
          select: { ...SERVICE_TYPE_SELECT, specialty: { select: { code: true, name: true } } }, // prettier-ignore
        });
        if (updated.billableServices.length === 0) {
          // SP-030. A type of before D-179: it gets its service now, so caja
          // can propose it and its price can be set.
          await bornWithService(tx, updated.id, updated.specialty, updated.name, null, today); // prettier-ignore
          return tx.serviceType.findUniqueOrThrow({
            where: { id },
            select: SERVICE_TYPE_SELECT,
          });
        }
        // SP-030. Its own service is named after it.
        if (patch.name !== undefined) {
          await renameOwnService(tx, updated, updated.specialty.name);
        }
        return updated;
      });
      return (await withPrices(this.prisma, [row]))[0]!;
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
      await this.prisma.$transaction(async (tx) => {
        const links = await tx.serviceTypeBillableService.findMany({
          where: { serviceTypeId: id },
          select: { billableServiceId: true },
        });
        // The links CASCADE with the type.
        await tx.serviceType.delete({ where: { id } });
        // SP-030. What no other type charges any more stops being offered.
        await tx.billableService.updateMany({
          where: {
            id: { in: links.map((link) => link.billableServiceId) },
            serviceTypes: { none: {} },
          },
          data: { active: false },
        });
      });
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

/** Row to view, with the self-pay price in force today of its first service. */
async function withPrices(
  client: Prisma.TransactionClient,
  rows: readonly ServiceTypeRow[],
  now: Date = new Date(),
): Promise<ServiceTypeView[]> {
  const serviceIds = rows.flatMap((row) =>
    row.billableServices.map((link) => link.billableServiceId),
  );
  const prices = await selfPayPricesOn(client, serviceIds, clinicalDateOf(now));
  return rows.map(({ billableServices, ...type }) => {
    const billableServiceId = billableServices[0]?.billableServiceId ?? null;
    return {
      id: type.id,
      specialtyId: type.specialtyId,
      name: type.name,
      durationMinutes: type.durationMinutes,
      active: type.active,
      billableServiceId,
      price: billableServiceId === null ? null : (prices.get(billableServiceId) ?? null), // prettier-ignore
    };
  });
}

/**
 * SP-030. Where a consultation service is born: the first active category of
 * class CONSULTATION by name, and the health rate (SRI code `0`) in force on
 * `today`. A DEFAULT, never a fiscal classification: the rate stays unreviewed
 * (D-A-006). `null` when either is missing.
 */
async function consultationDefaults(
  tx: Prisma.TransactionClient,
  today: ClinicalDate,
): Promise<{ categoryId: string; taxRateId: string } | null> {
  const day = new Date(`${today}T00:00:00Z`);
  const [category, rate] = await Promise.all([
    tx.billableServiceCategory.findFirst({
      where: { kind: 'CONSULTATION', active: true },
      orderBy: { name: 'asc' },
      select: { id: true },
    }),
    tx.taxRate.findFirst({
      where: {
        sriCode: '0',
        validFrom: { lte: day },
        OR: [{ validTo: null }, { validTo: { gt: day } }],
      },
      orderBy: { validFrom: 'desc' },
      select: { id: true },
    }),
  ]);
  return category && rate ? { categoryId: category.id, taxRateId: rate.id } : null; // prettier-ignore
}

/** SP-030. The type's own service, at position 0, with its first price. */
async function bornWithService(
  tx: Prisma.TransactionClient,
  serviceTypeId: string,
  specialty: { code: string; name: string },
  typeName: string,
  price: string | null,
  today: ClinicalDate,
): Promise<void> {
  const defaults = await consultationDefaults(tx, today);
  if (defaults === null) throw new ConsultationBillingUnavailableError();
  const billableServiceId = await createCatalogueEntry(tx, {
    code: await freeServiceCode(tx, specialty.code, typeName),
    name: consultationServiceName(specialty.name, typeName),
    categoryId: defaults.categoryId,
    taxRateId: defaults.taxRateId,
    tariffCode: null,
    selfPay: price === null ? null : { amount: price, validFrom: today },
  });
  await tx.serviceTypeBillableService.create({
    data: { serviceTypeId, billableServiceId, position: 0 },
  });
}

/** SP-030. The first free candidate of `consultationServiceCode`. */
async function freeServiceCode(
  tx: Prisma.TransactionClient,
  specialtyCode: string,
  typeName: string,
): Promise<string> {
  const candidates = Array.from({ length: MAX_CODE_ATTEMPTS }, (_, index) =>
    consultationServiceCode(specialtyCode, typeName, index + 1),
  );
  const taken = new Set(
    (
      await tx.billableService.findMany({
        where: { code: { in: candidates } },
        select: { code: true },
      })
    ).map((row) => row.code),
  );
  // All taken is fifty types of one name: the unique index answers it.
  return candidates.find((code) => !taken.has(code)) ?? candidates[0]!;
}

/** SP-030, SP-031. The type's FIRST service follows «especialidad · tipo». */
async function renameOwnService(
  tx: Prisma.TransactionClient,
  type: Pick<ServiceTypeRow, 'name' | 'billableServices'>,
  specialtyName: string,
): Promise<void> {
  const own = type.billableServices[0];
  if (!own) return;
  await tx.billableService.update({
    where: { id: own.billableServiceId },
    data: { name: consultationServiceName(specialtyName, type.name) },
  });
}
