import { describe, expect, it } from 'vitest';

import { authorizationFits } from './patient-authorization';

const BOTH = { hasPhone: true, hasEmail: true };

describe('authorizationFits', () => {
  it('PD-070 reminders and marketing go by WhatsApp or email, the rest without channel', () => {
    expect(authorizationFits('REMINDERS', 'WHATSAPP', BOTH)).toBe(true);
    expect(authorizationFits('MARKETING', 'EMAIL', BOTH)).toBe(true);
    expect(authorizationFits('PHOTOS', null, BOTH)).toBe(true);
    expect(authorizationFits('RESEARCH', null, BOTH)).toBe(true);
    expect(authorizationFits('THIRD_PARTY_SHARING', null, BOTH)).toBe(true);

    expect(authorizationFits('REMINDERS', null, BOTH)).toBe(false);
    expect(authorizationFits('PHOTOS', 'EMAIL', BOTH)).toBe(false);
  });

  it('PD-070 the channel needs the datum it writes to', () => {
    const noPhone = { hasPhone: false, hasEmail: true };
    const noEmail = { hasPhone: true, hasEmail: false };
    expect(authorizationFits('REMINDERS', 'WHATSAPP', noPhone)).toBe(false);
    expect(authorizationFits('REMINDERS', 'EMAIL', noPhone)).toBe(true);
    expect(authorizationFits('MARKETING', 'EMAIL', noEmail)).toBe(false);
    // Without a channel, the chart's contact does not matter.
    expect(
      authorizationFits('PHOTOS', null, { hasPhone: false, hasEmail: false }),
    ).toBe(true);
  });
});
