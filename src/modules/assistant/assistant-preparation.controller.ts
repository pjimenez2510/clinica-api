import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
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
import {
  ListeningService,
  PREPARATION_LISTENING,
} from './application/listening.service';
import { withDictation } from './assistant-sites';
import { ListeningDto, ListeningTicketDto } from './dto/listening.dto';

/**
 * AS-240, AS-243 (B3). The preparation listened to: the ticket for the same
 * audio channel as the consultation's, and what it heard.
 *
 * `assistant:dictate-vitals` with `'query'` scope, narrowed to the sites where
 * the caller also has `vitals:write` and the assistant is on (D-255 §1):
 * whoever prepares, not only the attention's professional (D-260 §2). The
 * switch (AS-026) answers 404 before any of it, from
 * `AssistantSwitchMiddleware`.
 */
@ApiTags('assistant')
@Controller({ path: 'encounters/:encounterId/assistant', version: '1' })
export class AssistantPreparationController {
  constructor(
    private readonly access: ListeningAccess,
    @Inject(PREPARATION_LISTENING)
    private readonly listening: ListeningService,
    private readonly currentUser: CurrentUserService,
    @Inject(ASSISTANT_SITE_SWITCH)
    private readonly siteSwitch: AssistantSiteSwitch,
  ) {}

  /** AS-240. A single-use ticket for the channel, alive for 30 s. */
  @Post('preparation-listening/ticket')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('assistant:dictate-vitals', 'query')
  // A ticket per (re)connection, as the consultation's (AS-045).
  @Throttle({ long: { ttl: 60_000, limit: 60 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Vale para escuchar la preparación de la atención' }) // prettier-ignore
  @ApiOkResponse({ type: ListeningTicketDto })
  async ticket(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<ListeningTicketDto> {
    const issued = await this.access.issuePreparation(
      encounterId,
      await this.requester(req),
    );
    return {
      ticket: issued.ticket,
      expiresAt: issued.expiresAt.toISOString(),
    };
  }

  /** AS-243. The listening of the preparation and what it heard. */
  @Get('preparation-listening')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('assistant:dictate-vitals', 'query')
  @ApiOperation({ summary: 'La escucha de la preparación y su transcripción' })
  @ApiOkResponse({ type: ListeningDto })
  async read(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<ListeningDto> {
    const { recordingAuthorized } = await this.access.readPreparation(
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

  private async requester(req: Request): Promise<ListeningRequester> {
    const principal = this.currentUser.requirePrincipal();
    const enabled = await this.siteSwitch.enabledSites();
    const exp = this.currentUser.get()?.exp;
    // AS-047. Every token `jose` signs carries `exp`.
    if (typeof exp !== 'number') throw new MissingTokenError();
    return {
      userId: this.currentUser.requireUserId(),
      writeSites: withDictation(principal, enabled),
      tokenExpiresAt: new Date(exp * 1000),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}
