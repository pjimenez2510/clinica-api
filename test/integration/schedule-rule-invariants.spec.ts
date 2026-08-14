import { describe, expect, it } from 'vitest';

import { useDatabase } from './setup/database';
import {
  createPractitioner,
  createScheduleRule,
  createSite,
} from './setup/fixtures';

/**
 * The invariants of `practitioner_schedule_rule`, enforced by the database.
 *
 * Found by adversarial review of E1 (P1-1): the table had no CHECK at all, and
 * in E1 its only entry path is SQL and seeds — no endpoint validates anything.
 * A row with an inverted interval or an impossible weekday reached the domain
 * and turned availability and booking into 500 for every date it covered.
 *
 * The domain now skips malformed rules defensively, but the invariant lives
 * HERE. These tests are the proof the constraints exist — a migration that
 * silently dropped them would fail this file, not an assumption.
 *
 * SINCE D-021 THE GRID IS NOT ONE OF THEM. It left this table for
 * `site_parameter.slot_atom_minutes`, so what guards it is
 * `site_parameter_slot_atom_minutes_range` — also asserted below, because the
 * invariant moved, it did not disappear.
 */
const db = useDatabase();

async function context() {
  const prisma = db();
  const site = await createSite(prisma);
  const practitioner = await createPractitioner(prisma);
  return {
    prisma,
    ids: { practitionerId: practitioner.id, siteId: site.id },
  };
}

describe('schedule rule invariants (migration 20260812174244)', () => {
  it('accepts a well-formed rule', async () => {
    const { prisma, ids } = await context();
    const rule = await createScheduleRule(prisma, ids, {
      weekday: 1,
      startTime: '08:00',
      endTime: '12:00',
    });
    expect(rule.id).toBeTruthy();
  });

  it('rejects a weekday outside ISO-8601 1..7', async () => {
    const { prisma, ids } = await context();
    await expect(
      createScheduleRule(prisma, ids, {
        weekday: 0,
        startTime: '08:00',
        endTime: '12:00',
      }),
    ).rejects.toThrow(/schedule_rule_weekday_iso/);
    await expect(
      createScheduleRule(prisma, ids, {
        weekday: 8,
        startTime: '08:00',
        endTime: '12:00',
      }),
    ).rejects.toThrow(/schedule_rule_weekday_iso/);
  });

  /**
   * D-021 removed `schedule_rule_slot_positive` and `schedule_rule_slot_fits`
   * along with the column they guarded. What replaced them is this: the grid
   * is one number per site, and the base guards THAT — a value the rule could
   * never state and now cannot contradict.
   */
  it('rejects a site slot atom that is not a usable increment', async () => {
    const { prisma, ids } = await context();

    await expect(
      prisma.siteParameter.update({
        where: { siteId: ids.siteId },
        data: { slotAtomMinutes: 0 },
      }),
    ).rejects.toThrow(/site_parameter_slot_atom_minutes_range/);

    // 7 is inside 5..60 and not a multiple of 5: the step is what keeps
    // `service_type_duration_range` a consequence of the atom rather than a
    // leftover that contradicts it.
    await expect(
      prisma.siteParameter.update({
        where: { siteId: ids.siteId },
        data: { slotAtomMinutes: 7 },
      }),
    ).rejects.toThrow(/site_parameter_slot_atom_minutes_range/);
  });

  it('starts every site on the ten-minute atom of D-021', async () => {
    const { prisma, ids } = await context();

    await expect(
      prisma.siteParameter.findUniqueOrThrow({
        where: { siteId: ids.siteId },
        select: { slotAtomMinutes: true },
      }),
    ).resolves.toEqual({ slotAtomMinutes: 10 });
  });

  it('rejects a rule that ends before it starts', async () => {
    const { prisma, ids } = await context();
    await expect(
      createScheduleRule(prisma, ids, {
        weekday: 1,
        startTime: '12:00',
        endTime: '08:00',
      }),
    ).rejects.toThrow(/schedule_rule_time_order/);
  });

  it("rejects '24:00' as an end time: the driver would invert it into 00:00", async () => {
    // PostgreSQL accepts time '24:00'; the JS driver hands it back as a Date
    // rolled into the next day whose UTC hour reads 0, silently turning
    // "until midnight" into "since midnight". The CHECK keeps the row out;
    // `WallClockTime.fromTimeColumn` throws if one arrives anyway.
    const { prisma, ids } = await context();
    await expect(
      prisma.$executeRaw`
        INSERT INTO practitioner_schedule_rule
          (practitioner_id, site_id, weekday, start_time, end_time, valid_from, updated_at)
        VALUES
          (${ids.practitionerId}::uuid, ${ids.siteId}::uuid, 1,
           TIME '18:00', TIME '24:00', DATE '2026-01-01', now())
      `,
    ).rejects.toThrow(/schedule_rule_time_order/);
  });
});
