import { describe, expect, it } from 'vitest';

import { arrivedPastThreshold } from './late-arrival-rule';

/** AG-120. The rule both paths into care apply; instants from today's clock. */
const START = new Date();
const after = (minutes: number) => new Date(START.getTime() + minutes * 60_000);
const base = {
  startsAt: START,
  emergencyFlagged: false,
  walkIn: false,
  graceMinutes: 15,
};

describe('AG-120 la regla de «llegó fuera de plazo»', () => {
  it('AG-120 pasado el margen, estrictamente, es fuera de plazo', () => {
    expect(arrivedPastThreshold({ ...base, checkedInAt: after(16) })).toBe(
      true,
    );
    expect(arrivedPastThreshold({ ...base, checkedInAt: after(15) })).toBe(
      false,
    );
  });

  it('AG-120 ni la emergencia, ni quien vino sin cita, ni quien no llegó', () => {
    expect(arrivedPastThreshold({ ...base, checkedInAt: after(60), emergencyFlagged: true })).toBe(false); // prettier-ignore
    expect(arrivedPastThreshold({ ...base, checkedInAt: after(60), walkIn: true })).toBe(false); // prettier-ignore
    expect(arrivedPastThreshold({ ...base, checkedInAt: null })).toBe(false);
  });
});
