import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiNoContentResponse,
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
  VoiceprintService,
  type VoiceprintOwner,
  type VoiceprintView,
} from './application/voiceprint.service';
import { ASSISTANT_ENABLED } from './assistant-diagnosis.controller';
import {
  VoiceprintAttributionDto,
  VoiceprintConsentQueryDto,
  VoiceprintDto,
} from './dto/voiceprint.dto';

/** AS-310. The reading is about a minute; two at most, in any browser format. */
export const MAX_VOICEPRINT_BYTES = 8 * 1024 * 1024;

/**
 * E17 (AS-310 to AS-313). «Mi voz», in «Mi cuenta». Always the caller's own:
 * the person comes from the session, never from the request, so there is no
 * id in the path to try. Not site-scoped: a voice is the person's, wherever
 * they work. Without `ASSISTANT_ENABLED`, a 404 before anything else (AS-026).
 *
 * The recording arrives as raw bytes, capped by the parser `AssistantModule`
 * mounts here, and goes to `clinica-ai` without being written anywhere.
 */
@ApiTags('assistant')
@Controller({ path: 'me/voiceprint', version: '1' })
export class AssistantVoiceprintController {
  constructor(
    private readonly voiceprints: VoiceprintService,
    private readonly currentUser: CurrentUserService,
    @Inject(ASSISTANT_ENABLED) private readonly enabled: boolean,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @RequirePermission('assistant:voiceprint', 'global')
  @ApiOperation({ summary: 'Mi voz: si está registrada, el interruptor y si el servicio puede distinguir voces' }) // prettier-ignore
  @ApiOkResponse({ type: VoiceprintDto })
  async view(@Req() req: Request): Promise<VoiceprintDto> {
    this.requireEnabled();
    return toDto(await this.voiceprints.view(this.owner(req)));
  }

  /** AS-310, AS-311. The recording in the body; only the vector is kept. */
  @Put()
  @Header('Cache-Control', 'no-store')
  @RequirePermission('assistant:voiceprint', 'global')
  // Each one holds the recogniser and the voice model of this machine for
  // tens of seconds; clinica-ai takes one at a time (review). A reading is
  // done once, and again rarely.
  @Throttle({ long: { ttl: 600_000, limit: 3 } })
  @Timeout(130_000)
  @ApiConsumes('application/octet-stream')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiOperation({ summary: 'Registrar o volver a registrar mi voz, con mi consentimiento; guarda sólo la huella' }) // prettier-ignore
  @ApiOkResponse({ type: VoiceprintDto })
  async register(
    @Query() query: VoiceprintConsentQueryDto,
    @Req() req: Request,
  ): Promise<VoiceprintDto> {
    this.requireEnabled();
    const body: unknown = req.body;
    const recording = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
    const gone = new AbortController();
    req.res?.once('close', () => {
      if (!req.res?.writableFinished) gone.abort();
    });
    return toDto(
      await this.voiceprints.register(
        this.owner(req),
        recording,
        query.consent === 'true',
        gone.signal,
      ),
    );
  }

  /** AS-313. «Distinguir mi voz de la del paciente». */
  @Put('attribution')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('assistant:voiceprint', 'global')
  @ApiOperation({ summary: 'Encender o apagar «Distinguir mi voz de la del paciente»' }) // prettier-ignore
  @ApiOkResponse({ type: VoiceprintDto })
  async setAttribution(
    @Body() body: VoiceprintAttributionDto,
    @Req() req: Request,
  ): Promise<VoiceprintDto> {
    this.requireEnabled();
    return toDto(
      await this.voiceprints.setAttribution(this.owner(req), body.on),
    );
  }

  /** AS-312. Gone from the base, without a version. */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('assistant:voiceprint', 'global')
  @ApiOperation({ summary: 'Borrar mi voz' })
  @ApiNoContentResponse()
  async remove(@Req() req: Request): Promise<void> {
    this.requireEnabled();
    await this.voiceprints.remove(this.owner(req));
  }

  private owner(req: Request): VoiceprintOwner {
    return {
      userId: this.currentUser.requireUserId(),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }

  /** AS-026. Off: the answer of a route that does not exist. */
  private requireEnabled(): void {
    if (!this.enabled) throw new NotFoundException();
  }
}

function toDto(view: VoiceprintView): VoiceprintDto {
  return {
    registered: view.registered && {
      phrases: view.registered.phrases,
      seconds: view.registered.seconds,
      consentedAt: view.registered.consentedAt.toISOString(),
      updatedAt: view.registered.updatedAt.toISOString(),
    },
    attribution: view.attribution,
    available: view.available,
    reason: view.reason,
  };
}
