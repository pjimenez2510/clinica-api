import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from './env.schema';

/**
 * AS-026. Whether `ASSISTANT_ENABLED` is on, read once at boot.
 *
 * In `shared/` because two modules ask it: `assistant`, whose routes answer
 * 404 without it, and `configuration`, whose site parameters only offer the
 * per-site switch when the installation has the assistant at all (AS-160).
 */
export const ASSISTANT_ENABLED = Symbol('ASSISTANT_ENABLED');

export const assistantEnabledProvider: Provider = {
  provide: ASSISTANT_ENABLED,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): boolean =>
    config.get('ASSISTANT_ENABLED', { infer: true }) === true,
};
