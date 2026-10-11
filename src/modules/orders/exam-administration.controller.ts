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
  Put,
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
import { RequirePermission } from '../../shared/http/auth.decorators';

import {
  ExamAdministrationService,
  type CatalogueEditor,
} from './application/exam-administration.service';
import type { ReferenceRange } from './domain/analyte';
import type {
  AdminAnalyteView,
  AdminExamView,
} from './domain/exam-administration.repository';
import {
  AdminAnalyteDto,
  AdminAnalyteListDto,
  AdminExamDto,
  AnalyteRangesDto,
  CreateAnalyteDto,
  ExamStructureDto,
  RangeHistoryDto,
  UpdateAnalyteDto,
  type AdminAnalyteListResponse,
  type AdminAnalyteResponse,
  type AdminExamResponse,
  type RangeHistoryResponse,
} from './dto/exam-administration.dto';

/**
 * The exam catalogue, administered by the clinic (ORD-104 to ORD-111).
 *
 * ADR-013. An exam is a service: it is created, corrected and retired in
 * billing (`POST/PATCH /billing/services`, BI-280, BI-284). Here only what an
 * ordered service yields: its structure (ORD-105), the analytes and their
 * ranges.
 *
 * `catalog:manage` on every route, reads included: this screen shows retired
 * analytes, which ordering —`GET /exams`, `catalog:read`— has no business
 * seeing. Global scope: the catalogue is the clinic's, not a site's.
 */
@ApiTags('orders')
@Controller({ path: 'exam-catalogue', version: '1' })
export class ExamAdministrationController {
  constructor(
    private readonly catalogue: ExamAdministrationService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** ORD-105. The structure of a service with order extension (BI-284). */
  @Put('exams/:serviceId/analytes')
  @RequirePermission('catalog:manage', 'global')
  @ApiOperation({ summary: 'Fijar las determinaciones del examen y su orden' })
  @ApiOkResponse({ type: AdminExamDto })
  async setStructure(
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Body() dto: ExamStructureDto,
    @Req() req: Request,
  ): Promise<AdminExamResponse> {
    return toExamResponse(
      await this.catalogue.setStructure(
        serviceId,
        dto.analytes,
        this.editor(req),
      ),
    );
  }

  @Get('analytes')
  @RequirePermission('catalog:manage', 'global')
  @ApiOperation({ summary: 'Listar las determinaciones del catálogo' })
  @ApiOkResponse({ type: AdminAnalyteListDto })
  async analytes(): Promise<AdminAnalyteListResponse> {
    return { items: (await this.catalogue.analytes()).map(toAnalyteResponse) };
  }

  @Post('analytes')
  @RequirePermission('catalog:manage', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Dar de alta una determinación' })
  @ApiCreatedResponse({ type: AdminAnalyteDto })
  async createAnalyte(
    @Body() dto: CreateAnalyteDto,
    @Req() req: Request,
  ): Promise<AdminAnalyteResponse> {
    const { code, ...analyte } = dto;
    return toAnalyteResponse(
      await this.catalogue.createAnalyte(code, analyte, this.editor(req)),
    );
  }

  @Patch('analytes/:analyteId')
  @RequirePermission('catalog:manage', 'global')
  @ApiOperation({ summary: 'Corregir una determinación (en todos sus exámenes), con sus rangos si cambia la unidad' }) // prettier-ignore
  @ApiOkResponse({ type: AdminAnalyteDto })
  async updateAnalyte(
    @Param('analyteId', ParseUUIDPipe) analyteId: string,
    @Body() dto: UpdateAnalyteDto,
    @Req() req: Request,
  ): Promise<AdminAnalyteResponse> {
    // ORD-141. The ranges travel apart from the fields they are written in.
    const { ranges, ...fields } = dto;
    return toAnalyteResponse(
      await this.catalogue.updateAnalyte(
        analyteId,
        fields,
        this.editor(req),
        ranges,
      ),
    );
  }

  @Put('analytes/:analyteId/ranges')
  @RequirePermission('catalog:manage', 'global')
  @ApiOperation({ summary: 'Fijar los rangos de referencia y críticos de una determinación' }) // prettier-ignore
  @ApiOkResponse({ type: AdminAnalyteDto })
  async setRanges(
    @Param('analyteId', ParseUUIDPipe) analyteId: string,
    @Body() dto: AnalyteRangesDto,
    @Req() req: Request,
  ): Promise<AdminAnalyteResponse> {
    const ranges: ReferenceRange[] = dto.ranges.map((range) => ({ ...range }));
    return toAnalyteResponse(
      await this.catalogue.setRanges(analyteId, ranges, this.editor(req)),
    );
  }

  /**
   * ORD-114. The ranges as they were, so «¿qué umbral regía ese día?» has an
   * answer. Read with `catalog:manage` and not audited: it is configuration,
   * with no patient in it.
   */
  @Get('analytes/:analyteId/ranges/history')
  @RequirePermission('catalog:manage', 'global')
  @ApiOperation({ summary: 'Historial de los rangos de una determinación' })
  @ApiOkResponse({ type: RangeHistoryDto })
  async rangeHistory(
    @Param('analyteId', ParseUUIDPipe) analyteId: string,
  ): Promise<RangeHistoryResponse> {
    const versions = await this.catalogue.rangeHistory(analyteId);
    return {
      items: versions.map((version) => ({
        ...version,
        validFrom: version.validFrom.toISOString(),
        validTo: version.validTo?.toISOString() ?? null,
      })),
    };
  }

  /** ORD-111. Who changes the catalogue, from the session, never the body. */
  private editor(req: Request): CatalogueEditor {
    return {
      userId: this.currentUser.requireUserId(),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

function toRanges(ranges: readonly ReferenceRange[]) {
  return ranges.map((range) => ({ ...range }));
}

function toExamResponse(exam: AdminExamView): AdminExamResponse {
  return {
    id: exam.id,
    code: exam.code,
    name: exam.name,
    category: exam.category,
    form010Section: exam.form010Section,
    specimenType: exam.specimenType,
    patientPreparation: exam.patientPreparation,
    turnaroundHours: exam.turnaroundHours,
    requiresFasting: exam.requiresFasting,
    fastingHours: exam.fastingHours,
    performedExternally: exam.performedExternally,
    externalLabName: exam.externalLabName,
    externalLabCode: exam.externalLabCode,
    mspCode: exam.mspCode,
    active: exam.active,
    analytes: exam.analytes.map((entry) => ({
      position: entry.position,
      isReflex: entry.isReflex,
      analyte: {
        id: entry.analyte.id,
        code: entry.analyte.code,
        name: entry.analyte.name,
        valueType: entry.analyte.valueType,
        unit: entry.analyte.unit,
        decimals: entry.analyte.decimals,
        allowedValues: entry.analyte.allowedValues
          ? [...entry.analyte.allowedValues]
          : null,
        ranges: toRanges(entry.analyte.ranges),
      },
    })),
  };
}

function toAnalyteResponse(analyte: AdminAnalyteView): AdminAnalyteResponse {
  return {
    id: analyte.id,
    code: analyte.code,
    name: analyte.name,
    valueType: analyte.valueType,
    unit: analyte.unit,
    decimals: analyte.decimals,
    allowedValues: analyte.allowedValues ? [...analyte.allowedValues] : null,
    loincCode: analyte.loincCode,
    active: analyte.active,
    ranges: toRanges(analyte.ranges),
    usedBy: analyte.usedBy.map((exam) => ({ ...exam })),
  };
}
