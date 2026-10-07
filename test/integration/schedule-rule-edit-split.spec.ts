import { describe, expect, it } from 'vitest';

import {
  addDays,
  clinicalDateOf,
  type ClinicalDate,
} from '../../src/shared/domain/clinic-time';
import { PrismaScheduleRuleRepository } from '../../src/modules/staff/infrastructure/prisma-schedule-rule.repository';
import type { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service';

import { useDatabase } from './setup/database';
import {
  createPractitioner,
  createScheduleRule,
  createSite,
} from './setup/fixtures';

/**
 * ST-050 against PostgreSQL: editing a rule that already ruled past days
 * closes it YESTERDAY and opens the new one TODAY in one transaction, and the
 * exclusion constraint (ST-042) sees no overlap between the two. The control:
 * a split that WOULD overlap is refused and leaves the old rule untouched —
 * the transaction does not keep half of it.
 */
const db = useDatabase();

const asDate = (date: ClinicalDate) => new Date(`${date}T00:00:00Z`);

async function aRuleThatAlreadyRuled() {
  const prisma = db();
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  const today = clinicalDateOf(new Date());
  const rule = await createScheduleRule(
    prisma,
    { practitionerId: practitioner.id, siteId: site.id },
    {
      weekday: 1,
      startTime: '08:00',
      endTime: '12:00',
      validFrom: asDate(addDays(today, -60)),
    },
  );
  const repository = new PrismaScheduleRuleRepository(
    prisma as unknown as PrismaService,
  );
  return { prisma, repository, rule, today, practitioner, site };
}

describe('regla de horario: editar sin reescribir los días pasados (ST-050)', () => {
  it('ST-050 la anterior queda cerrada ayer y la nueva rige desde hoy, sin solaparse', async () => {
    const { prisma, repository, rule, today, practitioner, site } =
      await aRuleThatAlreadyRuled();

    const opened = await repository.split(rule.id, addDays(today, -1), {
      practitionerId: practitioner.id,
      siteId: site.id,
      weekday: 1,
      startTime: '08:00',
      endTime: '13:00',
      validFrom: today,
      validTo: null,
    });

    expect(opened).toMatchObject({ validFrom: today, endTime: '13:00' });
    const old = await prisma.practitionerScheduleRule.findUniqueOrThrow({
      where: { id: rule.id },
    });
    expect(old.validTo).toEqual(asDate(addDays(today, -1)));
    expect(old.endTime).toEqual(rule.endTime);
  });

  it('ST-050 si la nueva se solapara con la anterior, la base lo rechaza y la anterior no cambia', async () => {
    const { prisma, repository, rule, today, practitioner, site } =
      await aRuleThatAlreadyRuled();

    // Closing TODAY (inclusive) and opening TODAY overlaps on one day.
    await expect(
      repository.split(rule.id, today, {
        practitionerId: practitioner.id,
        siteId: site.id,
        weekday: 1,
        startTime: '08:00',
        endTime: '13:00',
        validFrom: today,
        validTo: null,
      }),
    ).rejects.toThrow(/schedule_rule|overlap/i);

    const old = await prisma.practitionerScheduleRule.findUniqueOrThrow({
      where: { id: rule.id },
    });
    expect(old.validTo).toBeNull();
    expect(
      await prisma.practitionerScheduleRule.count({
        where: { practitionerId: practitioner.id },
      }),
    ).toBe(1);
  });
});
