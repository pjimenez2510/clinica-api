import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { RequirePermission } from '../../shared/http/auth.decorators';
import type { Permission } from '../../shared/authorisation/permission.catalogue';

import { PatientHistoryService } from './application/patient-history.service';
import type { Requester } from './application/encounter.service';
import type { HistoryView } from './domain/patient-history.repository';
import {
  HistoryDto,
  HistoryListDto,
  RecordHistoryDto,
  RefuteHistoryDto,
  type HistoryListResponse,
  type HistoryResponse,
} from './dto/patient-history.dto';

/**
 * EN-085, EN-164. The patient's personal and family history.
 *
 * GLOBAL SCOPE, like the allergies: the history is of the PERSON, not of a
 * site, and a chart is global (`patients`).
 */
@ApiTags('encounter')
@Controller({ path: 'patients/:patientId', version: '1' })
export class PatientHistoryController {
  constructor(
    private readonly history: PatientHistoryService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** EN-085. `record:read`: the history is clinical content. */
  @Get('history')
  @RequirePermission('record:read', 'global')
  @ApiOperation({ summary: 'Consultar los antecedentes del paciente' })
  @ApiOkResponse({ type: HistoryListDto })
  async list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Req() req: Request,
  ): Promise<HistoryListResponse> {
    const entries = await this.history.listFor(
      patientId,
      this.requester(req, 'record:read'),
    );
    return { items: entries.map(toHistoryResponse) };
  }

  /**
   * EN-085, EN-164. `background:write`: what the patient declares is
   * anamnesis, and preparation takes it (F-03).
   */
  @Post('history')
  @RequirePermission('background:write', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar un antecedente del paciente' })
  @ApiCreatedResponse({ type: HistoryDto })
  async record(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: RecordHistoryDto,
    @Req() req: Request,
  ): Promise<HistoryResponse> {
    const entry = await this.history.record(
      {
        patientId,
        kind: dto.kind,
        description: dto.description,
        relative: dto.relative,
      },
      this.requester(req, 'background:write'),
    );
    return toHistoryResponse(entry);
  }

  /**
   * EN-085, EN-164. Ruling an entry out is a clinical judgement:
   * `record:write`, as for the allergy (EN-082).
   */
  @Post('history/:historyId/refute')
  @RequirePermission('record:write', 'global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Descartar un antecedente del paciente' })
  @ApiOkResponse({ type: HistoryDto })
  async refute(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('historyId', ParseUUIDPipe) historyId: string,
    @Body() dto: RefuteHistoryDto,
    @Req() req: Request,
  ): Promise<HistoryResponse> {
    const refuted = await this.history.refute(
      { patientId, historyId, notes: dto.notes },
      this.requester(req, 'record:write'),
    );
    return toHistoryResponse(refuted);
  }

  /** Who is asking, for the access trail. Global routes: the scope is `all`. */
  private requester(req: Request, permission: Permission): Requester {
    const scope = this.currentUser.requirePrincipal().sitesFor(permission);

    return {
      userId: this.currentUser.requireUserId(),
      sites: scope === ALL_SITES ? 'all' : scope,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

/** Shared with the chart summary, so the two reads cannot disagree. */
export function toHistoryResponse(entry: HistoryView): HistoryResponse {
  return {
    id: entry.id,
    patientId: entry.patientId,
    kind: entry.kind,
    description: entry.description,
    relative: entry.relative,
    recordedAt: entry.recordedAt.toISOString(),
    recordedBy: entry.recordedBy,
    refutedAt: entry.refutedAt?.toISOString() ?? null,
    refutedNotes: entry.refutedNotes,
    refutedBy: entry.refutedBy,
  };
}
