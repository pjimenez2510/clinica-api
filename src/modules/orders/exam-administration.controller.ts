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
  AdminExamListDto,
  AnalyteRangesDto,
  CreateAnalyteDto,
  CreateExamDto,
  ExamStructureDto,
  UpdateAnalyteDto,
  UpdateExamDto,
  type AdminAnalyteListResponse,
  type AdminAnalyteResponse,
  type AdminExamListResponse,
  type AdminExamResponse,
} from './dto/exam-administration.dto';

/**
 * The exam catalogue, administered by the clinic (ORD-103 to ORD-111).
 *
 * `catalog:manage` on every route, reads included: this screen shows retired
 * exams and the service each is charged with, which ordering —`GET /exams`,
 * `catalog:read`— has no business seeing. Global scope: the catalogue is the
 * clinic's, not a site's.
 */
@ApiTags('orders')
@Controller({ path: 'exam-catalogue', version: '1' })
export class ExamAdministrationController {
  constructor(
    private readonly catalogue: ExamAdministrationService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get('exams')
  @RequirePermission('catalog:manage', 'global')
  @ApiOperation({ summary: 'Listar el catálogo de exámenes, desactivados incluidos' }) // prettier-ignore
  @ApiOkResponse({ type: AdminExamListDto })
  async exams(): Promise<AdminExamListResponse> {
    return { items: (await this.catalogue.exams()).map(toExamResponse) };
  }

  @Get('exams/:examId')
  @RequirePermission('catalog:manage', 'global')
  @ApiOperation({ summary: 'Ver la ficha de un examen del catálogo' })
  @ApiOkResponse({ type: AdminExamDto })
  async exam(
    @Param('examId', ParseUUIDPipe) examId: string,
  ): Promise<AdminExamResponse> {
    return toExamResponse(await this.catalogue.exam(examId));
  }

  @Post('exams')
  @RequirePermission('catalog:manage', 'global')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Dar de alta un examen en el catálogo' })
  @ApiCreatedResponse({ type: AdminExamDto })
  async createExam(
    @Body() dto: CreateExamDto,
    @Req() req: Request,
  ): Promise<AdminExamResponse> {
    const { code, ...exam } = dto;
    return toExamResponse(
      await this.catalogue.createExam(code, exam, this.editor(req)),
    );
  }

  @Patch('exams/:examId')
  @RequirePermission('catalog:manage', 'global')
  @ApiOperation({ summary: 'Corregir un examen del catálogo' })
  @ApiOkResponse({ type: AdminExamDto })
  async updateExam(
    @Param('examId', ParseUUIDPipe) examId: string,
    @Body() dto: UpdateExamDto,
    @Req() req: Request,
  ): Promise<AdminExamResponse> {
    return toExamResponse(
      await this.catalogue.updateExam(examId, dto, this.editor(req)),
    );
  }

  @Put('exams/:examId/analytes')
  @RequirePermission('catalog:manage', 'global')
  @ApiOperation({ summary: 'Fijar las determinaciones del examen y su orden' })
  @ApiOkResponse({ type: AdminExamDto })
  async setStructure(
    @Param('examId', ParseUUIDPipe) examId: string,
    @Body() dto: ExamStructureDto,
    @Req() req: Request,
  ): Promise<AdminExamResponse> {
    return toExamResponse(
      await this.catalogue.setStructure(examId, dto.analytes, this.editor(req)),
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
  @ApiOperation({ summary: 'Corregir una determinación (en todos sus exámenes)' }) // prettier-ignore
  @ApiOkResponse({ type: AdminAnalyteDto })
  async updateAnalyte(
    @Param('analyteId', ParseUUIDPipe) analyteId: string,
    @Body() dto: UpdateAnalyteDto,
    @Req() req: Request,
  ): Promise<AdminAnalyteResponse> {
    return toAnalyteResponse(
      await this.catalogue.updateAnalyte(analyteId, dto, this.editor(req)),
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
    performedExternally: exam.performedExternally,
    externalLabName: exam.externalLabName,
    externalLabCode: exam.externalLabCode,
    tariffCode: exam.tariffCode,
    active: exam.active,
    billableService: exam.billableService ? { ...exam.billableService } : null,
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
