import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  type HealthIndicatorResult,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { PinoLogger } from 'nestjs-pino';

import { Public } from '../../http/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@Controller({ path: 'health', version: '1' })
@Public()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(HealthController.name);
  }

  /**
   * Readiness probe: also checks dependencies.
   *
   * Exempt from rate limiting on purpose: the orchestrator probes often and a
   * 429 would be read as the service being down.
   *
   * NOTE: every throttler must be named explicitly. A bare `@SkipThrottle()`
   * only exempts the throttler called `default`, and all of ours are named —
   * the probe would keep being rate limited with nothing warning about it.
   */
  @Get()
  @SkipThrottle({ short: true, medium: true, long: true })
  @HealthCheck()
  @ApiOperation({ summary: 'Service and dependency status' })
  check() {
    return this.health.check([
      (): Promise<HealthIndicatorResult> => this.checkDatabase(),
      () => this.memory.checkHeap('memory_heap', 512 * 1024 * 1024),
    ]);
  }

  private async checkDatabase(): Promise<HealthIndicatorResult> {
    try {
      await this.prisma.ping();
      return { database: { status: 'up' } };
    } catch (error) {
      /**
       * Two different destinations for the same cause, on purpose:
       *
       *  - The LOG gets the sanitized reason, so it can be diagnosed. Without
       *    it the endpoint only says "down" and there is no way to tell
       *    network from credentials from an engine that never started.
       *  - The RESPONSE gets nothing. The message can drag the connection
       *    string with username and password, and this endpoint is usually
       *    reachable from outside.
       */
      const cause = error instanceof Error ? error : new Error('unknown');
      this.logger.error(
        { err: cause, dependency: 'postgresql' },
        'dependency check failed',
      );
      return { database: { status: 'down' } };
    }
  }
}
