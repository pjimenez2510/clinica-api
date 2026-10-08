import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { selfPayPriceListId } from '../../../shared/infrastructure/prisma/catalogue-entry';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';

import { Money, Percentage } from '../domain/money';
import { toClinicalDate } from '../domain/price-list';
import {
  type TariffCandidate,
  type TariffLine,
  sortTariffLines,
} from '../domain/tariff-publication';
import type {
  NewTariffPublication,
  TariffPublicationRepository,
  TariffPublicationSummary,
  TariffPublicationView,
} from '../domain/tariff-publication.repository';
import { asDateColumn } from './prisma-billing-catalogue.repository';

/**
 * BI-110 to BI-115, in PostgreSQL.
 *
 * ⚠️ THE ONLY READ OF `price` HERE IS `findSelfPayTariff`, WHICH ONLY THE
 * AUTHENTICATED ROUTES USE (publishing and the out-of-date check). The public
 * route goes through `findLatestPublication`, which reads the copied rows of
 * `tariff_publication_item` and nothing else (BI-112). And the list is never
 * an argument: it is the clinic's self-pay list, found the same way an
 * account finds its default (`selfPayPriceListId`).
 */
@Injectable()
export class PrismaTariffPublicationRepository implements TariffPublicationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findSelfPayTariff(): Promise<{
    priceListId: string;
    candidates: TariffCandidate[];
  } | null> {
    const priceListId = await selfPayPriceListId(this.prisma);
    if (priceListId === null) return null;

    const services = await this.prisma.billableService.findMany({
      where: { prices: { some: { priceListId } } },
      select: {
        id: true,
        code: true,
        name: true,
        active: true,
        category: { select: { name: true } },
        taxRate: { select: { percentage: true } },
        prices: {
          where: { priceListId },
          select: { amount: true, validFrom: true, validTo: true },
        },
      },
    });

    return {
      priceListId,
      candidates: services.map((service) => ({
        billableServiceId: service.id,
        code: service.code,
        name: service.name,
        categoryName: service.category.name,
        active: service.active,
        taxPercentage: percentageOf(service.taxRate.percentage),
        prices: service.prices.map((price) => ({
          amount: Money.parse(price.amount),
          validFrom: toClinicalDate(price.validFrom),
          validTo:
            price.validTo === null ? null : toClinicalDate(price.validTo),
        })),
      })),
    };
  }

  /**
   * Under the list's row lock, so two administrators publishing at once get
   * consecutive versions instead of one `tariff_publication_version_unique`
   * refusal. The establishment's name is copied like the rest.
   */
  async publish(command: NewTariffPublication): Promise<TariffPublicationView> {
    const id = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT 1 FROM "price_list" WHERE "id" = ${command.priceListId}::uuid
           FOR UPDATE`;
      const last = await tx.tariffPublication.aggregate({
        _max: { version: true },
      });
      const establishment = await tx.establishment.findFirst({
        orderBy: { createdAt: 'asc' },
        select: { legalName: true, tradeName: true },
      });

      const created = await tx.tariffPublication.create({
        data: {
          version: (last._max.version ?? 0) + 1,
          effectiveFrom: asDateColumn(command.effectiveFrom),
          publishedAt: command.publishedAt,
          publishedById: command.publishedById,
          priceListId: command.priceListId,
          establishmentName:
            establishment === null
              ? null
              : (establishment.tradeName ?? establishment.legalName),
        },
        select: { id: true },
      });
      await tx.tariffPublicationItem.createMany({
        data: command.lines.map((line) => ({
          publicationId: created.id,
          billableServiceId: line.billableServiceId,
          serviceCode: line.code,
          serviceName: line.name,
          categoryName: line.categoryName,
          // Strings, never numbers, bound straight to `numeric` (BI-001).
          amount: line.amount.toString(),
          taxPercentage: line.taxPercentage?.toString() ?? null,
        })),
      });
      return created.id;
    });

    const published = await this.findPublication(id);
    if (published === null) {
      throw new Error('The publication just written cannot be read back');
    }
    return published;
  }

  async listPublications(): Promise<TariffPublicationSummary[]> {
    const rows = await this.prisma.tariffPublication.findMany({
      orderBy: { version: 'desc' },
      select: SUMMARY_SELECT,
    });
    return rows.map(toSummary);
  }

  async findPublication(
    publicationId: string,
  ): Promise<TariffPublicationView | null> {
    return this.findOne({ id: publicationId });
  }

  async findLatestPublication(): Promise<TariffPublicationView | null> {
    const latest = await this.prisma.tariffPublication.findFirst({
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    return latest === null ? null : this.findOne({ id: latest.id });
  }

  private async findOne(
    where: Prisma.TariffPublicationWhereUniqueInput,
  ): Promise<TariffPublicationView | null> {
    const row = await this.prisma.tariffPublication.findUnique({
      where,
      select: {
        ...SUMMARY_SELECT,
        items: {
          select: {
            billableServiceId: true,
            serviceCode: true,
            serviceName: true,
            categoryName: true,
            amount: true,
            taxPercentage: true,
          },
        },
      },
    });
    if (row === null) return null;

    const lines: TariffLine[] = row.items.map((item) => ({
      billableServiceId: item.billableServiceId,
      code: item.serviceCode,
      name: item.serviceName,
      categoryName: item.categoryName,
      amount: Money.parse(item.amount),
      taxPercentage: percentageOf(item.taxPercentage),
    }));
    // By category and name, as the sheet is read (BI-114): the rows come
    // back in no particular order.
    return { ...toSummary(row), lines: sortTariffLines(lines) };
  }
}

const SUMMARY_SELECT = {
  id: true,
  version: true,
  effectiveFrom: true,
  publishedAt: true,
  establishmentName: true,
  publishedBy: { select: { id: true, firstName: true, lastName: true } },
  _count: { select: { items: true } },
} satisfies Prisma.TariffPublicationSelect;

type SummaryRow = Prisma.TariffPublicationGetPayload<{
  select: typeof SUMMARY_SELECT;
}>;

function toSummary(row: SummaryRow): TariffPublicationSummary {
  return {
    id: row.id,
    version: row.version,
    effectiveFrom: toClinicalDate(row.effectiveFrom),
    publishedAt: row.publishedAt,
    publishedBy: {
      id: row.publishedBy.id,
      name: `${row.publishedBy.firstName} ${row.publishedBy.lastName}`,
    },
    establishmentName: row.establishmentName,
    lineCount: row._count.items,
  };
}

/** A null percentage stays null: «no objeto» and «exento» are not 0 %. */
function percentageOf(value: Prisma.Decimal | null): Percentage | null {
  return value === null ? null : Percentage.parse(value);
}
