import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { exchangePurgeCutoffs } from '../domain/exchange-retention';
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
   * AS-015. The 45 days start at the first signature of the encounter's
   * notes, or at the attempt itself when it came after that signature (an
   * amendment), or at the attempt when there is no encounter. Whatever the
   * encounter, nothing outlives the maximum (D-241 §6). The cutoffs come from
   * the application's clock, never `now()`.
   */
  purgeExchanges(now: Date): Promise<number> {
    const { retention, maximum } = exchangePurgeCutoffs(now);
    return this.prisma.$executeRaw`
      DELETE FROM "ai_exchange" AS e
      USING "ai_run" AS r
      WHERE e."ai_run_id" = r."id"
        AND (
          r."started_at" <= ${maximum}
          OR (r."encounter_id" IS NULL AND r."started_at" <= ${retention})
          OR (GREATEST(
               (SELECT MIN(n."signed_at") FROM "clinical_note" AS n
                 WHERE n."encounter_id" = r."encounter_id"),
               r."started_at"
             ) <= ${retention}
             AND EXISTS (SELECT 1 FROM "clinical_note" AS n
                          WHERE n."encounter_id" = r."encounter_id"
                            AND n."signed_at" IS NOT NULL))
        )`;
  }
}
