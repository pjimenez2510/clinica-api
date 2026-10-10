import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import type { Permission } from '../../shared/authorisation/permission.catalogue';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { RequirePermission } from '../../shared/http/auth.decorators';

import type { Requester } from './application/encounter.service';
import {
  ProgramBlocksService,
  type HoldsKeyAt,
  type ProgramsSheet,
} from './application/program-blocks.service';
import type {
  BlockStamp,
  NutritionRecord,
  ObstetricRecord,
  VaccinationRecord,
} from './domain/program-blocks';
import {
  NutritionRecordDto,
  ObstetricRecordDto,
  ProgramsSheetDto,
  RecordNutritionDto,
  RecordObstetricDto,
  RecordVaccinationDto,
  VaccinationRecordDto,
  type NutritionRecordResponse,
  type ObstetricRecordResponse,
  type ProgramsSheetResponse,
  type VaccinationRecordResponse,
} from './dto/program-blocks.dto';

/**
 * EN-090 to EN-093, EN-097, EN-249. Blocks G (obstetric), H (SIVAN) and I
 * (vaccines) of the RDACAA form, under `programs`.
 *
 * `'query'` site scope like the rest of the module: the attention is
 * addressed by its own id and the service narrows with the caller's resolved
 * scope (EN-121). Reading is `record:read`. Writing G is `record:write` — the
 * obstetric risk is a clinical judgement —; writing H and I is
 * `vitals:write`, which `MEDICO` and `ENFERMERIA` carry from the factory,
 * like the taking of the preparation (D-195.5).
 *
 * Block J is NOT here: it has the door of the violence screening (EN-095).
 */
@ApiTags('encounter')
@Controller({ path: 'encounters/:encounterId/programs', version: '1' })
export class ProgramBlocksController {
  constructor(
    private readonly programs: ProgramBlocksService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** EN-090, EN-092, EN-093, EN-097. Which blocks apply, and what is recorded. */
  @Get()
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Consultar los bloques de programa de la atención' })
  @ApiOkResponse({ type: ProgramsSheetDto })
  async programsOf(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<ProgramsSheetResponse> {
    return toSheet(
      await this.programs.programsOf(
        encounterId,
        this.requester(req, 'record:read'),
        this.holdsKeyAt(),
      ),
    );
  }

  /** EN-090, EN-091, EN-249. Records or corrects block G. */
  @Put('obstetric')
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registrar los datos obstétricos de la atención' })
  @ApiOkResponse({ type: ObstetricRecordDto })
  async recordObstetric(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: RecordObstetricDto,
    @Req() req: Request,
  ): Promise<ObstetricRecordResponse> {
    return toObstetric(
      await this.programs.recordObstetric(
        encounterId,
        { ...dto },
        this.requester(req, 'record:write'),
      ),
    );
  }

  /** EN-092, EN-249. Records or corrects block H. */
  @Put('nutrition')
  @RequirePermission('vitals:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registrar los datos de lactancia de la atención' })
  @ApiOkResponse({ type: NutritionRecordDto })
  async recordNutrition(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: RecordNutritionDto,
    @Req() req: Request,
  ): Promise<NutritionRecordResponse> {
    return toNutrition(
      await this.programs.recordNutrition(
        encounterId,
        { ...dto },
        this.requester(req, 'vitals:write'),
      ),
    );
  }

  /** EN-093, EN-249, EN-261. Records or corrects block I. */
  @Put('vaccination')
  @RequirePermission('vitals:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registrar las vacunas de la atención' })
  @ApiOkResponse({ type: VaccinationRecordDto })
  async recordVaccination(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: RecordVaccinationDto,
    @Req() req: Request,
  ): Promise<VaccinationRecordResponse> {
    return toVaccination(
      await this.programs.recordVaccination(
        encounterId,
        {
          doses: dto.doses.map(({ code, dose, riskGroup }) => ({ code, dose, riskGroup })), // prettier-ignore
        },
        this.requester(req, 'vitals:write'),
        this.holdsKeyAt(),
      ),
    );
  }

  /** REQ-115. The second key, at the attention's site. */
  private holdsKeyAt(): HoldsKeyAt {
    const principal = this.currentUser.requirePrincipal();
    return (siteId) => principal.canAtSite('record:protected', siteId);
  }

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

/** Instants leave as ISO 8601. */
function stampOf(record: BlockStamp) {
  return {
    recordedAt: record.recordedAt.toISOString(),
    editedAt: record.editedAt?.toISOString() ?? null,
  };
}

function toObstetric(record: ObstetricRecord): ObstetricRecordResponse {
  return { ...record, ...stampOf(record) };
}

function toNutrition(record: NutritionRecord): NutritionRecordResponse {
  return { ...record, ...stampOf(record) };
}

function toVaccination(record: VaccinationRecord): VaccinationRecordResponse {
  return {
    doses: record.doses.map(({ code, dose, riskGroup }) => ({ code, dose, riskGroup })), // prettier-ignore
    ...stampOf(record),
  };
}

function toSheet(sheet: ProgramsSheet): ProgramsSheetResponse {
  return {
    clinicalDate: sheet.clinicalDate,
    obstetric: {
      applies: sheet.obstetric.applies,
      record: sheet.obstetric.record && toObstetric(sheet.obstetric.record),
    },
    nutrition: {
      band: sheet.nutrition.band,
      record: sheet.nutrition.record && toNutrition(sheet.nutrition.record),
    },
    vaccination: {
      vaccines: sheet.vaccination.vaccines,
      record:
        sheet.vaccination.record && toVaccination(sheet.vaccination.record),
      riskGroupWithheld: sheet.vaccination.riskGroupWithheld,
    },
  };
}
