import { Controller, Get, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { ClinicalHistoryService } from './application/clinical-history.service';
import {
  ClinicalHistoryDto,
  type ClinicalHistoryResponse,
} from './dto/clinical-history.dto';

/**
 * AS-200 to AS-207. The patient's history without a model (B1).
 *
 * `record:read` with `'query'` scope, like the evolution of the vitals
 * (EN-269): a result hangs off an attention, an attention happens at a site,
 * and the doctor at the southern branch reads the history of her sites.
 *
 * ⚠️ NOT behind the assistant's switch (`AssistantSwitchMiddleware`) nor
 * `assistant:use` (D-256 §1): no model is called and nothing leaves the
 * database — it is a read of the chart, like «Para completar la nota» (AS-118).
 */
@ApiTags('assistant')
@Controller({ path: 'patients/:patientId', version: '1' })
export class AssistantHistoryController {
  constructor(
    private readonly history: ClinicalHistoryService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get('clinical-history')
  @RequirePermission('record:read', 'query')
  @ApiOperation({
    summary:
      'Historia del paciente sin modelo: resultados, medicamentos y línea de tiempo',
  })
  @ApiOkResponse({ type: ClinicalHistoryDto })
  async read(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Req() req: Request,
  ): Promise<ClinicalHistoryResponse> {
    const scope = this.currentUser.requirePrincipal().sitesFor('record:read');
    const history = await this.history.forChart(patientId, {
      userId: this.currentUser.requireUserId(),
      sites: scope === ALL_SITES ? 'all' : scope,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    return {
      patientId: history.patientId,
      results: {
        // Instants leave as ISO 8601; the client renders them in Ecuadorian time.
        items: history.results.items.map((result) => ({
          ...result,
          observedAt: result.observedAt.toISOString(),
        })),
        total: history.results.total,
      },
      medications: history.medications,
      visits: history.visits,
      timeline: history.timeline.map((day) => ({
        date: day.date,
        items: day.items.map((item) =>
          item.kind === 'visit'
            ? { ...item, diagnoses: [...item.diagnoses] }
            : item,
        ),
      })),
      hasEntriesOutsideScope: history.hasEntriesOutsideScope,
    };
  }
}
