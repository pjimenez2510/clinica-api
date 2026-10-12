import { Injectable } from '@nestjs/common';

import type {
  OrderableCategory,
  OrderableExam,
  OrderingContextReader,
} from '../../clinical/ordering-context.port';
import { PrismaService } from '../prisma/prisma.service';

/** AS-104. The kinds the assistant offers, and the order each goes on. */
const CATEGORY_OF: Readonly<Record<string, OrderableCategory>> = {
  LAB_EXAM: 'LABORATORY',
  IMAGING: 'IMAGING',
};

/** AS-104, AS-106, AS-109 over PostgreSQL. Reads; writes nothing. */
@Injectable()
export class PrismaOrderingContextReader implements OrderingContextReader {
  constructor(private readonly prisma: PrismaService) {}

  async orderableExams(): Promise<OrderableExam[]> {
    const rows = await this.prisma.service.findMany({
      where: {
        active: true,
        kind: { in: Object.keys(CATEGORY_OF) },
        exam: { isNot: null },
      },
      select: { id: true, code: true, name: true, kind: true },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    });
    return rows.map((row) => ({
      serviceId: row.id,
      code: row.code,
      name: row.name,
      category: CATEGORY_OF[row.kind]!,
    }));
  }

  async orderedCodes(encounterId: string): Promise<string[]> {
    const rows = await this.prisma.serviceOrderItem.findMany({
      where: {
        status: { not: 'CANCELLED' },
        serviceOrder: { encounterId, status: { not: 'DISCARDED' } },
      },
      select: { testCode: true },
    });
    return [...new Set(rows.map((row) => row.testCode))];
  }

  async orderCodes(
    encounterId: string,
    serviceOrderId: string,
  ): Promise<string[] | null> {
    const order = await this.prisma.serviceOrder.findFirst({
      where: { id: serviceOrderId, encounterId, status: { not: 'DISCARDED' } },
      select: {
        items: {
          where: { status: { not: 'CANCELLED' } },
          select: { testCode: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return order ? order.items.map((item) => item.testCode) : null;
  }
}
