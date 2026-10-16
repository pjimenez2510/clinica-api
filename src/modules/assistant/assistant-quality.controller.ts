import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { RequirePermission } from '../../shared/http/auth.decorators';

import type { QualityScope } from './application/assistant-quality.reader';
import { AssistantQualityService } from './application/assistant-quality.service';
import {
  EncounterQualityDto,
  type EncounterQualityResponse,
  QualityCsvQueryDto,
  QualityWeekDto,
  QualityWeekQueryDto,
  type QualityWeekResponse,
} from './dto/assistant-quality.dto';

/**
 * E19 (AS-345 to AS-353). «Calidad del asistente»: what it proposed, what was
 * done with it, what it cost and how long it took — figures only (AS-349).
 *
 * `audit:read` OR `assistant:use`, `'query'` scope (AS-350, D-266): the
 * handler narrows. With `audit:read`, the attentions of the sites where the
 * caller holds it; holding only `assistant:use`, the caller's own attentions
 * at the sites where they hold it. The CSV is `audit:read` alone (AS-352).
 *
 * ⚠️ NOT behind the assistant's switch (`AssistantSwitchMiddleware`), like the
 * history (E12): no model is called and nothing leaves the database; a site
 * that switched the assistant off still sees what it spent.
 */
@ApiTags('assistant')
@Controller({ path: 'assistant-quality', version: '1' })
export class AssistantQualityController {
  constructor(
    private readonly quality: AssistantQualityService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get('week')
  @RequirePermission(['audit:read', 'assistant:use'], 'query')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Calidad y costo del asistente en una semana, por sede',
  })
  @ApiOkResponse({ type: QualityWeekDto })
  async week(
    @Query() query: QualityWeekQueryDto,
  ): Promise<QualityWeekResponse> {
    const week = await this.quality.week(
      query.date,
      query.siteId ?? null,
      this.scope(),
    );
    return {
      ...week,
      encounters: week.encounters.map((row) => ({
        ...row,
        startedAt: row.startedAt.toISOString(),
      })),
    };
  }

  @Get('encounters/:encounterId')
  @RequirePermission(['audit:read', 'assistant:use'], 'query')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Desglose del asistente en una atención' })
  @ApiOkResponse({ type: EncounterQualityDto })
  async encounter(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
  ): Promise<EncounterQualityResponse> {
    const quality = await this.quality.encounter(encounterId, this.scope());
    return { ...quality, startedAt: quality.startedAt.toISOString() };
  }

  @Get('weeks.csv')
  @RequirePermission('audit:read', 'query')
  @ApiOperation({ summary: 'Cifras semanales del asistente por sede (CSV)' })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'Una fila por semana y sede', type: String })
  async csv(
    @Query() query: QualityCsvQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const scope = this.currentUser.requirePrincipal().sitesFor('audit:read');
    const csv = await this.quality.csv(query.from, query.to, {
      sites: scope === ALL_SITES ? 'all' : scope,
      practitionerUserId: null,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="calidad-asistente-${query.from}-${query.to}.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    return csv;
  }

  /** AS-350. `audit:read` sees its sites; otherwise only one's own attentions. */
  private scope(): QualityScope {
    const principal = this.currentUser.requirePrincipal();
    const audit = principal.sitesFor('audit:read');
    if (audit === ALL_SITES || audit.length > 0) {
      return {
        sites: audit === ALL_SITES ? 'all' : audit,
        practitionerUserId: null,
      };
    }
    const own = principal.sitesFor('assistant:use');
    return {
      sites: own === ALL_SITES ? 'all' : own,
      practitionerUserId: principal.userId,
    };
  }
}
