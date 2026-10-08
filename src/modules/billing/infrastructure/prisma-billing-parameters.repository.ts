import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';

import type {
  BillingParametersRepository,
  DiscountLimitView,
  LastChange,
  NewPaymentMethod,
  PaymentMethodUpdate,
  PaymentMethodView,
} from '../domain/billing-parameters.repository';
import type { PaymentMethod } from '../domain/invoice';

/** Who changed a row, joined by name: the screen answers «who» in words. */
const UPDATED_BY = {
  select: { id: true, firstName: true, lastName: true },
} as const;

type Author = { id: string; firstName: string; lastName: string } | null;

function lastChangeOf(at: Date, author: Author): LastChange | null {
  if (author === null) return null;
  return {
    at,
    byId: author.id,
    byName: `${author.firstName} ${author.lastName}`,
  };
}

const PAYMENT_METHOD_SELECT = {
  id: true,
  name: true,
  sriCode: true,
  active: true,
  displayOrder: true,
  updatedAt: true,
  updatedBy: UPDATED_BY,
} satisfies Prisma.PaymentMethodSelect;

type PaymentMethodRow = Prisma.PaymentMethodGetPayload<{
  select: typeof PAYMENT_METHOD_SELECT;
}>;

function toPaymentMethodView(row: PaymentMethodRow): PaymentMethodView {
  return {
    id: row.id,
    name: row.name,
    // `payment_method_sri_code_is_known` admits nothing else.
    sriCode: row.sriCode as PaymentMethod,
    active: row.active,
    displayOrder: row.displayOrder,
    lastChange: lastChangeOf(row.updatedAt, row.updatedBy),
  };
}

const ROLE_SELECT = {
  id: true,
  code: true,
  name: true,
  active: true,
  discountLimit: {
    select: {
      maxDiscountPercentage: true,
      updatedAt: true,
      updatedBy: UPDATED_BY,
    },
  },
} satisfies Prisma.RoleSelect;

type RoleRow = Prisma.RoleGetPayload<{ select: typeof ROLE_SELECT }>;

/** BI-141. No row is a ceiling of zero, never «no ceiling». */
function toDiscountLimitView(role: RoleRow): DiscountLimitView {
  const limit = role.discountLimit;
  return {
    roleId: role.id,
    roleCode: role.code,
    roleName: role.name,
    roleActive: role.active,
    maxDiscountPercentage: limit?.maxDiscountPercentage.toFixed(2) ?? '0.00',
    lastChange: limit ? lastChangeOf(limit.updatedAt, limit.updatedBy) : null,
  };
}

/**
 * B7 against PostgreSQL. The name's uniqueness and the closed list of SRI
 * codes are the database's (`payment_method_name_unique`,
 * `payment_method_sri_code_is_known`); this adapter only reads and writes.
 */
@Injectable()
export class PrismaBillingParametersRepository implements BillingParametersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listPaymentMethods(filter: {
    includeInactive: boolean;
  }): Promise<PaymentMethodView[]> {
    const rows = await this.prisma.paymentMethod.findMany({
      where: filter.includeInactive ? {} : { active: true },
      select: PAYMENT_METHOD_SELECT,
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toPaymentMethodView);
  }

  async findPaymentMethod(id: string): Promise<PaymentMethodView | null> {
    const row = await this.prisma.paymentMethod.findUnique({
      where: { id },
      select: PAYMENT_METHOD_SELECT,
    });
    return row ? toPaymentMethodView(row) : null;
  }

  async findPaymentMethodNamed(
    name: string,
  ): Promise<PaymentMethodView | null> {
    const row = await this.prisma.paymentMethod.findFirst({
      where: { name: { equals: name.trim(), mode: 'insensitive' } },
      select: PAYMENT_METHOD_SELECT,
    });
    return row ? toPaymentMethodView(row) : null;
  }

  countActivePaymentMethods(): Promise<number> {
    return this.prisma.paymentMethod.count({ where: { active: true } });
  }

  /** Appended after the last one, under no lock: two at once share a place. */
  async createPaymentMethod(
    method: NewPaymentMethod,
    byId: string,
  ): Promise<PaymentMethodView> {
    const last = await this.prisma.paymentMethod.aggregate({
      _max: { displayOrder: true },
    });
    const row = await this.prisma.paymentMethod.create({
      data: {
        name: method.name,
        sriCode: method.sriCode,
        displayOrder: (last._max.displayOrder ?? 0) + 1,
        updatedById: byId,
      },
      select: PAYMENT_METHOD_SELECT,
    });
    return toPaymentMethodView(row);
  }

  async updatePaymentMethod(
    id: string,
    update: PaymentMethodUpdate,
    byId: string,
  ): Promise<PaymentMethodView> {
    const row = await this.prisma.paymentMethod.update({
      where: { id },
      data: {
        name: update.name,
        sriCode: update.sriCode,
        active: update.active,
        updatedById: byId,
      },
      select: PAYMENT_METHOD_SELECT,
    });
    return toPaymentMethodView(row);
  }

  /** Active roles first, then by name: the ones in use are what is looked for. */
  async listDiscountLimits(): Promise<DiscountLimitView[]> {
    const roles = await this.prisma.role.findMany({
      select: ROLE_SELECT,
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
    return roles.map(toDiscountLimitView);
  }

  async findDiscountLimit(roleId: string): Promise<DiscountLimitView | null> {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: ROLE_SELECT,
    });
    return role ? toDiscountLimitView(role) : null;
  }

  /**
   * BI-142. Writes `role_discount_limit` and nothing else. A discount already
   * granted lives frozen in its `charge_item` and no limit is read from it.
   */
  async setDiscountLimit(
    roleId: string,
    maxDiscountPercentage: string,
    byId: string,
  ): Promise<DiscountLimitView> {
    const percentage = new Prisma.Decimal(maxDiscountPercentage);
    await this.prisma.roleDiscountLimit.upsert({
      where: { roleId },
      create: {
        roleId,
        maxDiscountPercentage: percentage,
        updatedById: byId,
      },
      update: { maxDiscountPercentage: percentage, updatedById: byId },
    });
    const role = await this.prisma.role.findUniqueOrThrow({
      where: { id: roleId },
      select: ROLE_SELECT,
    });
    return toDiscountLimitView(role);
  }
}
