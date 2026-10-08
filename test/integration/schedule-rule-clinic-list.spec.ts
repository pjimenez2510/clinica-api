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
 * ST-053 against PostgreSQL: the clinic's schedule, filtered by site, weekday
 * and practitioner, one page at a time, with the closed rules left out unless
 * asked for. Each test lists its own sites, so rows other tests leave behind
 * never count.
 */
const db = useDatabase();

const asDate = (date: ClinicalDate) => new Date(`${date}T00:00:00Z`);

async function aClinic() {
  const prisma = db();
  const north = await createSite(prisma, 'Sede Norte');
  const south = await createSite(prisma, 'Sede Sur');
  const ana = await createPractitioner(prisma);
  const luis = await createPractitioner(prisma);
  await prisma.user.update({
    where: { id: luis.userId },
    data: { firstName: 'Luis', lastName: 'Andrade' },
  });
  const today = clinicalDateOf(new Date());
  const rule = (
    practitionerId: string,
    siteId: string,
    weekday: number,
    startTime: string,
    extra: { validTo?: Date | null; active?: boolean } = {},
  ) =>
    createScheduleRule(
      prisma,
      { practitionerId, siteId },
      {
        weekday,
        startTime,
        endTime: `${String(Number(startTime.slice(0, 2)) + 2).padStart(2, '0')}:00`,
        ...extra,
      },
    );
  await rule(ana.id, north.id, 1, '08:00');
  await rule(luis.id, north.id, 1, '08:00');
  await rule(ana.id, north.id, 2, '14:00');
  await rule(ana.id, south.id, 1, '14:00');
  // Closed two ways: ended yesterday, and deactivated.
  await rule(luis.id, north.id, 3, '08:00', {
    validTo: asDate(addDays(today, -1)),
  });
  await rule(luis.id, south.id, 4, '08:00', { active: false });
  // Ends today: still in force.
  await rule(luis.id, south.id, 5, '08:00', { validTo: asDate(today) });
  return { prisma, north, south, ana, luis, today };
}

const repositoryOf = (prisma: ReturnType<typeof db>) =>
  new PrismaScheduleRuleRepository(prisma as unknown as PrismaService);

describe('ST-053 los horarios de toda la clínica', () => {
  it('ST-053 filtra por sede, día y profesional, con el nombre del profesional y de la sede, por día, hora y apellido', async () => {
    const { prisma, north, south, ana, luis, today } = await aClinic();
    const rules = repositoryOf(prisma);
    const page = { page: 1, pageSize: 20 };

    const monday = await rules.listClinic(
      { siteIds: [north.id, south.id], weekday: 1, includeClosed: false },
      page,
      today,
    );
    expect(
      monday.items.map((each) => [
        each.practitionerName,
        each.siteName,
        each.startTime,
      ]),
    ).toEqual([
      ['Andrade, Luis', 'Sede Norte', '08:00'],
      ['Villacís, Ana', 'Sede Norte', '08:00'],
      ['Villacís, Ana', 'Sede Sur', '14:00'],
    ]);
    expect(monday.total).toBe(3);

    const anaInNorth = await rules.listClinic(
      { siteIds: [north.id], practitionerId: ana.id, includeClosed: false },
      page,
      today,
    );
    expect(anaInNorth.items.map((each) => each.weekday)).toEqual([1, 2]);

    // Control: Luis has rules in both sites, open and closed.
    const luisEverywhere = await rules.listClinic(
      {
        siteIds: [north.id, south.id],
        practitionerId: luis.id,
        includeClosed: false,
      },
      page,
      today,
    );
    expect(luisEverywhere.items.map((each) => each.weekday)).toEqual([1, 5]);
  });

  it('ST-053 deja fuera las cerradas —desactivadas o con fin anterior a hoy— salvo que se pidan', async () => {
    const { prisma, north, south, luis, today } = await aClinic();
    const rules = repositoryOf(prisma);
    const filter = { siteIds: [north.id, south.id], practitionerId: luis.id };

    const open = await rules.listClinic(
      { ...filter, includeClosed: false },
      { page: 1, pageSize: 20 },
      today,
    );
    const all = await rules.listClinic(
      { ...filter, includeClosed: true },
      { page: 1, pageSize: 20 },
      today,
    );

    expect(open.items.map((each) => each.weekday)).toEqual([1, 5]);
    expect(all.items.map((each) => each.weekday)).toEqual([1, 3, 4, 5]);
    expect(all.total).toBe(4);
  });

  it('ST-053 pagina en la base y devuelve el total de todas las páginas', async () => {
    const { prisma, north, south, today } = await aClinic();
    const rules = repositoryOf(prisma);
    const filter = { siteIds: [north.id, south.id], includeClosed: true };

    const first = await rules.listClinic(
      filter,
      { page: 1, pageSize: 4 },
      today,
    );
    const second = await rules.listClinic(
      filter,
      { page: 2, pageSize: 4 },
      today,
    );

    expect(first.items).toHaveLength(4);
    expect(second.items).toHaveLength(3);
    expect(first.total).toBe(7);
    expect(second.total).toBe(7);
    const ids = [...first.items, ...second.items].map((each) => each.id);
    expect(new Set(ids).size).toBe(7);
  });
});
