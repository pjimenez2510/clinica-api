import {
  Inject,
  Injectable,
  NotFoundException,
  type NestMiddleware,
} from '@nestjs/common';

import { ASSISTANT_ENABLED } from './assistant-diagnosis.controller';

/**
 * AS-026. With `ASSISTANT_ENABLED` off, the assistant's routes answer the 404
 * of a route that does not exist — BEFORE the session, the permission and the
 * pipes, which run after middleware. A guard would come too late: the global
 * ones answer 401, 403 or 400 first, and any of those says the route is there.
 */
@Injectable()
export class AssistantSwitchMiddleware implements NestMiddleware {
  constructor(@Inject(ASSISTANT_ENABLED) private readonly enabled: boolean) {}

  use(_req: unknown, _res: unknown, next: () => void): void {
    if (!this.enabled) throw new NotFoundException();
    next();
  }
}
