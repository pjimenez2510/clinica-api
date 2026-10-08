import { describe, expect, it } from 'vitest';

import { addDays, clinicalDateOf } from '../../../shared/domain/clinic-time';
import { dailyAgendaQuerySchema } from './agenda.dto';

/** Today in Ecuador, from the clock: no date in this file is written by hand. */
const TODAY = clinicalDateOf(new Date());

const issuesOf = (query: Record<string, string>) => {
  const parsed = dailyAgendaQuerySchema.safeParse(query);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'));
};

describe('the agenda query', () => {
  it('AG-017 still takes one calendar date', () => {
    const parsed = dailyAgendaQuerySchema.parse({ date: TODAY });

    expect(parsed).toMatchObject({ date: TODAY });
  });

  it('AG-178 takes a range of calendar dates instead of one day', () => {
    const to = addDays(TODAY, 5);

    const parsed = dailyAgendaQuerySchema.parse({ from: TODAY, to });

    expect(parsed).toMatchObject({ from: TODAY, to });
    expect(parsed.date).toBeUndefined();
  });

  it('AG-178 admits 31 days and refuses the 32nd, on the field `to`', () => {
    expect(issuesOf({ from: TODAY, to: addDays(TODAY, 30) })).toEqual([]);
    expect(issuesOf({ from: TODAY, to: addDays(TODAY, 31) })).toEqual(['to']);
  });

  it('AG-178 refuses a range that ends before it starts', () => {
    expect(issuesOf({ from: TODAY, to: addDays(TODAY, -1) })).toEqual(['to']);
  });

  it('AG-178 refuses a day and a range at once, half a range, or nothing', () => {
    expect(
      issuesOf({ date: TODAY, from: TODAY, to: addDays(TODAY, 1) }),
    ).toEqual(['date']);
    expect(issuesOf({ from: TODAY })).toEqual(['to']);
    expect(issuesOf({ to: TODAY })).toEqual(['from']);
    expect(issuesOf({})).toEqual(['date']);
  });
});
