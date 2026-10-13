import {
  Controller,
  Inject,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
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
import { ListeningService } from './application/listening.service';
import { withAssistant } from './assistant-sites';
import {
  ListeningDto,
  ListeningTicketDto,
  RecordingAuthorizationDto,
} from './dto/listening.dto';

/**
 * AS-045, AS-056. The HTTP half of the listening: the ticket the audio
 * channel is opened with, and the transcript.
 *
 * `assistant:use` on both, with `'query'` scope (the site is the attention's,
 * not the URL's), crossed with `record:write`; who the attention belongs to
 * decides the rest (M-02). The switch (AS-026) answers 404 before any of it,
 * from `AssistantSwitchMiddleware`.
 */
@ApiTags('assistant')
@Controller({ path: 'encounters/:encounterId/assistant/listening', version: '1' }) // prettier-ignore
export class AssistantListeningController {
  constructor(
    private readonly access: ListeningAccess,
    private readonly listening: ListeningService,
    private readonly currentUser: CurrentUserService,
    @Inject(ASSISTANT_SITE_SWITCH)
    private readonly siteSwitch: AssistantSiteSwitch,
  ) {}

  /**
   * AS-045. A single-use ticket for the audio channel, alive for 30 s.
   * `no-store`, like the transcript below, comes from AU-061: never exempt.
   */
  @Post('ticket')
  @RequirePermission('assistant:use', 'query')
  // A ticket per (re)connection: sixty a minute is a flaky network, not more.
  @Throttle({ long: { ttl: 60_000, limit: 60 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Vale para abrir la escucha de la atención' })
  @ApiOkResponse({ type: ListeningTicketDto })
  async ticket(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<ListeningTicketDto> {
    const issued = await this.access.issue(
      encounterId,
      await this.requester(req),
    );
    return {
      ticket: issued.ticket,
      expiresAt: issued.expiresAt.toISOString(),
    };
  }

  /** AS-056. The listening and what it heard, to its professional only. */
  @Get()
  @RequirePermission('assistant:use', 'query')
  @ApiOperation({ summary: 'La escucha de la atención y su transcripción' })
  @ApiOkResponse({ type: ListeningDto })
  async read(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<ListeningDto> {
    const { recordingAuthorized } = await this.access.read(
      encounterId,
      await this.requester(req),
    );
    const [session, segments] = await Promise.all([
      this.listening.sessionOf(encounterId),
      this.listening.transcriptOf(encounterId),
    ]);
    return {
      session: session && {
        state: session.state,
        offsetMs: session.offsetMs,
        reason: session.reason,
        device: session.device,
        capturing: session.capturing,
        startedAt: session.startedAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      },
      segments,
      recordingAuthorized,
    };
  }

  /**
   * AS-168 (D-254 §3). The patient authorizes recording in the consultation
   * room: the attention's own professional records it, like AS-045 asks.
   */
  @Post('authorization')
  @RequirePermission('assistant:use', 'query')
  // Recorded once per patient: ten a minute is a doctor retrying, not more.
  @Throttle({ long: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registrar la autorización de grabar la consulta' })
  @ApiOkResponse({ type: RecordingAuthorizationDto })
  async authorize(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<RecordingAuthorizationDto> {
    return this.access.authorize(encounterId, await this.requester(req));
  }

  private async requester(req: Request): Promise<ListeningRequester> {
    const principal = this.currentUser.requirePrincipal();
    const enabled = await this.siteSwitch.enabledSites();
    const exp = this.currentUser.get()?.exp;
    // AS-047. Every token `jose` signs carries `exp`.
    if (typeof exp !== 'number') throw new MissingTokenError();
    return {
      userId: this.currentUser.requireUserId(),
      writeSites: withAssistant(principal, 'record:write', enabled),
      tokenExpiresAt: new Date(exp * 1000),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}
