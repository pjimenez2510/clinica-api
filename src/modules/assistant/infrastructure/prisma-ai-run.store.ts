import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { exchangePurgeCutoff } from '../domain/exchange-retention';
import type {
  AiExchangeRecord,
  AiRunRecord,
  AiRunStore,
} from '../application/ai-run.store';

/** AS-011, AS-014, AS-015, AS-017 over PostgreSQL. */
@Injectable()
export class PrismaAiRunStore implements AiRunStore {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    run: AiRunRecord,
    exchange: AiExchangeRecord | null,
  ): Promise<void> {
    await this.prisma.aiRun.create({
      data: {
        ...run,
        priceValidFrom: new Date(`${run.priceValidFrom}T00:00:00Z`),
        ...(exchange
          ? {
              exchange: {
                create: {
                  system: exchange.system,
                  prompt: exchange.prompt,
                  raw: exchange.raw,
                },
              },
            }
          : {}),
      },
    });
  }

  /**
   * AS-017. An attempt whose cost is unknown counts at its worst case: it may
   * have been billed, and nobody said how much.
   */
  async spentSince(from: Date): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ spent: string }[]>`
      SELECT COALESCE(SUM(COALESCE("cost_usd", "worst_case_usd")), 0)::text AS spent
      FROM "ai_run"
      WHERE "started_at" >= ${from}`;
    return Number(row?.spent ?? 0);
  }

  /**
   * AS-015. The first signed note of the encounter starts the 45 days; an
   * encounter with no signed note keeps its text until one is signed. With no
   * encounter, the attempt itself starts them. The cutoff comes from the
   * application's clock, never `now()`.
   */
  purgeExchanges(now: Date): Promise<number> {
    const cutoff = exchangePurgeCutoff(now);
    return this.prisma.$executeRaw`
      DELETE FROM "ai_exchange" AS e
      USING "ai_run" AS r
      WHERE e."ai_run_id" = r."id"
        AND (
          (r."encounter_id" IS NULL AND r."started_at" <= ${cutoff})
          OR (SELECT MIN(n."signed_at") FROM "clinical_note" AS n
               WHERE n."encounter_id" = r."encounter_id") <= ${cutoff}
        )`;
  }
}
