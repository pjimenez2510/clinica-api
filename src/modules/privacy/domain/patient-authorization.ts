/**
 * PD-068 (D-221 §3). What a patient may authorize that is not attending them.
 * Attending needs no authorization (LOPDP art. 31.1): these never condition
 * registering, booking or attending.
 */
export const AUTHORIZATION_PURPOSES = [
  'REMINDERS',
  'MARKETING',
  'PHOTOS',
  'RESEARCH',
  'THIRD_PARTY_SHARING',
  // AS-164 (A3, D-254). Recording the consultation for the assistant: no
  // channel, and the listening asks it (AS-165).
  'ASSISTANT_RECORDING',
] as const;
export type AuthorizationPurpose = (typeof AUTHORIZATION_PURPOSES)[number];

export const AUTHORIZATION_CHANNELS = ['WHATSAPP', 'EMAIL'] as const;
export type AuthorizationChannel = (typeof AUTHORIZATION_CHANNELS)[number];

/** PD-070. What the chart has to write to: whether it has a phone, an email. */
export interface ChartContact {
  hasPhone: boolean;
  hasEmail: boolean;
}

/** PD-068. The purposes that go by a channel: they are written to somebody. */
const BY_CHANNEL: ReadonlySet<AuthorizationPurpose> = new Set([
  'REMINDERS',
  'MARKETING',
]);

/**
 * PD-070. Whether this purpose, this channel and this chart go together:
 * reminders and marketing need a channel and the others none
 * (`patient_authorization_channel_matches_purpose` says the same in the
 * base), and the channel needs the datum it writes to — WhatsApp the phone,
 * email the email. It is authorized next to that datum.
 */
export function authorizationFits(
  purpose: AuthorizationPurpose,
  channel: AuthorizationChannel | null,
  contact: ChartContact,
): boolean {
  if (BY_CHANNEL.has(purpose) !== (channel !== null)) return false;
  if (channel === 'WHATSAPP') return contact.hasPhone;
  if (channel === 'EMAIL') return contact.hasEmail;
  return true;
}
