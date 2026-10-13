import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { RequirePermission } from '../../shared/http/auth.decorators';
import { Timeout } from '../../shared/http/interceptors/timeout.interceptor';

import {
  VitalsDictationService,
  type DictationRequester,
} from './application/vitals-dictation.service';
import { ASSISTANT_ENABLED } from './assistant-diagnosis.controller';
import { withDictation } from './assistant-sites';
import {
  VitalsDictationDto,
  VitalsDictationLimitsDto,
} from './dto/vitals-dictation.dto';

/** AS-186. Two minutes of speech in any format the browser records. */
export const MAX_DICTATION_BYTES = 8 * 1024 * 1024;

/**
 * AS-180, AS-184 to AS-186, AS-196. The vital signs said aloud in the Signos
 * tab, read into a proposal for the taking's form (B2).
 *
 * `assistant:dictate-vitals` with `'query'` scope, narrowed by the service to
 * the sites where the caller also has `vitals:write` (D-255 §1); whose
 * attention it is does not matter. Without `ASSISTANT_ENABLED`, a 404 before
 * anything else (AS-026). The recording arrives as raw bytes, capped by the
 * parser `AssistantModule` mounts here (413 before a byte reaches this class).
 */
@ApiTags('assistant')
@Controller({ path: 'encounters/:encounterId/assistant/vitals-dictation', version: '1' }) // prettier-ignore
export class AssistantVitalsDictationController {
  constructor(
    private readonly dictation: VitalsDictationService,
    private readonly currentUser: CurrentUserService,
    @Inject(ASSISTANT_ENABLED) private readonly enabled: boolean,
  ) {}

  /** AS-196. Whether «Dictar» is offered here, and for how long it records. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @RequirePermission('assistant:dictate-vitals', 'query')
  @ApiOperation({ summary: 'Si se pueden dictar los signos de la atención' })
  @ApiOkResponse({ type: VitalsDictationLimitsDto })
  async limits(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
  ): Promise<VitalsDictationLimitsDto> {
    this.requireEnabled();
    return this.dictation.limits(encounterId, this.requester());
  }

  /** AS-180. The recording in the body; the proposal back. Stores nothing. */
  @Post()
  // AS-184. What was said is the patient's readings: no cache keeps it.
  @Header('Cache-Control', 'no-store')
  @RequirePermission('assistant:dictate-vitals', 'query')
  // AS-185. Each one holds the recogniser of this machine for seconds.
  @Throttle({ long: { ttl: 60_000, limit: 30 } })
  // AS-186. Above the transcriber's 60 s, so its 503 is what arrives, not the
  // global 15 s of every other route.
  @Timeout(65_000)
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('application/octet-stream')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiOperation({ summary: 'Leer los signos dictados como propuesta para la toma; no guarda nada' }) // prettier-ignore
  @ApiOkResponse({ type: VitalsDictationDto })
  async dictate(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<VitalsDictationDto> {
    this.requireEnabled();
    const body: unknown = req.body;
    // No body at all leaves no Buffer: the same answer as an empty one.
    const recording = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
    // The screen gave up (closed, navigated away): the recogniser is freed.
    const gone = new AbortController();
    req.res?.once('close', () => {
      if (!req.res?.writableFinished) gone.abort();
    });
    return this.dictation.dictate(
      encounterId,
      recording,
      this.requester(),
      gone.signal,
    );
  }

  /** AS-026. Off: the answer of a route that does not exist. */
  private requireEnabled(): void {
    if (!this.enabled) throw new NotFoundException();
  }

  private requester(): DictationRequester {
    return { sites: withDictation(this.currentUser.requirePrincipal()) };
  }
}
