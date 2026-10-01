import type { SriEnvironment } from './access-key';
import type { AuthorisationAnswer, ReceptionAnswer } from './voucher-lifecycle';

/**
 * SRI-042, SRI-050. The two offline web services, as the domain sees them.
 *
 * Every failure to obtain an answer —no connection, a timeout, an HTTP status
 * other than 200, a body that is not the expected envelope— comes back as
 * `TRANSPORT_FAILURE`, never as a rejection and never as an exception: the
 * lifecycle decides what a missing answer means, and it means «later, with
 * the same key».
 */
export interface SriWebService {
  /** SRI-054. False when the installation has not declared both URLs. */
  isConfigured(): boolean;
  receive(signedXml: string): Promise<ReceptionAnswer>;
  authorise(accessKey: string): Promise<AuthorisationAnswer>;
}
export const SRI_WEB_SERVICE = Symbol('SriWebService');

/** The installation's SRI settings the application reads (SRI-016, SRI-017). */
export interface SriSettings {
  environment: SriEnvironment;
  /** Anexo 26, or `null` while D-091 is open. */
  softwareProviderRuc: string | null;
}
export const SRI_SETTINGS = Symbol('SriSettings');

/** The time, injected: no rule of this module reads the wall clock itself. */
export type SriClock = () => Date;
export const SRI_CLOCK = Symbol('SriClock');
