/**
 * AS-160, AS-161 (A3, D-254). The sites where the assistant is switched on.
 *
 * The switch is a site parameter (`configuration`'s); the assistant reads it
 * through here because no module imports another. Read on every request: a
 * site switched off answers 404 from the next one, without a restart.
 */
export const ASSISTANT_SITE_SWITCH = Symbol('ASSISTANT_SITE_SWITCH');

export interface AssistantSiteSwitch {
  /** The ids of the sites with `assistant_enabled` on. */
  enabledSites(): Promise<string[]>;
}
