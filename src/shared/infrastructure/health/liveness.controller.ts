import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

/**
 * Liveness probe, kept separate from readiness.
 *
 * The distinction matters in production: if `/health` failed because
 * PostgreSQL is down and the orchestrator used that endpoint for liveness, it
 * would restart the API in a loop without fixing anything — the problem is in
 * the database, not in the process.
 *
 * Liveness answers "the process is alive". Readiness answers "I can serve
 * requests". Unlike `/health`, this one IS subject to rate limiting.
 */
@ApiTags('health')
@Controller({ path: 'ping', version: '1' })
export class LivenessController {
  @Get()
  @ApiOperation({ summary: 'The process responds (liveness)' })
  ping(): { status: string; time: string } {
    return { status: 'alive', time: new Date().toISOString() };
  }
}
