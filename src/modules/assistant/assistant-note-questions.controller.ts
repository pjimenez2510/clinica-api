import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { RequirePermission } from '../../shared/http/auth.decorators';

import {
  NoteQuestionService,
  type QuestionRequester,
  type QuestionsOverview,
} from './application/note-question.service';
import { ASSISTANT_ENABLED } from './assistant-diagnosis.controller';
import { withAssistant } from './assistant-sites';
import { NoteQuestionsOverviewDto } from './dto/note-questions.dto';

/**
 * AS-119 to AS-125. The questions «Para completar la nota» in the Nota tab.
 *
 * Like the draft (AS-086): `assistant:use` with `'query'` scope, narrowed by
 * the service to the caller's own `record:write` sites crossed with the
 * assistant's, and only the attention's professional gets an answer
 * (AS-039). Without `ASSISTANT_ENABLED`, a 404 before anything else (AS-026).
 */
@ApiTags('assistant')
@Controller({ path: 'encounters/:encounterId/assistant/note-questions', version: '1' }) // prettier-ignore
export class AssistantNoteQuestionsController {
  constructor(
    private readonly questions: NoteQuestionService,
    private readonly currentUser: CurrentUserService,
    @Inject(ASSISTANT_ENABLED) private readonly enabled: boolean,
  ) {}

  /** AS-122. The questions of the latest review. */
  @Get()
  @RequirePermission('assistant:use', 'query')
  @ApiOperation({ summary: 'Preguntas del asistente para completar la nota' })
  @ApiOkResponse({ type: NoteQuestionsOverviewDto })
  async overview(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<NoteQuestionsOverviewDto> {
    this.requireEnabled();
    return toResponse(await this.questions.overview(encounterId, this.requester(req))); // prettier-ignore
  }

  /** AS-119, AS-123. Reviews the note against the conversation, now. */
  @Post()
  @RequirePermission('assistant:use', 'query')
  // A review pays a call unless nothing changed (AS-123): twelve a minute is
  // a physician writing, not a loop draining the month's ceiling.
  @Throttle({ long: { ttl: 60_000, limit: 12 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revisar qué falta preguntar con lo transcrito y lo escrito' }) // prettier-ignore
  @ApiOkResponse({ type: NoteQuestionsOverviewDto })
  async check(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<NoteQuestionsOverviewDto> {
    this.requireEnabled();
    return toResponse(await this.questions.check(encounterId, this.requester(req))); // prettier-ignore
  }

  /** AS-125. «No hace falta». */
  @Post(':suggestionId/discard')
  @RequirePermission('assistant:use', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Descartar una pregunta del asistente' })
  @ApiOkResponse({ type: NoteQuestionsOverviewDto })
  async discard(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('suggestionId', ParseUUIDPipe) suggestionId: string,
    @Req() req: Request,
  ): Promise<NoteQuestionsOverviewDto> {
    this.requireEnabled();
    return toResponse(
      await this.questions.discard({ encounterId, suggestionId }, this.requester(req)), // prettier-ignore
    );
  }

  /** AS-026. Off: the answer of a route that does not exist. */
  private requireEnabled(): void {
    if (!this.enabled) throw new NotFoundException();
  }

  private requester(req: Request): QuestionRequester {
    const principal = this.currentUser.requirePrincipal();
    return {
      userId: this.currentUser.requireUserId(),
      writeSites: withAssistant(principal, 'record:write'),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

/** Instants leave as ISO 8601. */
function toResponse(overview: QuestionsOverview): NoteQuestionsOverviewDto {
  return { ...overview, checkedAt: overview.checkedAt?.toISOString() ?? null };
}
