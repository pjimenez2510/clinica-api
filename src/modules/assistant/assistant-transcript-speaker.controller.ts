import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Put,
  Req,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  CurrentUserService,
  MissingTokenError,
} from '../../shared/authorisation/current-user.service';
import {
  ASSISTANT_SITE_SWITCH,
  type AssistantSiteSwitch,
} from '../../shared/clinical/assistant-site-switch.port';
import { RequirePermission } from '../../shared/http/auth.decorators';

import {
  ListeningAccess,
  type ListeningRequester,
} from './application/listening-access';
import {
  ListeningService,
  PREPARATION_LISTENING,
} from './application/listening.service';
import {
  withAssistant,
  withDictation,
  type SiteScope,
} from './assistant-sites';
import { LineSpeakerDto } from './dto/listening.dto';

/**
 * AS-317 (E17). The professional says who said a line, by its start, in the
 * consultation's listening and in the preparation's. The same permissions and
 * refusals as reading that transcript (AS-056, AS-243); the trail records an
 * `UPDATE`. A line labelled here is never touched by the model again.
 */
@ApiTags('assistant')
@Controller({ path: 'encounters/:encounterId/assistant', version: '1' })
export class AssistantTranscriptSpeakerController {
  constructor(
    private readonly access: ListeningAccess,
    private readonly listening: ListeningService,
    @Inject(PREPARATION_LISTENING)
    private readonly preparation: ListeningService,
    private readonly currentUser: CurrentUserService,
    @Inject(ASSISTANT_SITE_SWITCH)
    private readonly siteSwitch: AssistantSiteSwitch,
  ) {}

  @Put('listening/lines/:startMs/speaker')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('assistant:use', 'query')
  @ApiOperation({ summary: 'Corregir quién dijo una línea de la escucha de la consulta' }) // prettier-ignore
  @ApiNoContentResponse()
  async consultation(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('startMs', ParseIntPipe) startMs: number,
    @Body() body: LineSpeakerDto,
    @Req() req: Request,
  ): Promise<void> {
    const principal = this.currentUser.requirePrincipal();
    const enabled = await this.siteSwitch.enabledSites();
    await this.access.read(
      encounterId,
      this.requester(req, withAssistant(principal, 'record:write', enabled)),
      'UPDATE',
    );
    await this.listening.label(encounterId, startMs, body.speaker);
  }

  @Put('preparation-listening/lines/:startMs/speaker')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('assistant:dictate-vitals', 'query')
  @ApiOperation({ summary: 'Corregir quién dijo una línea de la escucha de la preparación' }) // prettier-ignore
  @ApiNoContentResponse()
  async preparationLine(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('startMs', ParseIntPipe) startMs: number,
    @Body() body: LineSpeakerDto,
    @Req() req: Request,
  ): Promise<void> {
    const principal = this.currentUser.requirePrincipal();
    const enabled = await this.siteSwitch.enabledSites();
    await this.access.readPreparation(
      encounterId,
      this.requester(req, withDictation(principal, enabled)),
      'UPDATE',
    );
    await this.preparation.label(encounterId, startMs, body.speaker);
  }

  private requester(req: Request, writeSites: SiteScope): ListeningRequester {
    const exp = this.currentUser.get()?.exp;
    // AS-047. Every token `jose` signs carries `exp`.
    if (typeof exp !== 'number') throw new MissingTokenError();
    return {
      userId: this.currentUser.requireUserId(),
      writeSites,
      tokenExpiresAt: new Date(exp * 1000),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}
