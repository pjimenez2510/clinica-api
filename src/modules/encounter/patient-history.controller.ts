import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
import {
  EditHistoryDto,
  HistoryDto,
  HistoryListDto,
  HistoryVersionListDto,
  RecordHistoryDto,
  RefuteHistoryDto,
  type HistoryListResponse,
  type HistoryResponse,
  type HistoryVersionListResponse,
} from './dto/patient-history.dto';
import { toHistoryResponse } from './dto/patient-history.mapper';

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

  /**
   * EN-220. Edits what the entry says, in its row; the version it replaces is
   * kept. `record:write`, like refuting: correcting a finding is the same
   * clinical judgement as ruling it out (EN-164).
   */
  @Patch('history/:historyId')
  @RequirePermission('record:write', 'global')
  @ApiOperation({ summary: 'Corregir un antecedente del paciente' })
  @ApiOkResponse({ type: HistoryDto })
  async edit(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('historyId', ParseUUIDPipe) historyId: string,
    @Body() dto: EditHistoryDto,
    @Req() req: Request,
  ): Promise<HistoryResponse> {
    const edited = await this.history.edit(
      {
        patientId,
        historyId,
        changes: {
          ...(dto.kind === undefined ? {} : { kind: dto.kind }),
          ...(dto.description === undefined
            ? {}
            : { description: dto.description }),
          ...(dto.relative === undefined ? {} : { relative: dto.relative }),
        },
      },
      this.requester(req, 'record:write'),
    );
    return toHistoryResponse(edited);
  }

  /**
   * EN-219. Brings back an entry ruled out by mistake. `background:write`,
   * like recording one.
   */
  @Post('history/:historyId/reactivate')
  @RequirePermission('background:write', 'global')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivar un antecedente descartado por error' })
  @ApiOkResponse({ type: HistoryDto })
  async reactivate(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('historyId', ParseUUIDPipe) historyId: string,
    @Req() req: Request,
  ): Promise<HistoryResponse> {
    const reactivated = await this.history.reactivate(
      patientId,
      historyId,
      this.requester(req, 'background:write'),
    );
    return toHistoryResponse(reactivated);
  }

  /** EN-220. The versions the changes replaced; `record:read`, audited. */
  @Get('history/:historyId/versions')
  @RequirePermission('record:read', 'global')
  @ApiOperation({ summary: 'Versiones anteriores de un antecedente' })
  @ApiOkResponse({ type: HistoryVersionListDto })
  async versions(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('historyId', ParseUUIDPipe) historyId: string,
    @Req() req: Request,
  ): Promise<HistoryVersionListResponse> {
    const versions = await this.history.versionsOf(
      patientId,
      historyId,
      this.requester(req, 'record:read'),
    );
    return {
      items: versions.map((version) => ({
        version: version.version,
        replacedBy: version.replacedBy,
        replacedAt: version.replacedAt.toISOString(),
        entry: toHistoryResponse(version.entry),
      })),
    };
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
